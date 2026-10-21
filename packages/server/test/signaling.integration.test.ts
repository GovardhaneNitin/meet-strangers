import { randomBytes } from 'node:crypto';
import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { pino } from 'pino';
import type { ServerMessage } from '@meet-strangers/shared';
import { loadConfig } from '../src/config.js';
import { createServer, type MeetStrangersServer } from '../src/createServer.js';

const ORIGIN = 'http://meet.test';

let server: MeetStrangersServer;
let url: string;
const sockets: WebSocket[] = [];

async function start(env: Record<string, string> = {}) {
  const config = loadConfig({
    NODE_ENV: 'test',
    PORT: '0',
    HOST: '127.0.0.1',
    ALLOWED_ORIGINS: ORIGIN,
    SHUTDOWN_GRACE_MS: '200',
    ...env,
  });
  server = createServer(config, pino({ level: 'silent' }));
  const { port } = await server.listen();
  url = `ws://127.0.0.1:${port}/ws`;
}

/** Test client that records every message so assertions never race delivery. */
class Client {
  readonly messages: ServerMessage[] = [];
  private waiters: Array<() => void> = [];
  closeCode: number | null = null;

  constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => {
      this.messages.push(JSON.parse(String(data)) as ServerMessage);
      this.notify();
    });
    ws.on('close', (code) => {
      this.closeCode = code;
      this.notify();
    });
  }

  static async connect(origin = ORIGIN): Promise<Client> {
    const ws = new WebSocket(url, { origin });
    sockets.push(ws);
    const client = new Client(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    await client.next('welcome');
    return client;
  }

  send(message: unknown) {
    this.ws.send(typeof message === 'string' ? message : JSON.stringify(message));
  }

  join(mode: 'video' | 'audio' = 'video', interests: string[] = []) {
    this.send({ type: 'join', mode, interests, acceptedTerms: true });
  }

  /** Resolve with the first not-yet-consumed message of the given type. */
  async next<T extends ServerMessage['type']>(
    type: T,
    timeoutMs = 2000,
  ): Promise<Extract<ServerMessage, { type: T }>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = this.messages.findIndex((m) => m.type === type);
      if (index >= 0) {
        return this.messages.splice(index, 1)[0] as Extract<ServerMessage, { type: T }>;
      }
      if (Date.now() > deadline) throw new Error(`Timed out waiting for "${type}"`);
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 25);
      });
    }
  }

  async closed(timeoutMs = 2000): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    while (this.closeCode === null) {
      if (Date.now() > deadline) throw new Error('Timed out waiting for close');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return this.closeCode;
  }

  private notify() {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }
}

async function pair() {
  const a = await Client.connect();
  const b = await Client.connect();
  a.join();
  await a.next('queued');
  b.join();
  const matchA = await a.next('matched');
  const matchB = await b.next('matched');
  return { a, b, matchA, matchB };
}

function rawUpgradeStatus(headers: Record<string, string>, path = '/ws'): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url.replace('/ws', path), { headers });
    ws.on('unexpected-response', (_req, res) => {
      resolve(res.statusCode ?? 0);
      ws.terminate();
    });
    ws.on('open', () => {
      resolve(101);
      ws.close();
    });
    ws.on('error', (error) => {
      if (!String(error).includes('Unexpected server response')) reject(error);
    });
  });
}

/**
 * Minimal hand-rolled WebSocket client that never answers the server's close
 * frame, like a modified client or a peer whose network just died.
 */
