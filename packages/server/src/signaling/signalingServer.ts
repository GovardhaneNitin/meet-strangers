import { randomUUID } from 'node:crypto';
import { STATUS_CODES, type IncomingMessage, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Logger } from 'pino';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import {
  LIMITS,
  PROTOCOL_VERSION,
  SIGNALING_PATH,
  clientMessageSchema,
  normalizeInterests,
  parseMessage,
  type ClientMessage,
  type ErrorCode,
  type ServerMessage,
} from '@meet-strangers/shared';
import type { Config } from '../config.js';
import type { MatchEvent, Matchmaker } from '../matchmaking/matchmaker.js';
import { resolveClientIp } from '../security/clientIp.js';
import type { IpGuard } from '../security/ipGuard.js';
import { TokenBucket } from '../security/tokenBucket.js';
import { buildIceServers } from './iceServers.js';

/** WebSocket close codes (RFC 6455 §7.4.1). */
const CloseCode = {
  GOING_AWAY: 1001,
  POLICY_VIOLATION: 1008,
  INTERNAL_ERROR: 1011,
} as const;

/** Disconnect clients that keep sending garbage instead of erroring forever. */
const MAX_INVALID_MESSAGES = 5;
const MAX_RATE_LIMIT_STRIKES = 50;
/** A client that does not read its socket must not make us buffer unbounded data. */
const MAX_BUFFERED_BYTES = 1024 * 1024;
const RECENT_PARTNERS_TO_REMEMBER = 3;
const MATCH_TICK_MS = 1_000;
const ONLINE_BROADCAST_MS = 5_000;
const PRUNE_INTERVAL_MS = 60_000;

interface RecentPartner {
  matchId: string;
  partnerKey: string;
  reported: boolean;
}

interface Session {
  id: string;
  /** HMAC of the client's IP; never the IP itself. */
  clientKey: string;
  ws: WebSocket;
  isAlive: boolean;
  /** General budget: bursts of ICE candidates are fine, floods are not. */
  messageBucket: TokenBucket;
  /** "Next" spam would churn other users' chats, so joins get a tighter budget. */
  joinBucket: TokenBucket;
  reportBucket: TokenBucket;
  invalidMessages: number;
  rateLimitStrikes: number;
  /**
   * Partners of the current and last few chats. Abusers often flash
   * something and skip immediately; the victim must still be able to report
   * them after the chat ended.
   */
  recentPartners: RecentPartner[];
}

export interface SignalingServerDeps {
  config: Config;
  logger: Logger;
  ipGuard: IpGuard;
  matchmaker: Matchmaker;
}

export class SignalingServer {
  private readonly wss: WebSocketServer;
  private readonly sessions = new Map<string, Session>();
  private readonly timers: NodeJS.Timeout[] = [];
  private accepting = true;
  private lastBroadcastCount = -1;

