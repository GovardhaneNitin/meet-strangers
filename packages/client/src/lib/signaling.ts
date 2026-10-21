import {
  SIGNALING_PATH,
  parseMessage,
  serverMessageSchema,
  type ClientMessageInput,
  type ServerMessage,
} from '@meet-strangers/shared';

export type SignalingStatus = 'connecting' | 'open' | 'reconnecting' | 'stopped';

export interface SignalingHandlers {
  onMessage: (message: ServerMessage) => void;
  onStatus: (status: SignalingStatus) => void;
}

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

export function defaultSignalingUrl(): string {
  const configured = import.meta.env.VITE_SIGNALING_URL;
  if (configured) return configured;
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${window.location.host}${SIGNALING_PATH}`;
}

/**
 * WebSocket wrapper with validated messages and automatic reconnection.
 *
 * Reconnects use exponential backoff with full jitter so that, after a
 * server restart, thousands of clients do not reconnect in the same instant
 * (thundering herd).
 */
export class SignalingClient {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private reconnectTimer: number | null = null;
  private stopped = false;

  constructor(
    private readonly url: string,
    private readonly handlers: SignalingHandlers,
  ) {}

  connect(): void {
    this.stopped = false;
    this.open();
  }

  /** Send a message. Returns false when the socket is not open. */
  send(message: ClientMessageInput): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(message));
    return true;
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Close permanently (no reconnect), e.g. after a ban or on teardown. */
  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState <= WebSocket.OPEN) ws.close(1000, 'Client closing');
    this.handlers.onStatus('stopped');
  }

  private open(): void {
    this.handlers.onStatus(this.attempt === 0 ? 'connecting' : 'reconnecting');
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.attempt = 0;
      this.handlers.onStatus('open');
    };

    ws.onmessage = (event: MessageEvent) => {
      if (this.ws !== ws || typeof event.data !== 'string') return;
      // Validate even though the server is trusted: a schema mismatch after
      // a deployment should degrade gracefully, not crash the UI.
      const message = parseMessage(serverMessageSchema, event.data);
      if (message) this.handlers.onMessage(message);
    };

    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (!this.stopped) this.scheduleReconnect();
    };
    // 'error' is always followed by 'close', which handles reconnection.
    ws.onerror = () => undefined;
  }

  private scheduleReconnect(): void {
    this.attempt += 1;
    this.handlers.onStatus('reconnecting');
    const ceiling = Math.min(MAX_BACKOFF_MS, INITIAL_BACKOFF_MS * 2 ** (this.attempt - 1));
    const delay = Math.random() * ceiling;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) this.open();
    }, delay);
  }
}