async function connectUnresponsiveClient(): Promise<{
  send: (text: string) => void;
  destroyed: Promise<number>;
  socket: net.Socket;
}> {
  const { port, hostname } = new URL(url);
  const socket = net.connect(Number(port), hostname);
  await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
  const startedAt = Date.now();
  const destroyed = new Promise<number>((resolve) =>
    socket.once('close', () => resolve(Date.now() - startedAt)),
  );
  socket.on('error', () => undefined);
  socket.write(
    `GET /ws HTTP/1.1\r\nHost: ${hostname}:${port}\r\nOrigin: ${ORIGIN}\r\n` +
      'Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n' +
      `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n\r\n`,
  );
  await new Promise<void>((resolve) => socket.once('data', () => resolve()));

  const send = (text: string) => {
    const payload = Buffer.from(text);
    if (payload.length > 125) throw new Error('test frames must be short');
    const mask = randomBytes(4);
    const frame = Buffer.alloc(6 + payload.length);
    frame[0] = 0x81; // FIN + text
    frame[1] = 0x80 | payload.length; // masked
    mask.copy(frame, 2);
    for (let i = 0; i < payload.length; i++) frame[6 + i] = payload[i]! ^ mask[i % 4]!;
    socket.write(frame);
  };
  return { send, destroyed, socket };
}

beforeEach(async () => {
  await start();
});

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  await server.close();
});

