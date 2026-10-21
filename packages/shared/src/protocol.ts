import { z } from 'zod';
import { LIMITS } from './limits.js';

// Zod speeds up object parsing by compiling validators with `new Function`,
// after probing whether eval is allowed. The web client's Content Security
// Policy forbids eval ('unsafe-eval' is deliberately absent), so the probe
// fails and browsers report it as a CSP violation. Use the interpreted path
// everywhere; protocol messages are small, so the speed difference is
// negligible.
z.config({ jitless: true });

/*
 * Wire protocol between browser and signaling server.
 *
 * Design rules:
 *  - Every message is a JSON object with a `type` discriminator.
 *  - Objects are strict: unknown keys are rejected, not silently ignored, so a
 *    malformed or malicious client is detected instead of half-processed.
 *  - Clients never address other users directly. A client may only send a
 *    signal to "my current partner", identified by the server-issued
 *    `matchId`. The server resolves the recipient, which makes it impossible
 *    to inject signals into someone else's call.
 */

export const chatModeSchema = z.enum(['video', 'audio']);
export type ChatMode = z.infer<typeof chatModeSchema>;

const idSchema = z.uuid();

const sessionDescriptionSchema = z.strictObject({
  kind: z.enum(['offer', 'answer']),
  sdp: z.string().min(1).max(LIMITS.MAX_SDP_LENGTH),
});

const iceCandidateSchema = z.strictObject({
  kind: z.literal('candidate'),
  candidate: z.strictObject({
    // An empty candidate string is the legitimate "end of candidates" marker.
    candidate: z.string().max(LIMITS.MAX_CANDIDATE_LENGTH),
    sdpMid: z.string().max(LIMITS.MAX_SDP_MID_LENGTH).nullable(),
    sdpMLineIndex: z.number().int().min(0).max(LIMITS.MAX_SDP_MLINE_INDEX).nullable(),
    usernameFragment: z.string().max(256).nullable().optional(),
  }),
});

export const signalPayloadSchema = z.discriminatedUnion('kind', [
  sessionDescriptionSchema,
  iceCandidateSchema,
]);
export type SignalPayload = z.infer<typeof signalPayloadSchema>;

export const reportReasonSchema = z.enum(['nudity', 'harassment', 'spam', 'underage', 'other']);
export type ReportReason = z.infer<typeof reportReasonSchema>;

// ---------------------------------------------------------------------------
// Client -> Server
// ---------------------------------------------------------------------------

export const clientMessageSchema = z.discriminatedUnion('type', [
  /**
   * Enter the matchmaking queue. Sent while already in a chat it means
   * "next": the current chat ends and the client is re-queued atomically.
   */
  z.strictObject({
    type: z.literal('join'),
    mode: chatModeSchema,
    interests: z
      .array(z.string().max(LIMITS.MAX_INTEREST_LENGTH * 2))
      .max(LIMITS.MAX_INTERESTS * 2)
      .default([]),
    /** The user confirmed they are 18+ and accept the community rules. */
    acceptedTerms: z.literal(true),
  }),
  /** Leave the queue or end the current chat and go idle. */
  z.strictObject({ type: z.literal('leave') }),
  /** Relay a WebRTC negotiation message to the current partner. */
  z.strictObject({
    type: z.literal('signal'),
    matchId: idSchema,
    payload: signalPayloadSchema,
  }),
  /** Report the current partner. Also ends the chat. */
  z.strictObject({
    type: z.literal('report'),
    matchId: idSchema,
    reason: reportReasonSchema,
  }),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;
export type ClientMessageInput = z.input<typeof clientMessageSchema>;

// ---------------------------------------------------------------------------
// Server -> Client
// ---------------------------------------------------------------------------

export const iceServerSchema = z.strictObject({
  urls: z.union([z.string(), z.array(z.string())]),
  username: z.string().optional(),
  credential: z.string().optional(),
});
export type IceServer = z.infer<typeof iceServerSchema>;

export const errorCodeSchema = z.enum([
  'invalid_message',
  'rate_limited',
  'banned',
  'server_shutdown',
  'not_in_chat',
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const serverMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('welcome'),
    protocolVersion: z.number().int(),
    onlineCount: z.number().int().nonnegative(),
  }),
  z.strictObject({
    type: z.literal('queued'),
    mode: chatModeSchema,
  }),
  z.strictObject({
    type: z.literal('matched'),
    matchId: idSchema,
    /**
     * The server picks exactly one side to create the offer. Deterministic
     * roles avoid "glare" (both peers sending offers at the same time).
     */
    role: z.enum(['offerer', 'answerer']),
    mode: chatModeSchema,
    commonInterests: z.array(z.string()),
    iceServers: z.array(iceServerSchema),
    iceTransportPolicy: z.enum(['all', 'relay']),
  }),
  z.strictObject({
    type: z.literal('signal'),
    matchId: idSchema,
    payload: signalPayloadSchema,
  }),
  z.strictObject({
    type: z.literal('partner_left'),
    matchId: idSchema,
  }),
  z.strictObject({
    type: z.literal('idle'),
  }),
  z.strictObject({
    type: z.literal('online'),
    count: z.number().int().nonnegative(),
  }),
  z.strictObject({
    type: z.literal('error'),
    code: errorCodeSchema,
    message: z.string(),
    /** Milliseconds until the client may retry, when applicable. */
    retryAfterMs: z.number().int().nonnegative().optional(),
  }),
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;

// ---------------------------------------------------------------------------
// Peer <-> Peer (WebRTC data channel; never touches the server)
// ---------------------------------------------------------------------------

export const peerMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('chat'),
    text: z.string().min(1).max(LIMITS.MAX_CHAT_MESSAGE_LENGTH),
  }),
]);
export type PeerMessage = z.infer<typeof peerMessageSchema>;

/**
 * Parse an untrusted JSON string against a schema. Never throws: returns
 * `null` for malformed JSON or schema violations.
 */
export function parseMessage<T>(schema: z.ZodType<T>, raw: string): T | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = schema.safeParse(data);
  return result.success ? result.data : null;
}
