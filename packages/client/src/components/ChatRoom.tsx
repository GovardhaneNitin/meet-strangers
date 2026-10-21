import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatMode, ReportReason } from '@meet-strangers/shared';
import type { ChatState } from '../lib/chatController';
import type { LocalMedia } from '../hooks/useLocalMedia';
import { ChatPanel } from './ChatPanel';
import {
  CameraIcon,
  CameraOffIcon,
  FlagIcon,
  MicIcon,
  MicOffIcon,
  NextIcon,
  StopIcon,
  XIcon,
} from './Icons';
import { MediaTile } from './MediaTile';
import { ReportDialog } from './ReportDialog';

interface ChatRoomProps {
  state: ChatState;
  mode: ChatMode;
  media: LocalMedia;
  onNext: () => void;
  onStop: () => void;
  onSend: (text: string) => boolean;
  onReport: (reason: ReportReason, matchId: string) => void;
  onDismissNotice: () => void;
}

/** Brief lock after "Next" so a double click does not skip two people. */
const NEXT_COOLDOWN_MS = 800;
const ESC_CONFIRM_WINDOW_MS = 2_000;

const STATUS_TEXT: Record<ChatState['phase'], string> = {
  idle: 'Ready',
  searching: 'Looking for someone to talk to…',
  connecting: 'Connecting to stranger…',
  connected: 'Connected',
  ended: 'Chat ended',
};

export function ChatRoom({
  state,
  mode,
  media,
  onNext,
  onStop,
  onSend,
  onReport,
  onDismissNotice,
}: ChatRoomProps) {
  /**
   * The chat being reported, captured when the dialog opens. The current
   * chat can change while the dialog is open (e.g. the connection fails and
   * we move on automatically); the report must still target this one.
   */
  const [reportMatchId, setReportMatchId] = useState<string | null>(null);
  const reportOpen = reportMatchId !== null;
  const [nextLocked, setNextLocked] = useState(false);
  const [escArmed, setEscArmed] = useState(false);
  const escTimer = useRef<number | null>(null);

  const canReport =
    state.matchId !== null &&
    state.signaling === 'open' &&
    (state.phase === 'connecting' || state.phase === 'connected' || state.phase === 'ended');

  const next = useCallback(() => {
    if (nextLocked) return;
    setNextLocked(true);
    window.setTimeout(() => setNextLocked(false), NEXT_COOLDOWN_MS);
    onNext();
  }, [nextLocked, onNext]);

  // Esc twice = next (the first press arms it), like the classic shortcut,
  // so a stray key press never drops a conversation.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || reportOpen || event.defaultPrevented) return;
      if (escArmed) {
        setEscArmed(false);
        if (escTimer.current !== null) window.clearTimeout(escTimer.current);
        next();
        return;
      }
      setEscArmed(true);
      escTimer.current = window.setTimeout(() => setEscArmed(false), ESC_CONFIRM_WINDOW_MS);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [escArmed, next, reportOpen]);

  useEffect(
    () => () => {
      if (escTimer.current !== null) window.clearTimeout(escTimer.current);
    },
    [],
  );

  const showOverlay = state.phase !== 'connected';

  return (
    <main className="room">
      <div className="room__stage">
        <MediaTile
          className="room__remote"
          stream={state.remoteStream}
          audioOnly={mode === 'audio'}
          label="Stranger"
        >
          {showOverlay && (
            <div className="room__overlay" role="status" aria-live="polite">
              {(state.phase === 'searching' || state.phase === 'connecting') && (
                <span className="spinner" aria-hidden="true" />
              )}
              <p className="room__overlay-title">
                {state.phase === 'ended' && state.endReason === 'partner_left'
                  ? 'Stranger has disconnected'
                  : state.phase === 'ended' && state.endReason === 'connection_lost'
                    ? 'Connection lost'
                    : STATUS_TEXT[state.phase]}
              </p>
              {state.phase === 'searching' && state.onlineCount !== null && (
                <p className="muted">{state.onlineCount.toLocaleString()} people online</p>
              )}
              {state.signaling === 'reconnecting' && (
                <p className="muted">Reconnecting to the server…</p>
              )}
              {state.phase === 'ended' && (
                <button type="button" className="button button--primary" onClick={next}>
                  Find someone new
                </button>
              )}
            </div>
          )}
          {state.phase === 'connected' && state.commonInterests.length > 0 && (
            <div className="room__interests">You both like {state.commonInterests.join(', ')}</div>
          )}
        </MediaTile>

        <MediaTile
          className="room__local"
          stream={media.stream}
          local
          audioOnly={mode === 'audio'}
          hideVideo={!media.cameraEnabled}
          label="You"
        />

        {state.notice && (
          <div className={`toast toast--${state.notice.kind}`} role="status">
            <span>{state.notice.text}</span>
            <button
              type="button"
              className="toast__close"
              onClick={onDismissNotice}
              aria-label="Dismiss"
            >
              <XIcon width={16} height={16} />
            </button>
          </div>
        )}

        <div className="controls" role="toolbar" aria-label="Call controls">
          <button
            type="button"
            className={`button button--icon ${media.micEnabled ? '' : 'is-off'}`}
            onClick={media.toggleMic}
            aria-pressed={!media.micEnabled}
            aria-label={media.micEnabled ? 'Mute microphone' : 'Unmute microphone'}
            title={media.micEnabled ? 'Mute microphone' : 'Unmute microphone'}
          >
            {media.micEnabled ? <MicIcon /> : <MicOffIcon />}
          </button>
          {mode === 'video' && (
            <button
              type="button"
              className={`button button--icon ${media.cameraEnabled ? '' : 'is-off'}`}
              onClick={media.toggleCamera}
              aria-pressed={!media.cameraEnabled}
              aria-label={media.cameraEnabled ? 'Turn camera off' : 'Turn camera on'}
              title={media.cameraEnabled ? 'Turn camera off' : 'Turn camera on'}
            >
              {media.cameraEnabled ? <CameraIcon /> : <CameraOffIcon />}
            </button>
          )}
          <button
            type="button"
            className="button button--icon"
            onClick={() => setReportMatchId(state.matchId)}
            disabled={!canReport}
            aria-label="Report stranger"
            title="Report stranger"
          >
            <FlagIcon />
          </button>
          <span className="controls__divider" aria-hidden="true" />
          <button type="button" className="button button--ghost" onClick={onStop}>
            <StopIcon /> Stop
          </button>
          <button
            type="button"
            className="button button--primary"
            onClick={next}
            disabled={nextLocked || state.signaling !== 'open'}
          >
            <NextIcon /> {escArmed ? 'Press Esc again' : 'Next'}
            <kbd className="kbd" aria-hidden="true">
              Esc
            </kbd>
          </button>
        </div>
      </div>

      <ChatPanel
        messages={state.messages}
        enabled={state.chatReady && state.phase === 'connected'}
        onSend={onSend}
      />

      <ReportDialog
        open={reportOpen}
        onClose={() => setReportMatchId(null)}
        onSubmit={(reason) => {
          if (reportMatchId) onReport(reason, reportMatchId);
          setReportMatchId(null);
        }}
      />
    </main>
  );
}
