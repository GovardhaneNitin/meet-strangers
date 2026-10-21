import type { ChatMode } from '@meet-strangers/shared';

export class MediaAccessError extends Error {
  constructor(
    message: string,
    /** Whether switching to voice-only could help (camera-specific failure). */
    readonly suggestVoiceOnly: boolean,
  ) {
    super(message);
    this.name = 'MediaAccessError';
  }
}

const AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

const VIDEO_CONSTRAINTS: MediaTrackConstraints = {
  width: { ideal: 1280 },
  height: { ideal: 720 },
  frameRate: { ideal: 30, max: 30 },
  facingMode: 'user',
};

/**
 * Request camera/microphone access and translate the many browser failure
 * modes into messages a user can act on.
 */
export async function acquireLocalMedia(mode: ChatMode): Promise<MediaStream> {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    throw new MediaAccessError(
      'Camera and microphone access requires a secure (HTTPS) connection and a modern browser.',
      false,
    );
  }

  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: AUDIO_CONSTRAINTS,
      video: mode === 'video' ? VIDEO_CONSTRAINTS : false,
    });
  } catch (error) {
    throw toMediaAccessError(error, mode);
  }
}

export function toMediaAccessError(error: unknown, mode: ChatMode): MediaAccessError {
  const name = error instanceof DOMException || error instanceof Error ? error.name : '';
  const devices = mode === 'video' ? 'camera and microphone' : 'microphone';
  const isVideo = mode === 'video';

  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return new MediaAccessError(
        `Access to your ${devices} was blocked. Allow it in your browser's site settings and try again.`,
        false,
      );
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return new MediaAccessError(
        isVideo
          ? 'No usable camera or microphone was found. Connect one, or try voice-only mode.'
          : 'No microphone was found. Connect one and try again.',
        isVideo,
      );
    case 'NotReadableError':
    case 'TrackStartError':
      return new MediaAccessError(
        `Your ${devices} is being used by another application. Close it and try again.`,
        isVideo,
      );
    case 'SecurityError':
      return new MediaAccessError('Media access is disabled on this page by your browser.', false);
    case 'AbortError':
      return new MediaAccessError(
        'Starting your devices was interrupted. Please try again.',
        false,
      );
    default:
      return new MediaAccessError(`Could not access your ${devices}. Please try again.`, isVideo);
  }
}

export function stopStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}