  constructor(private readonly deps: SignalingServerDeps) {
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: LIMITS.MAX_WS_PAYLOAD_BYTES,
      // Compression adds CPU/memory per connection and enables
      // compression-oracle attacks; signaling messages are small anyway.
      perMessageDeflate: false,
      clientTracking: false,
    });
  }

  get connectionCount(): number {
    return this.sessions.size;
  }

  get isAccepting(): boolean {
    return this.accepting;
  }

  attach(server: Server): void {
    server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));

    const { HEARTBEAT_INTERVAL_MS } = this.deps.config;
    this.timers.push(
      setInterval(() => this.heartbeat(), HEARTBEAT_INTERVAL_MS),
      setInterval(() => this.dispatch(this.deps.matchmaker.tick()), MATCH_TICK_MS),
      setInterval(() => this.broadcastOnlineCount(), ONLINE_BROADCAST_MS),
      setInterval(() => this.deps.ipGuard.prune(), PRUNE_INTERVAL_MS),
    );
    for (const timer of this.timers) timer.unref();
  }

  /**
   * Stop accepting connections and close existing ones politely. Clients
   * receive a `server_shutdown` error first so the UI can explain what
   * happened and reconnect to another instance.
   */
  async shutdown(graceMs: number): Promise<void> {
    this.accepting = false;
    for (const timer of this.timers) clearInterval(timer);

    for (const session of this.sessions.values()) {
      this.sendError(session, 'server_shutdown', 'The server is restarting. Please reconnect.');
      session.ws.close(CloseCode.GOING_AWAY, 'Server shutting down');
    }

    const deadline = Date.now() + graceMs;
    while (this.sessions.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    for (const session of this.sessions.values()) session.ws.terminate();
    this.wss.close();
  }

  // -------------------------------------------------------------------------
  // Connection admission
  // -------------------------------------------------------------------------

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const { config, ipGuard, logger } = this.deps;
    socket.on('error', () => socket.destroy());

    const pathname = safePathname(req.url);
    if (pathname !== SIGNALING_PATH) return rejectUpgrade(socket, 404);
    if (!this.accepting) return rejectUpgrade(socket, 503);

    // Browsers always send Origin on WebSocket handshakes and page scripts
    // cannot forge it. Checking it prevents cross-site WebSocket hijacking:
    // a malicious site opening a socket to us from a visitor's browser.
    if (!isOriginAllowed(req.headers.origin, req.headers.host, config.ALLOWED_ORIGINS)) {
      logger.warn({ event: 'upgrade_rejected', reason: 'origin' }, 'WebSocket origin rejected');
      return rejectUpgrade(socket, 403);
    }

    if (this.sessions.size >= config.MAX_TOTAL_CONNECTIONS) {
      logger.warn({ event: 'upgrade_rejected', reason: 'capacity' }, 'Server at capacity');
      return rejectUpgrade(socket, 503);
    }

    const ip = resolveClientIp(req, config.TRUST_PROXY_HOPS);
    const admission = ipGuard.admit(ip);
    if (!admission.ok) {
      logger.info(
        { event: 'upgrade_rejected', reason: admission.reason, client: ipGuard.keyFor(ip) },
        'Connection refused by IP guard',
      );
      return rejectUpgrade(
        socket,
        admission.reason === 'banned' ? 403 : 429,
        admission.retryAfterMs,
      );
    }

    // The IP slot is reserved now; release it if the handshake never completes.
    let upgraded = false;
    socket.once('close', () => {
      if (!upgraded) ipGuard.release(admission.clientKey);
    });

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      upgraded = true;
      this.onConnection(ws, admission.clientKey);
    });
  }

  private onConnection(ws: WebSocket, clientKey: string): void {
    const session: Session = {
      id: randomUUID(),
      clientKey,
      ws,
      isAlive: true,
      messageBucket: new TokenBucket(60, 20),
      joinBucket: new TokenBucket(5, 0.5),
      reportBucket: new TokenBucket(3, 1 / 20),
      invalidMessages: 0,
      rateLimitStrikes: 0,
      recentPartners: [],
    };
    this.sessions.set(session.id, session);
    this.deps.logger.debug({ event: 'connected', session: session.id, client: clientKey });

    ws.on('pong', () => {
      session.isAlive = true;
    });
    ws.on('message', (data, isBinary) => this.onMessage(session, data, isBinary));
    // Errors (e.g. oversized frames) are followed by 'close'; the listener
    // only prevents an unhandled 'error' event from crashing the process.
    ws.on('error', (error) => {
      this.deps.logger.debug({ event: 'socket_error', session: session.id, err: error.message });
    });
    ws.on('close', () => this.onClose(session));

    this.send(session, {
      type: 'welcome',
      protocolVersion: PROTOCOL_VERSION,
      onlineCount: this.sessions.size,
    });
  }

  private onClose(session: Session): void {
    if (!this.sessions.delete(session.id)) return;
    this.deps.ipGuard.release(session.clientKey);
    this.dispatch(this.deps.matchmaker.remove(session.id));
    this.deps.logger.debug({ event: 'disconnected', session: session.id });
  }

  // -------------------------------------------------------------------------
  // Message handling
  // -------------------------------------------------------------------------

  private onMessage(session: Session, data: RawData, isBinary: boolean): void {
    if (!this.sessions.has(session.id)) return;

    if (!session.messageBucket.take()) {
      session.rateLimitStrikes += 1;
      if (session.rateLimitStrikes > MAX_RATE_LIMIT_STRIKES) {
        this.closeForViolation(session, 'Message flood');
      } else {
        this.sendError(
          session,
          'rate_limited',
          'Too many messages.',
          session.messageBucket.msUntilAvailable(),
        );
      }
      return;
    }

    const message = isBinary ? null : parseMessage(clientMessageSchema, rawDataToString(data));
    if (!message) {
      session.invalidMessages += 1;
      if (session.invalidMessages >= MAX_INVALID_MESSAGES) {
        this.closeForViolation(session, 'Too many invalid messages');
      } else {
        this.sendError(session, 'invalid_message', 'Malformed or unsupported message.');
      }
      return;
    }

    try {
      this.handleMessage(session, message);
    } catch (error) {
      this.deps.logger.error(
        { event: 'handler_error', session: session.id, err: error },
        'Message handler failed',
      );
      session.ws.close(CloseCode.INTERNAL_ERROR, 'Internal error');
    }
  }

  private handleMessage(session: Session, message: ClientMessage): void {
    const { matchmaker } = this.deps;

    switch (message.type) {
      case 'join': {
        if (this.deps.ipGuard.isBanned(session.clientKey)) {
          this.closeBanned(session);
          return;
        }
        if (!session.joinBucket.take()) {
          this.sendError(
            session,
            'rate_limited',
            'You are skipping too fast. Please wait a moment.',
            session.joinBucket.msUntilAvailable(),
          );
          return;
        }
        const interests = normalizeInterests(message.interests);
        this.dispatch(matchmaker.join(session.id, { mode: message.mode, interests }));
        return;
      }

      case 'leave':
        this.dispatch(matchmaker.leave(session.id));
        return;

      case 'signal': {
        const partnerId = matchmaker.partnerOf(session.id, message.matchId);
        // A missing partner is normal (a late candidate after "next"):
        // drop silently rather than leak it into a different chat.
        if (partnerId === null) return;
        const partner = this.sessions.get(partnerId);
        if (partner) {
          this.send(partner, {
            type: 'signal',
            matchId: message.matchId,
            payload: message.payload,
          });
        }
        return;
      }

      case 'report':
        this.handleReport(session, message.matchId, message.reason);
        return;
    }
  }

  private handleReport(session: Session, matchId: string, reason: string): void {
    const { ipGuard, logger } = this.deps;
    const entry = session.recentPartners.find((partner) => partner.matchId === matchId);
    if (!entry) {
      this.sendError(session, 'not_in_chat', 'That chat can no longer be reported.');
      return;
    }
    // Duplicate reports for the same chat are acknowledged but not counted.
    if (entry.reported) return;
    if (!session.reportBucket.take()) {
      this.sendError(
        session,
        'rate_limited',
        'Too many reports.',
        session.reportBucket.msUntilAvailable(),
      );
      return;
    }
    entry.reported = true;

    const banned = ipGuard.recordReport(entry.partnerKey, session.clientKey);
    logger.info(
      { event: 'report', reason, reporter: session.clientKey, reported: entry.partnerKey, banned },
      'User reported',
    );
    if (!banned) return;

    for (const other of this.sessions.values()) {
      if (other.clientKey === entry.partnerKey) this.closeBanned(other);
    }
  }

  // -------------------------------------------------------------------------
  // Outbound
  // -------------------------------------------------------------------------

  /** Translate matchmaker events into messages. */
  private dispatch(events: MatchEvent[]): void {
    for (const event of events) {
      switch (event.type) {
        case 'queued':
          this.sendTo(event.sessionId, { type: 'queued', mode: event.mode });
          break;

        case 'idle':
          this.sendTo(event.sessionId, { type: 'idle' });
          break;

        case 'partner_left':
          this.sendTo(event.sessionId, { type: 'partner_left', matchId: event.matchId });
          break;

        case 'matched': {
          const offerer = this.sessions.get(event.offerer);
          const answerer = this.sessions.get(event.answerer);
          if (!offerer || !answerer) {
            // Cannot happen with a consistent matchmaker; recover anyway.
            this.deps.logger.error({ event: 'match_inconsistent' }, 'Matched a missing session');
            if (offerer) this.dispatch(this.deps.matchmaker.leave(offerer.id));
            if (answerer) this.dispatch(this.deps.matchmaker.leave(answerer.id));
            break;
          }
          rememberPartner(offerer, event.matchId, answerer.clientKey);
          rememberPartner(answerer, event.matchId, offerer.clientKey);

          const iceServers = buildIceServers(this.deps.config);
          const common = {
            type: 'matched',
            matchId: event.matchId,
            mode: event.mode,
            commonInterests: event.commonInterests,
            iceServers,
            iceTransportPolicy: this.deps.config.ICE_TRANSPORT_POLICY,
          } as const;
          this.send(offerer, { ...common, role: 'offerer' });
          this.send(answerer, { ...common, role: 'answerer' });
          break;
        }
      }
    }
  }

  private sendTo(sessionId: string, message: ServerMessage): void {
    const session = this.sessions.get(sessionId);
    if (session) this.send(session, message);
  }

  private send(session: Session, message: ServerMessage): void {
    const { ws } = session;
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      this.deps.logger.warn(
        { event: 'slow_consumer', session: session.id },
        'Terminating slow client',
      );
      ws.terminate();
      return;
    }
    ws.send(JSON.stringify(message));
  }

  private sendError(
    session: Session,
    code: ErrorCode,
    message: string,
    retryAfterMs?: number,
  ): void {
    this.send(session, {
      type: 'error',
      code,
      message,
      ...(retryAfterMs !== undefined ? { retryAfterMs: Math.max(0, Math.ceil(retryAfterMs)) } : {}),
    });
  }

  private closeForViolation(session: Session, reason: string): void {
    this.deps.logger.info({
      event: 'policy_violation',
      session: session.id,
      client: session.clientKey,
      reason,
    });
    session.ws.close(CloseCode.POLICY_VIOLATION, reason);
  }

  private closeBanned(session: Session): void {
    this.sendError(
      session,
      'banned',
      'You have been temporarily suspended after multiple reports.',
    );
    session.ws.close(CloseCode.POLICY_VIOLATION, 'Banned');
  }

  // -------------------------------------------------------------------------
  // Periodic tasks
  // -------------------------------------------------------------------------

  /**
   * Detect dead peers (closed laptop lid, lost network): TCP can take many
   * minutes to notice, during which the partner would stare at a frozen
   * call and the user would occupy a queue slot.
   */
  private heartbeat(): void {
    for (const session of this.sessions.values()) {
      if (!session.isAlive) {
        session.ws.terminate();
        continue;
      }
      session.isAlive = false;
      session.ws.ping();
    }
  }

  private broadcastOnlineCount(): void {
    const count = this.sessions.size;
    if (count === this.lastBroadcastCount) return;
    this.lastBroadcastCount = count;
    const payload: ServerMessage = { type: 'online', count };
    for (const session of this.sessions.values()) this.send(session, payload);
  }
}

