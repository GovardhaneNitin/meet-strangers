import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientMessage, ServerMessage } from '@meet-strangers/shared';

// --- Test doubles ------------------------------------------------------------

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  sent: ClientMessage[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(JSON.parse(data) as ClientMessage);
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }

  // Helpers driven by tests
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  receive(message: ServerMessage) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  drop() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
}

const peers: FakePeer[] = [];
class FakePeer {
  signals: unknown[] = [];
  closed = false;
  constructor(readonly options: { role: string; onStateChange: (state: string) => void }) {
    peers.push(this);
  }
  handleSignal(payload: unknown) {
    this.signals.push(payload);
    return Promise.resolve();
  }
  sendChat() {
    return true;
  }
  close() {
    this.closed = true;
  }
}

vi.mock('../src/lib/peerSession', () => ({ PeerSession: FakePeer }));

const { ChatController } = await import('../src/lib/chatController');

// --- Helpers -------------------------------------------------------------------

const MATCH_1 = '11111111-1111-4111-8111-111111111111';
const MATCH_2 = '22222222-2222-4222-8222-222222222222';
const fakeStream = {} as MediaStream;
const prefs = { mode: 'video' as const, interests: [] };

function matched(matchId: string): ServerMessage {
  return {
    type: 'matched',
    matchId,
    role: 'offerer',
    mode: 'video',
    commonInterests: [],
    iceServers: [],
    iceTransportPolicy: 'all',
  };
}

function setup() {
  const controller = new ChatController('ws://test/ws');
  controller.connect();
  const ws = FakeWebSocket.instances.at(-1)!;
  ws.open();
  ws.receive({ type: 'welcome', protocolVersion: 1, onlineCount: 2 });
  return { controller, ws };
}

const sentTypes = (ws: FakeWebSocket) => ws.sent.map((m) => m.type);

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('WebSocket', FakeWebSocket);
  FakeWebSocket.instances = [];
  peers.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// --- Tests ---------------------------------------------------------------------

