import type { ChatMode, ReportReason, ServerMessage } from '@meet-strangers/shared';
import { PeerSession, type PeerState } from './peerSession';
import { SignalingClient, type SignalingStatus } from './signaling';

export type ChatPhase =
  /** Not looking for anyone. */
  | 'idle'
  /** In the matchmaking queue. */
  | 'searching'
  /** Matched; WebRTC is negotiating. */
  | 'connecting'
  /** Media is flowing. */
  | 'connected'
  /** The chat ended; waiting for the user to start the next one. */
  | 'ended';

export type EndReason = 'partner_left' | 'connection_lost' | 'reported';

export interface ChatEntry {
  id: number;
  from: 'me' | 'stranger' | 'system';
  text: string;
}

export interface Notice {
  kind: 'info' | 'error';
  text: string;
}

export interface ChatState {
  signaling: SignalingStatus;
  phase: ChatPhase;
  endReason: EndReason | null;
  matchId: string | null;
  commonInterests: string[];
  remoteStream: MediaStream | null;
  chatReady: boolean;
  messages: ChatEntry[];
  onlineCount: number | null;
  notice: Notice | null;
  /** Unrecoverable condition (e.g. banned). The UI should stop offering to chat. */
  fatal: string | null;
}

export interface ChatPreferences {
  mode: ChatMode;
  interests: string[];
}

const MAX_CHAT_HISTORY = 200;

const initialState: ChatState = {
  signaling: 'connecting',
  phase: 'idle',
  endReason: null,
  matchId: null,
  commonInterests: [],
  remoteStream: null,
  chatReady: false,
  messages: [],
  onlineCount: null,
  notice: null,
  fatal: null,
};

/**
 * Client-side state machine for the whole chat experience. Framework-agnostic:
 * React subscribes through `subscribe`/`getSnapshot` (useSyncExternalStore).
 *
 * Every server event that refers to a match carries its `matchId`; events
 * for anything but the current match are ignored, which makes rapid "next"
 * clicks race-free.
 */
export class ChatController {
  private state: ChatState = initialState;
  private readonly listeners = new Set<() => void>();
  private readonly signaling: SignalingClient;
  private peer: PeerSession | null = null;
  private prefs: ChatPreferences | null = null;
  private localStream: MediaStream | null = null;
  /** True between sending `join` and receiving `queued`, to retry rate-limited joins. */
  private joinPending = false;
  private joinRetryTimer: number | null = null;
  private nextEntryId = 1;

  constructor(signalingUrl: string) {
    this.signaling = new SignalingClient(signalingUrl, {
      onMessage: (message) => this.handleServerMessage(message),
      onStatus: (status) => this.handleSignalingStatus(status),
    });
  }

  // --- React integration ----------------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): ChatState => this.state;

  // --- Commands -------------------------------------------------------------

  connect(): void {
    this.signaling.connect();
  }

  /** Begin searching with the given preferences and camera/mic stream. */
  start(prefs: ChatPreferences, localStream: MediaStream): void {
    if (this.state.fatal) return;
    this.prefs = prefs;
    this.localStream = localStream;
    this.next();
  }

  /** End the current chat (if any) and look for a new stranger. */
  next(): void {
    if (!this.prefs || !this.localStream || this.state.fatal) return;
    this.closePeer();
    this.update({
      phase: 'searching',
      endReason: null,
      matchId: null,
      commonInterests: [],
      remoteStream: null,
      chatReady: false,
      notice: null,
    });
    this.sendJoin();
  }

  /** Stop chatting entirely and leave the queue. */
  stop(): void {
    this.clearJoinRetry();
    this.closePeer();
    this.prefs = null;
    this.localStream = null;
    this.signaling.send({ type: 'leave' });
    this.update({
      phase: 'idle',
      endReason: null,
      matchId: null,
      commonInterests: [],
      remoteStream: null,
      chatReady: false,
      messages: [],
      notice: null,
    });
  }

  sendChat(text: string): boolean {
    if (!this.peer || this.state.phase !== 'connected') return false;
    if (!this.peer.sendChat(text)) return false;
    this.appendMessage('me', text.trim());
    return true;
  }

  /**
   * Report the stranger from chat `matchId`. Reporting a chat that already
   * ended is allowed because abusers often disconnect immediately.
   *
   * Callers must capture `matchId` when the user *starts* reporting (opens
   * the report dialog), not when they submit: by then the controller may
   * have moved on to a different stranger, who must not be reported instead.
   * The chat is only skipped if the reported stranger is still on screen.
   *
   * Returns false when the report could not be sent.
   */
  report(reason: ReportReason, matchId: string): boolean {
    if (!this.signaling.send({ type: 'report', matchId, reason })) {
      // The server forgets a connection's chats when it drops, so this
      // report cannot be delivered later either; say so honestly.
      this.update({
        notice: {
          kind: 'error',
          text: "Your report couldn't be sent because the connection to the server was lost.",
        },
      });
      return false;
    }
    const skipped = matchId === this.state.matchId;
    if (skipped) this.next();
    this.update({
      notice: {
        kind: 'info',
        text: skipped
          ? 'Thanks. Your report was sent and you were moved on.'
          : 'Thanks. Your report was sent.',
      },
    });
    return true;
  }

  dismissNotice(): void {
    this.update({ notice: null });
  }

  /** Tear down connections. `connect()` may be called again afterwards. */
  dispose(): void {
    this.clearJoinRetry();
    this.closePeer();
    this.signaling.stop();
  }

  // --- Server events --------------------------------------------------------

