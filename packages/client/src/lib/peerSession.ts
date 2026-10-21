import {
  LIMITS,
  parseMessage,
  peerMessageSchema,
  type IceServer,
  type SignalPayload,
} from '@meet-strangers/shared';

export type PeerState = 'connecting' | 'connected' | 'failed' | 'closed';

export interface PeerSessionOptions {
  role: 'offerer' | 'answerer';
  iceServers: IceServer[];
  iceTransportPolicy: RTCIceTransportPolicy;
  localStream: MediaStream;
  sendSignal: (payload: SignalPayload) => void;
  onRemoteStream: (stream: MediaStream) => void;
  onStateChange: (state: PeerState) => void;
  onChatOpen: () => void;
  onChatMessage: (text: string) => void;
}

/** Give up if media is not flowing this long after the match. */
const CONNECT_TIMEOUT_MS = 25_000;
/** "disconnected" is often transient (Wi-Fi hiccup); only fail if it persists. */
const DISCONNECTED_GRACE_MS = 8_000;
/** Candidates that arrive before the remote description are buffered, within reason. */
const MAX_PENDING_CANDIDATES = 200;
/** Incoming chat flood protection: burst size and refill rate per second. */
const CHAT_BURST = 8;
const CHAT_REFILL_PER_SECOND = 2;

/**
 * One WebRTC call with one stranger.
 *
 * The remote peer is untrusted: every message it sends (signals relayed by
 * the server, data channel messages) is validated and bounded here. A new
 * instance is created per match and is never reused.
 */