describe('ChatController', () => {
  it('joins once the user starts and enters the connecting phase on match', () => {
    const { controller, ws } = setup();
    controller.start(prefs, fakeStream);
    expect(ws.sent).toEqual([{ type: 'join', mode: 'video', interests: [], acceptedTerms: true }]);
    expect(controller.getSnapshot().phase).toBe('searching');

    ws.receive({ type: 'queued', mode: 'video' });
    ws.receive(matched(MATCH_1));
    expect(controller.getSnapshot()).toMatchObject({ phase: 'connecting', matchId: MATCH_1 });
    expect(peers).toHaveLength(1);

    peers[0]!.options.onStateChange('connected');
    expect(controller.getSnapshot().phase).toBe('connected');
  });

  it('defers the join until the socket is open', () => {
    const controller = new ChatController('ws://test/ws');
    controller.connect();
    const ws = FakeWebSocket.instances.at(-1)!;
    controller.start(prefs, fakeStream);
    expect(ws.sent).toEqual([]);
    ws.open();
    ws.receive({ type: 'welcome', protocolVersion: 1, onlineCount: 1 });
    expect(sentTypes(ws)).toEqual(['join']);
  });

  it('ignores signals and partner_left for anything but the current match', () => {
    const { controller, ws } = setup();
    controller.start(prefs, fakeStream);
    ws.receive(matched(MATCH_1));
    controller.next();
    ws.receive(matched(MATCH_2));

    const signal = { kind: 'offer', sdp: 'v=0' } as const;
    ws.receive({ type: 'signal', matchId: MATCH_1, payload: signal });
    ws.receive({ type: 'partner_left', matchId: MATCH_1 });
    expect(peers[1]!.signals).toEqual([]);
    expect(controller.getSnapshot()).toMatchObject({ phase: 'connecting', matchId: MATCH_2 });
    expect(peers[0]!.closed).toBe(true);

    ws.receive({ type: 'signal', matchId: MATCH_2, payload: signal });
    expect(peers[1]!.signals).toEqual([signal]);
  });

  it('shows the partner leaving and closes the call', () => {
    const { controller, ws } = setup();
    controller.start(prefs, fakeStream);
    ws.receive(matched(MATCH_1));
    ws.receive({ type: 'partner_left', matchId: MATCH_1 });
    expect(controller.getSnapshot()).toMatchObject({ phase: 'ended', endReason: 'partner_left' });
    expect(peers[0]!.closed).toBe(true);
  });

  it('retries a rate-limited join after the server-provided delay', () => {
    const { controller, ws } = setup();
    controller.start(prefs, fakeStream);
    ws.receive({ type: 'error', code: 'rate_limited', message: 'slow down', retryAfterMs: 1500 });
    expect(sentTypes(ws)).toEqual(['join']);
    vi.advanceTimersByTime(1600);
    expect(sentTypes(ws)).toEqual(['join', 'join']);
    expect(controller.getSnapshot().phase).toBe('searching');
  });

  it('reports the last stranger even after they left, then moves on', () => {
    const { controller, ws } = setup();
    controller.start(prefs, fakeStream);
    ws.receive(matched(MATCH_1));
    ws.receive({ type: 'partner_left', matchId: MATCH_1 });
    expect(controller.report('nudity', MATCH_1)).toBe(true);
    expect(ws.sent.slice(-2)).toEqual([
      { type: 'report', matchId: MATCH_1, reason: 'nudity' },
      { type: 'join', mode: 'video', interests: [], acceptedTerms: true },
    ]);
    expect(controller.getSnapshot().notice?.kind).toBe('info');
  });

  it('reports the chat the user chose even after moving on, without skipping the new stranger', () => {
    // Regression: the report used to target whoever was on screen at submit
    // time. If the connection failed while the dialog was open, the app
    // moved on and an innocent new stranger was reported and skipped.
    const { controller, ws } = setup();
    controller.start(prefs, fakeStream);
    ws.receive(matched(MATCH_1)); // user opens the report dialog for MATCH_1
    peers[0]!.options.onStateChange('failed'); // auto-next
    ws.receive({ type: 'queued', mode: 'video' });
    ws.receive(matched(MATCH_2));
    const sentBefore = ws.sent.length;

    expect(controller.report('harassment', MATCH_1)).toBe(true);

    expect(ws.sent.slice(sentBefore)).toEqual([
      { type: 'report', matchId: MATCH_1, reason: 'harassment' },
    ]);
    expect(controller.getSnapshot()).toMatchObject({ phase: 'connecting', matchId: MATCH_2 });
    expect(peers[1]!.closed).toBe(false);
    expect(controller.getSnapshot().notice?.text).toBe('Thanks. Your report was sent.');
  });

  it('tells the user when a report cannot be sent because the server connection is down', () => {
    // Regression: the report was silently dropped while the UI said "sent".
    const { controller, ws } = setup();
    controller.start(prefs, fakeStream);
    ws.receive(matched(MATCH_1));
    ws.drop();

    expect(controller.report('nudity', MATCH_1)).toBe(false);

    expect(ws.sent.filter((m) => m.type === 'report')).toHaveLength(0);
    expect(controller.getSnapshot().notice).toMatchObject({ kind: 'error' });
    expect(controller.getSnapshot().notice?.text).not.toMatch(/was sent/);
  });

  it('does not re-join after the join succeeded despite an unrelated rate-limit error', () => {
    // Regression: a rate-limited *report* scheduled a join retry that was not
    // cancelled by "queued", so the user re-joined later and lost their place.
    const { controller, ws } = setup();
    controller.start(prefs, fakeStream);
    ws.receive({ type: 'queued', mode: 'video' });
    ws.receive(matched(MATCH_1));
    controller.report('spam', MATCH_1); // report + join
    ws.receive({
      type: 'error',
      code: 'rate_limited',
      message: 'Too many reports.',
      retryAfterMs: 20_000,
    });
    ws.receive({ type: 'queued', mode: 'video' });
    const joins = () => ws.sent.filter((m) => m.type === 'join').length;
    const before = joins();

    vi.advanceTimersByTime(30_000);

    expect(joins()).toBe(before);
  });

  it('automatically moves on when the WebRTC connection fails', () => {
    const { controller, ws } = setup();
    controller.start(prefs, fakeStream);
    ws.receive(matched(MATCH_1));
    peers[0]!.options.onStateChange('failed');
    expect(controller.getSnapshot().phase).toBe('searching');
    expect(sentTypes(ws)).toEqual(['join', 'join']);
  });

  it('leaves a match that arrives after the user stopped', () => {
    const { controller, ws } = setup();
    controller.start(prefs, fakeStream);
    controller.stop();
    ws.receive(matched(MATCH_1));
    expect(sentTypes(ws)).toEqual(['join', 'leave', 'leave']);
    expect(peers).toHaveLength(0);
    expect(controller.getSnapshot().phase).toBe('idle');
  });

  it('ends the call when the server connection drops and resumes searching after reconnect', () => {
    const { controller, ws } = setup();
    controller.start(prefs, fakeStream);
    ws.receive(matched(MATCH_1));
    ws.drop();
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'ended',
      endReason: 'connection_lost',
    });
    expect(peers[0]!.closed).toBe(true);

    controller.next();
    vi.advanceTimersByTime(1_000);
    const ws2 = FakeWebSocket.instances.at(-1)!;
    expect(ws2).not.toBe(ws);
    ws2.open();
    ws2.receive({ type: 'welcome', protocolVersion: 1, onlineCount: 1 });
    expect(sentTypes(ws2)).toEqual(['join']);
  });

  it('stops for good when banned', () => {
    const { controller, ws } = setup();
    controller.start(prefs, fakeStream);
    ws.receive({ type: 'error', code: 'banned', message: 'Suspended' });
    ws.drop();
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(controller.getSnapshot().fatal).toBe('Suspended');
    controller.start(prefs, fakeStream);
    expect(sentTypes(ws)).toEqual(['join']);
  });

  it('ignores malformed server messages', () => {
    const { controller, ws } = setup();
    const before = controller.getSnapshot();
    ws.onmessage?.({ data: '{"type":"matched","matchId":"nope"}' });
    ws.onmessage?.({ data: 'not json' });
    expect(controller.getSnapshot()).toBe(before);
  });
});