  private handleSignalingStatus(status: SignalingStatus): void {
    if (status === 'reconnecting' && this.state.signaling === 'open') {
      // The server ends our chat when the socket drops, so end it here too.
      if (this.peer) {
        this.closePeer();
        this.update({
          phase: 'ended',
          endReason: 'connection_lost',
          remoteStream: null,
          chatReady: false,
        });
        this.appendMessage('system', 'Connection to the server was lost.');
      }
    }
    this.update({ signaling: status });
  }

  private handleServerMessage(message: ServerMessage): void {
    switch (message.type) {
      case 'welcome':
        this.update({ onlineCount: message.onlineCount });
        // Resume searching after a reconnect.
        if (this.state.phase === 'searching') this.sendJoin();
        return;

      case 'online':
        this.update({ onlineCount: message.count });
        return;

      case 'queued':
        // The join succeeded. A retry scheduled for an unrelated rate-limit
        // error (e.g. a report) must not re-join and lose our queue position.
        this.joinPending = false;
        this.clearJoinRetry();
        return;

      case 'idle':
        return;

      case 'matched':
        this.handleMatched(message);
        return;

      case 'signal':
        if (message.matchId === this.state.matchId) void this.peer?.handleSignal(message.payload);
        return;

      case 'partner_left':
        if (message.matchId !== this.state.matchId) return;
        this.closePeer();
        this.update({
          phase: 'ended',
          endReason: 'partner_left',
          remoteStream: null,
          chatReady: false,
        });
        this.appendMessage('system', 'Stranger has disconnected.');
        return;

      case 'error':
        this.handleServerError(message);
        return;
    }
  }

  private handleMatched(message: Extract<ServerMessage, { type: 'matched' }>): void {
    // A match can arrive after the user pressed "stop"; the server already
    // processed our `leave` by then, but stay defensive.
    if (this.state.phase !== 'searching' || !this.localStream) {
      this.signaling.send({ type: 'leave' });
      return;
    }

    this.closePeer();
    const matchId = message.matchId;
    this.nextEntryId = 1;
    this.update({
      phase: 'connecting',
      matchId,
      commonInterests: message.commonInterests,
      messages: [],
      chatReady: false,
      remoteStream: null,
    });
    this.appendMessage('system', "You're now chatting with a random stranger. Say hi!");
    if (message.commonInterests.length > 0) {
      this.appendMessage('system', `You both like: ${message.commonInterests.join(', ')}.`);
    }

    const peer = new PeerSession({
      role: message.role,
      iceServers: message.iceServers,
      iceTransportPolicy: message.iceTransportPolicy,
      localStream: this.localStream,
      sendSignal: (payload) => this.signaling.send({ type: 'signal', matchId, payload }),
      onRemoteStream: (stream) => {
        if (this.peer === peer) this.update({ remoteStream: stream });
      },
      onStateChange: (state) => {
        if (this.peer === peer) this.handlePeerState(state);
      },
      onChatOpen: () => {
        if (this.peer === peer) this.update({ chatReady: true });
      },
      onChatMessage: (text) => {
        if (this.peer === peer) this.appendMessage('stranger', text);
      },
    });
    this.peer = peer;
  }

  private handlePeerState(state: PeerState): void {
    if (state === 'connected') {
      this.update({ phase: 'connected' });
      return;
    }
    if (state === 'failed') {
      // Direct connection impossible (e.g. strict NAT without TURN) or the
      // stranger vanished: move on automatically instead of hanging.
      this.appendMessage('system', 'Could not connect to this stranger. Finding someone new…');
      this.next();
      this.update({
        notice: { kind: 'info', text: 'Connection failed, so we found you someone new.' },
      });
    }
  }

  private handleServerError(message: Extract<ServerMessage, { type: 'error' }>): void {
    switch (message.code) {
      case 'rate_limited':
        this.update({ notice: { kind: 'info', text: message.message } });
        if (this.joinPending) this.scheduleJoinRetry(message.retryAfterMs ?? 2_000);
        return;
      case 'banned':
        this.closePeer();
        this.signaling.stop();
        this.update({
          phase: 'idle',
          remoteStream: null,
          fatal: message.message,
        });
        return;
      case 'server_shutdown':
        this.update({ notice: { kind: 'info', text: 'The server is restarting. Reconnecting…' } });
        return;
      case 'not_in_chat':
        this.update({ notice: { kind: 'info', text: message.message } });
        return;
      case 'invalid_message':
        // Indicates a client/server version mismatch; nothing the user can do.
        // eslint-disable-next-line no-console -- developer diagnostics only
        console.warn('Server rejected a message:', message.message);
        return;
    }
  }

  // --- Helpers --------------------------------------------------------------

  private sendJoin(): void {
    if (!this.prefs) return;
    this.clearJoinRetry();
    // If the socket is down, the `welcome` after reconnecting re-sends this.
    this.joinPending = this.signaling.send({
      type: 'join',
      mode: this.prefs.mode,
      interests: this.prefs.interests,
      acceptedTerms: true,
    });
  }

  private scheduleJoinRetry(delayMs: number): void {
    this.clearJoinRetry();
    this.joinRetryTimer = window.setTimeout(() => {
      this.joinRetryTimer = null;
      if (this.state.phase === 'searching') this.sendJoin();
    }, delayMs + 50);
  }

  private clearJoinRetry(): void {
    if (this.joinRetryTimer !== null) window.clearTimeout(this.joinRetryTimer);
    this.joinRetryTimer = null;
  }

  private closePeer(): void {
    this.peer?.close();
    this.peer = null;
  }

  private appendMessage(from: ChatEntry['from'], text: string): void {
    const messages = [...this.state.messages, { id: this.nextEntryId++, from, text }];
    this.update({ messages: messages.slice(-MAX_CHAT_HISTORY) });
  }

  private update(patch: Partial<ChatState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}