export class PeerSession {
  private readonly pc: RTCPeerConnection;
  private channel: RTCDataChannel | null = null;
  private readonly pendingCandidates: RTCIceCandidateInit[] = [];
  private state: PeerState = 'connecting';
  private connectTimer: number | null = null;
  private disconnectTimer: number | null = null;
  private chatTokens = CHAT_BURST;
  private chatTokensAt = performance.now();
  private remoteStream: MediaStream | null = null;
  /** Signals are applied strictly in arrival order; WebRTC APIs are async. */
  private signalQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: PeerSessionOptions) {
    this.pc = new RTCPeerConnection({
      iceServers: options.iceServers,
      iceTransportPolicy: options.iceTransportPolicy,
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
    });

    for (const track of options.localStream.getTracks()) {
      this.pc.addTrack(track, options.localStream);
    }

    this.pc.onicecandidate = ({ candidate }) => {
      if (!candidate || this.state === 'closed') return;
      this.options.sendSignal({
        kind: 'candidate',
        candidate: {
          candidate: candidate.candidate,
          sdpMid: candidate.sdpMid,
          sdpMLineIndex: candidate.sdpMLineIndex,
          usernameFragment: candidate.usernameFragment,
        },
      });
    };

    this.pc.ontrack = (event) => {
      const stream = event.streams[0] ?? (this.remoteStream ??= new MediaStream());
      if (!event.streams[0]) stream.addTrack(event.track);
      this.remoteStream = stream;
      this.options.onRemoteStream(stream);
    };

    this.pc.onconnectionstatechange = () => this.handleConnectionState();

    if (options.role === 'offerer') {
      // Ordered + reliable is right for chat text; the offerer creates the
      // channel so it is part of the initial offer (no renegotiation needed).
      this.attachChannel(this.pc.createDataChannel('chat', { ordered: true }));
      void this.createOffer();
    } else {
      this.pc.ondatachannel = (event) => {
        // Only one channel is expected; ignore anything else the peer opens.
        if (this.channel || event.channel.label !== 'chat') {
          event.channel.close();
          return;
        }
        this.attachChannel(event.channel);
      };
    }

    this.connectTimer = window.setTimeout(() => {
      if (this.state === 'connecting') this.setState('failed');
    }, CONNECT_TIMEOUT_MS);
  }

  handleSignal(payload: SignalPayload): Promise<void> {
    this.signalQueue = this.signalQueue.then(() => this.applySignal(payload));
    return this.signalQueue;
  }

  private async applySignal(payload: SignalPayload): Promise<void> {
    if (this.state === 'closed') return;
    try {
      switch (payload.kind) {
        case 'offer':
          // Roles are fixed by the server: an offer is only valid for the
          // answerer, and only once.
          if (this.options.role !== 'answerer' || this.pc.signalingState !== 'stable') return;
          if (this.pc.remoteDescription) return;
          await this.pc.setRemoteDescription({ type: 'offer', sdp: payload.sdp });
          await this.flushCandidates();
          await this.pc.setLocalDescription(await this.pc.createAnswer());
          this.sendLocalDescription();
          return;

        case 'answer':
          if (this.options.role !== 'offerer' || this.pc.signalingState !== 'have-local-offer')
            return;
          await this.pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp });
          await this.flushCandidates();
          return;

        case 'candidate':
          if (!this.pc.remoteDescription) {
            if (this.pendingCandidates.length < MAX_PENDING_CANDIDATES) {
              this.pendingCandidates.push(payload.candidate);
            }
            return;
          }
          await this.addCandidate(payload.candidate);
          return;
      }
    } catch {
      // Invalid SDP: this call cannot succeed. (No-op if closed meanwhile.)
      this.setState('failed');
    }
  }

  /** Send a chat message. Returns false if the channel is not open. */
  sendChat(text: string): boolean {
    if (this.channel?.readyState !== 'open') return false;
    const trimmed = text.trim().slice(0, LIMITS.MAX_CHAT_MESSAGE_LENGTH);
    if (trimmed.length === 0) return false;
    this.channel.send(JSON.stringify({ type: 'chat', text: trimmed }));
    return true;
  }

  get isChatOpen(): boolean {
    return this.channel?.readyState === 'open';
  }

  close(): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    this.clearTimers();
    this.pc.onicecandidate = null;
    this.pc.ontrack = null;
    this.pc.onconnectionstatechange = null;
    this.pc.ondatachannel = null;
    if (this.channel) {
      this.channel.onmessage = null;
      this.channel.onopen = null;
      this.channel.close();
    }
    // Stop only the *remote* tracks; local tracks are owned by the caller
    // and reused for the next match.
    this.remoteStream?.getTracks().forEach((track) => track.stop());
    this.pc.close();
  }

  private async createOffer(): Promise<void> {
    try {
      // Both peers always send the same kinds of tracks (the server only
      // pairs users of the same mode), so no extra transceivers are needed.
      const offer = await this.pc.createOffer();
      if (this.state === 'closed') return;
      await this.pc.setLocalDescription(offer);
      this.sendLocalDescription();
    } catch {
      this.setState('failed');
    }
  }

  private sendLocalDescription(): void {
    const description = this.pc.localDescription;
    if (!description || this.state === 'closed') return;
    if (description.type !== 'offer' && description.type !== 'answer') return;
    this.options.sendSignal({ kind: description.type, sdp: description.sdp });
  }

  private async flushCandidates(): Promise<void> {
    const queued = this.pendingCandidates.splice(0);
    for (const candidate of queued) await this.addCandidate(candidate);
  }

  private async addCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    try {
      await this.pc.addIceCandidate(candidate);
    } catch {
      // A single bad candidate is not fatal; ICE will use the others.
    }
  }

  private attachChannel(channel: RTCDataChannel): void {
    this.channel = channel;
    channel.onopen = () => this.options.onChatOpen();
    channel.onmessage = (event: MessageEvent) => {
      if (typeof event.data !== 'string') return;
      // Cheap length check before parsing: JSON-escaped text can be up to
      // ~6x longer than the decoded string, so allow for that headroom.
      if (event.data.length > LIMITS.MAX_CHAT_MESSAGE_LENGTH * 6 + 64) return;
      if (!this.takeChatToken()) return;
      const message = parseMessage(peerMessageSchema, event.data);
      if (message?.type === 'chat') {
        const text = message.text.trim();
        if (text.length > 0) this.options.onChatMessage(text);
      }
    };
  }

  private takeChatToken(): boolean {
    const now = performance.now();
    this.chatTokens = Math.min(
      CHAT_BURST,
      this.chatTokens + ((now - this.chatTokensAt) / 1000) * CHAT_REFILL_PER_SECOND,
    );
    this.chatTokensAt = now;
    if (this.chatTokens < 1) return false;
    this.chatTokens -= 1;
    return true;
  }

  private handleConnectionState(): void {
    switch (this.pc.connectionState) {
      case 'connected':
        if (this.disconnectTimer !== null) window.clearTimeout(this.disconnectTimer);
        this.disconnectTimer = null;
        this.setState('connected');
        break;
      case 'disconnected':
        this.disconnectTimer ??= window.setTimeout(() => {
          this.disconnectTimer = null;
          if (this.pc.connectionState !== 'connected') this.setState('failed');
        }, DISCONNECTED_GRACE_MS);
        break;
      case 'failed':
        this.setState('failed');
        break;
      default:
        break;
    }
  }

  private setState(state: PeerState): void {
    if (this.state === state || this.state === 'closed') return;
    this.state = state;
    if (state !== 'connecting' && this.connectTimer !== null) {
      window.clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    this.options.onStateChange(state);
  }

  private clearTimers(): void {
    if (this.connectTimer !== null) window.clearTimeout(this.connectTimer);
    if (this.disconnectTimer !== null) window.clearTimeout(this.disconnectTimer);
    this.connectTimer = null;
    this.disconnectTimer = null;
  }
}