function rememberPartner(session: Session, matchId: string, partnerKey: string): void {
  session.recentPartners.unshift({ matchId, partnerKey, reported: false });
  session.recentPartners.length = Math.min(
    session.recentPartners.length,
    RECENT_PARTNERS_TO_REMEMBER,
  );
}

export function isOriginAllowed(
  origin: string | undefined,
  host: string | undefined,
  allowedOrigins: readonly string[],
): boolean {
  if (!origin || !URL.canParse(origin)) return false;
  const parsed = new URL(origin);
  if (allowedOrigins.length > 0) return allowedOrigins.includes(parsed.origin);
  // Same-origin fallback: the page and the socket are served by this host.
  return host !== undefined && parsed.host === host.toLowerCase();
}

function safePathname(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url, 'http://localhost').pathname;
  } catch {
    return null;
  }
}

function rejectUpgrade(socket: Duplex, status: number, retryAfterMs?: number): void {
  if (socket.writable) {
    const retryAfter =
      retryAfterMs !== undefined
        ? `Retry-After: ${Math.max(1, Math.ceil(retryAfterMs / 1000))}\r\n`
        : '';
    socket.write(
      `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ''}\r\n` +
        'Connection: close\r\n' +
        'Content-Length: 0\r\n' +
        retryAfter +
        '\r\n',
    );
  }
  socket.destroy();
}

function rawDataToString(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}
