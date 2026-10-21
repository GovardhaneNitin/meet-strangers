import { useEffect, useRef, useState, type ReactNode } from 'react';

interface MediaTileProps {
  stream: MediaStream | null;
  /** Local preview: muted (avoid echo) and mirrored like a mirror. */
  local?: boolean;
  /** Voice-only chat: render an avatar instead of video. */
  audioOnly?: boolean;
  hideVideo?: boolean;
  label: string;
  className?: string;
  children?: ReactNode;
}

/**
 * Renders a MediaStream. Remote audio is played through the same element so
 * there is exactly one output per stream.
 *
 * Browsers can block autoplay with sound; when that happens a button lets
 * the user start playback with a click (a user gesture).
 */
export function MediaTile({
  stream,
  local = false,
  audioOnly = false,
  hideVideo = false,
  label,
  className = '',
  children,
}: MediaTileProps) {
  const mediaRef = useRef<HTMLVideoElement>(null);
  const [blocked, setBlocked] = useState(false);

  useEffect(() => {
    const element = mediaRef.current;
    if (!element) return;
    element.srcObject = stream;
    if (!stream) return;
    element.play().then(
      () => setBlocked(false),
      (error: unknown) => {
        if (error instanceof DOMException && error.name === 'NotAllowedError') setBlocked(true);
      },
    );
  }, [stream]);

  const showAvatar = audioOnly || hideVideo || !stream;

  return (
    <div className={`media-tile ${className}`} aria-label={label} role="group">
      <video
        ref={mediaRef}
        className={`media-tile__video ${local ? 'is-mirrored' : ''} ${showAvatar ? 'is-hidden' : ''}`}
        autoPlay
        playsInline
        muted={local}
      />
      {showAvatar && stream && (
        <div className="media-tile__avatar" aria-hidden="true">
          <span>{local ? 'You' : 'Stranger'}</span>
        </div>
      )}
      {blocked && (
        <button
          type="button"
          className="button button--primary media-tile__unblock"
          onClick={() => {
            void mediaRef.current?.play().then(() => setBlocked(false));
          }}
        >
          Click to enable sound
        </button>
      )}
      {children}
    </div>
  );
}
