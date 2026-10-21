import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatMode } from '@meet-strangers/shared';
import { acquireLocalMedia, stopStream } from '../lib/media';

export interface LocalMedia {
  stream: MediaStream | null;
  micEnabled: boolean;
  cameraEnabled: boolean;
  acquire: (mode: ChatMode) => Promise<MediaStream>;
  release: () => void;
  toggleMic: () => void;
  toggleCamera: () => void;
}

/**
 * Owns the camera/microphone stream. Muting uses `track.enabled`, which keeps
 * the connection alive and sends silence/black frames instead of
 * renegotiating the call.
 *
 * `onTrackEnded` fires when a device disappears mid-call (unplugged, or
 * permission revoked from the browser UI).
 */
export function useLocalMedia(onTrackEnded: () => void): LocalMedia {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [micEnabled, setMicEnabled] = useState(true);
  const [cameraEnabled, setCameraEnabled] = useState(true);
  const streamRef = useRef<MediaStream | null>(null);
  const onTrackEndedRef = useRef(onTrackEnded);

  useEffect(() => {
    onTrackEndedRef.current = onTrackEnded;
  }, [onTrackEnded]);

  const release = useCallback(() => {
    stopStream(streamRef.current);
    streamRef.current = null;
    setStream(null);
  }, []);

  const acquire = useCallback(async (mode: ChatMode) => {
    stopStream(streamRef.current);
    const next = await acquireLocalMedia(mode);
    for (const track of next.getTracks()) {
      track.addEventListener('ended', () => {
        if (streamRef.current !== next) return;
        stopStream(next);
        streamRef.current = null;
        setStream(null);
        onTrackEndedRef.current();
      });
    }
    streamRef.current = next;
    setStream(next);
    setMicEnabled(true);
    setCameraEnabled(true);
    return next;
  }, []);

  const toggleMic = useCallback(() => {
    const tracks = streamRef.current?.getAudioTracks() ?? [];
    const enabled = !tracks.some((track) => track.enabled);
    tracks.forEach((track) => (track.enabled = enabled));
    setMicEnabled(enabled);
  }, []);

  const toggleCamera = useCallback(() => {
    const tracks = streamRef.current?.getVideoTracks() ?? [];
    const enabled = !tracks.some((track) => track.enabled);
    tracks.forEach((track) => (track.enabled = enabled));
    setCameraEnabled(enabled);
  }, []);

  // Turn the camera light off when the app unmounts.
  useEffect(() => () => stopStream(streamRef.current), []);

  return { stream, micEnabled, cameraEnabled, acquire, release, toggleMic, toggleCamera };
}
