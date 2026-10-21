/**
 * Hard limits for everything that crosses the wire.
 *
 * Every limit exists to bound the work (CPU, memory, bandwidth) an untrusted
 * client can make the server or the other peer do. They live in the shared
 * package so the client can enforce the same rules before sending and the
 * server can reject anything that exceeds them.
 */
export const LIMITS = {
  /** Max size of a single WebSocket frame accepted by the server (bytes). */
  MAX_WS_PAYLOAD_BYTES: 64 * 1024,
  /**
   * Max SDP length. Real-world audio+video SDP is typically 3–10 KB; 32 KB
   * leaves room for many codecs and simulcast without allowing abuse.
   */
  MAX_SDP_LENGTH: 32 * 1024,
  /** Max ICE candidate string length (real candidates are ~100–300 chars). */
  MAX_CANDIDATE_LENGTH: 1024,
  MAX_SDP_MID_LENGTH: 64,
  MAX_SDP_MLINE_INDEX: 64,
  MAX_INTERESTS: 5,
  MAX_INTEREST_LENGTH: 24,
  /** Max chat message length in characters, enforced by both peers. */
  MAX_CHAT_MESSAGE_LENGTH: 500,
} as const;

export const PROTOCOL_VERSION = 1;

/** WebSocket path served by the signaling server. */
export const SIGNALING_PATH = '/ws';