describe('signaling server', () => {
  it('rejects cross-site WebSocket handshakes and unknown paths', async () => {
    expect(await rawUpgradeStatus({ Origin: 'https://evil.example' })).toBe(403);
    expect(await rawUpgradeStatus({})).toBe(403);
    expect(await rawUpgradeStatus({ Origin: ORIGIN }, '/other')).toBe(404);
    expect(await rawUpgradeStatus({ Origin: ORIGIN })).toBe(101);
  });

  it('matches two users with complementary roles and the same match id', async () => {
    const { matchA, matchB } = await pair();
    expect(matchA.matchId).toBe(matchB.matchId);
    expect(new Set([matchA.role, matchB.role])).toEqual(new Set(['offerer', 'answerer']));
    expect(matchA.iceServers.length).toBeGreaterThan(0);
  });

  it('relays signals only within the current match', async () => {
    const { a, b, matchA } = await pair();
    const payload = { kind: 'offer', sdp: 'v=0\r\n' };
    a.send({ type: 'signal', matchId: matchA.matchId, payload });
    expect(await b.next('signal')).toEqual({ type: 'signal', matchId: matchA.matchId, payload });

    // Third user cannot inject signals into a match they are not part of.
    const c = await Client.connect();
    c.send({ type: 'signal', matchId: matchA.matchId, payload: { kind: 'answer', sdp: 'evil' } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(b.messages.filter((m) => m.type === 'signal')).toHaveLength(0);
  });

  it('drops stale signals after "next" instead of leaking them to the new partner', async () => {
    const { a, b, matchA } = await pair();
    a.join(); // next
    expect(await b.next('partner_left')).toEqual({ type: 'partner_left', matchId: matchA.matchId });

    const c = await Client.connect();
    c.join();
    const matchC = await c.next('matched');
    expect(matchC.matchId).not.toBe(matchA.matchId);

    // b sends a late candidate for the old match.
    b.send({
      type: 'signal',
      matchId: matchA.matchId,
      payload: { kind: 'candidate', candidate: { candidate: '', sdpMid: '0', sdpMLineIndex: 0 } },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(a.messages.filter((m) => m.type === 'signal')).toHaveLength(0);
    expect(c.messages.filter((m) => m.type === 'signal')).toHaveLength(0);
  });

  it('notifies the partner when a user disconnects', async () => {
    const { a, b, matchA } = await pair();
    a.ws.terminate();
    expect(await b.next('partner_left')).toEqual({ type: 'partner_left', matchId: matchA.matchId });
  });

  it('rejects joins without accepted terms and disconnects persistent garbage senders', async () => {
    const a = await Client.connect();
    a.send({ type: 'join', mode: 'video', interests: [] });
    expect(await a.next('error')).toMatchObject({ code: 'invalid_message' });
    for (let i = 0; i < 5; i++) a.send('{not json');
    expect(await a.closed()).toBe(1008);
  });

  it('removes a kicked client from matchmaking at once, even if it ignores the close frame', async () => {
    // Regression: sessions stayed queued/matched until the close handshake
    // finished (up to 30 s), so honest users were matched with kicked or
    // banned clients and left waiting on a call that could never connect.
    const honest = await Client.connect();
    honest.join();
    await honest.next('queued');

    const rogue = await connectUnresponsiveClient();
    rogue.send(JSON.stringify({ type: 'join', mode: 'video', interests: [], acceptedTerms: true }));
    const match = await honest.next('matched');

    for (let i = 0; i < 5; i++) rogue.send('garbage');
    // The partner is released immediately, not when the socket finally closes.
    expect(await honest.next('partner_left', 1000)).toEqual({
      type: 'partner_left',
      matchId: match.matchId,
    });

    // A new honest user must not be matched with the kicked client.
    const other = await Client.connect();
    other.join();
    await other.next('queued');
    honest.join();
    const rematch = await honest.next('matched');
    expect(rematch.matchId).not.toBe(match.matchId);
    expect((await other.next('matched')).matchId).toBe(rematch.matchId);

    // The socket is destroyed shortly after, well before ws's 30 s default.
    expect(await rogue.destroyed).toBeLessThan(5_000);
  });

  it('rejects binary frames and oversized messages', async () => {
    const a = await Client.connect();
    a.ws.send(Buffer.from([1, 2, 3]));
    expect(await a.next('error')).toMatchObject({ code: 'invalid_message' });

    a.send('x'.repeat(70 * 1024));
    expect(await a.closed()).toBe(1009);
  });

  it('rate limits "next" spam', async () => {
    const a = await Client.connect();
    for (let i = 0; i < 8; i++) a.join();
    const error = await a.next('error');
    expect(error).toMatchObject({ code: 'rate_limited' });
    expect(error.retryAfterMs).toBeGreaterThan(0);
  });

  it('allows reporting the previous partner after they skipped, once per chat', async () => {
    const { a, b, matchB } = await pair();
    a.join(); // abuser skips immediately
    await b.next('partner_left');

    b.send({ type: 'report', matchId: matchB.matchId, reason: 'nudity' });
    b.send({ type: 'report', matchId: matchB.matchId, reason: 'nudity' });
    b.send({ type: 'report', matchId: '00000000-0000-4000-8000-000000000000', reason: 'spam' });
    expect(await b.next('error')).toMatchObject({ code: 'not_in_chat' });
    expect(b.messages.filter((m) => m.type === 'error')).toHaveLength(0);
  });

  it('limits concurrent connections per IP', async () => {
    await server.close();
    await start({ MAX_CONNECTIONS_PER_IP: '2' });
    await Client.connect();
    await Client.connect();
    expect(await rawUpgradeStatus({ Origin: ORIGIN })).toBe(429);
  });

  it('bans a user reported by enough distinct people and disconnects them', async () => {
    // All test clients share 127.0.0.1, so trust one proxy hop and give each
    // client a distinct forwarded address.
    await server.close();
    await start({ TRUST_PROXY_HOPS: '1', REPORT_BAN_THRESHOLD: '2' });

    const connectAs = async (ip: string) => {
      const ws = new WebSocket(url, { origin: ORIGIN, headers: { 'X-Forwarded-For': ip } });
      sockets.push(ws);
      const client = new Client(ws);
      await client.next('welcome');
      return client;
    };

    const abuser = await connectAs('192.0.2.66');
    for (const reporterIp of ['198.51.100.1', '198.51.100.2']) {
      const reporter = await connectAs(reporterIp);
      abuser.join(); // also ends the previous chat, if any
      reporter.join();
      const match = await reporter.next('matched');
      await abuser.next('matched');
      reporter.send({ type: 'report', matchId: match.matchId, reason: 'harassment' });
      reporter.send({ type: 'leave' });
      await reporter.next('idle');
    }

    expect(await abuser.closed()).toBe(1008);
    const status = await rawUpgradeStatus({ Origin: ORIGIN, 'X-Forwarded-For': '192.0.2.66' });
    expect(status).toBe(403);
  });

  it('tells clients when the server shuts down', async () => {
    const a = await Client.connect();
    const closing = server.close();
    expect(await a.next('error')).toMatchObject({ code: 'server_shutdown' });
    expect(await a.closed()).toBe(1001);
    await closing;
    await start(); // afterEach closes again
  });
});
