import { useId, useState, type FormEvent, type KeyboardEvent } from 'react';
import { LIMITS, normalizeInterest, type ChatMode } from '@meet-strangers/shared';
import type { ChatPreferences } from '../lib/chatController';
import type { SignalingStatus } from '../lib/signaling';
import { CameraIcon, MicIcon, ShieldIcon, XIcon } from './Icons';

interface LandingProps {
  onStart: (prefs: ChatPreferences) => void;
  busy: boolean;
  error: string | null;
  suggestVoiceOnly: boolean;
  onlineCount: number | null;
  signaling: SignalingStatus;
  fatal: string | null;
}

export function Landing({
  onStart,
  busy,
  error,
  suggestVoiceOnly,
  onlineCount,
  signaling,
  fatal,
}: LandingProps) {
  const [mode, setMode] = useState<ChatMode>('video');
  const [interests, setInterests] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [interestError, setInterestError] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(false);
  const interestsId = useId();
  const interestHintId = useId();
  const termsId = useId();

  const addInterest = (raw: string) => {
    if (raw.trim() === '') return;
    const value = normalizeInterest(raw);
    if (!value) {
      // Keep the text so the user can correct it instead of losing it.
      setInterestError('Interests can only contain letters, numbers, spaces and dashes.');
      return;
    }
    setDraft('');
    setInterestError(null);
    if (interests.includes(value) || interests.length >= LIMITS.MAX_INTERESTS) return;
    setInterests([...interests, value]);
  };

  const onInterestKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      addInterest(draft);
    } else if (event.key === 'Backspace' && draft === '' && interests.length > 0) {
      setInterests(interests.slice(0, -1));
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!accepted || busy || fatal) return;
    const pending = normalizeInterest(draft);
    if (draft.trim() !== '' && !pending) {
      // Don't start with the typed interest silently dropped.
      setInterestError('Interests can only contain letters, numbers, spaces and dashes.');
      return;
    }
    const all = pending && !interests.includes(pending) ? [...interests, pending] : interests;
    onStart({ mode, interests: all.slice(0, LIMITS.MAX_INTERESTS) });
  };

  const online = signaling === 'open';

  return (
    <main className="landing">
      <header className="landing__header">
        <div className="brand">
          <span className="brand__mark" aria-hidden="true" />
          <span className="brand__name">Meet Strangers</span>
        </div>
        <div className={`status-pill ${online ? 'status-pill--online' : ''}`} role="status">
          <span className="status-pill__dot" aria-hidden="true" />
          {online
            ? onlineCount !== null
              ? `${onlineCount.toLocaleString()} online now`
              : 'Online'
            : signaling === 'reconnecting'
              ? 'Reconnecting…'
              : 'Connecting…'}
        </div>
      </header>

      <section className="landing__hero">
        <h1>Talk to someone new.</h1>
        <p className="lead">
          Random one-to-one video and voice chats with people around the world. No sign-up, no
          profile, no history. Just conversation.
        </p>

        {fatal ? (
          <div className="alert alert--error" role="alert">
            {fatal}
          </div>
        ) : (
          <form className="card start-form" onSubmit={submit}>
            <fieldset className="mode-toggle">
              <legend className="label">How do you want to chat?</legend>
              <label className={`mode-option ${mode === 'video' ? 'is-selected' : ''}`}>
                <input
                  type="radio"
                  name="mode"
                  value="video"
                  checked={mode === 'video'}
                  onChange={() => setMode('video')}
                />
                <CameraIcon />
                <span>
                  <strong>Video</strong>
                  <small>Camera and microphone</small>
                </span>
              </label>
              <label className={`mode-option ${mode === 'audio' ? 'is-selected' : ''}`}>
                <input
                  type="radio"
                  name="mode"
                  value="audio"
                  checked={mode === 'audio'}
                  onChange={() => setMode('audio')}
                />
                <MicIcon />
                <span>
                  <strong>Voice only</strong>
                  <small>Microphone only</small>
                </span>
              </label>
            </fieldset>

            <div className="field">
              <label className="label" htmlFor={interestsId}>
                Interests <span className="muted">(optional)</span>
              </label>
              <div className="tag-input">
                {interests.map((interest) => (
                  <span className="tag" key={interest}>
                    {interest}
                    <button
                      type="button"
                      className="tag__remove"
                      onClick={() => setInterests(interests.filter((i) => i !== interest))}
                      aria-label={`Remove ${interest}`}
                    >
                      <XIcon width={14} height={14} />
                    </button>
                  </span>
                ))}
                <input
                  id={interestsId}
                  value={draft}
                  onChange={(event) => {
                    setDraft(event.target.value);
                    setInterestError(null);
                  }}
                  onKeyDown={onInterestKey}
                  onBlur={() => draft && addInterest(draft)}
                  maxLength={LIMITS.MAX_INTEREST_LENGTH}
                  placeholder={
                    interests.length >= LIMITS.MAX_INTERESTS ? '' : 'e.g. music, travel, coding'
                  }
                  disabled={interests.length >= LIMITS.MAX_INTERESTS}
                  autoComplete="off"
                  enterKeyHint="done"
                  aria-invalid={interestError !== null}
                  aria-describedby={interestHintId}
                />
              </div>
              {interestError ? (
                <p className="hint hint--error" id={interestHintId} role="alert">
                  {interestError}
                </p>
              ) : (
                <p className="hint" id={interestHintId}>
                  We'll try to pair you with someone who shares an interest, then with anyone.
                </p>
              )}
            </div>

            <label className="checkbox" htmlFor={termsId}>
              <input
                id={termsId}
                type="checkbox"
                checked={accepted}
                onChange={(event) => setAccepted(event.target.checked)}
              />
              <span>
                I am <strong>18 or older</strong> and agree to follow the community guidelines
                below.
              </span>
            </label>

            {error && (
              <div className="alert alert--error" role="alert">
                {error}
                {suggestVoiceOnly && mode === 'video' && (
                  <button type="button" className="link-button" onClick={() => setMode('audio')}>
                    Switch to voice only
                  </button>
                )}
              </div>
            )}

            <button
              type="submit"
              className="button button--primary button--large"
              disabled={!accepted || busy}
            >
              {busy ? 'Starting…' : 'Start chatting'}
            </button>
          </form>
        )}
      </section>

      <section className="landing__info" aria-label="Guidelines and privacy">
        <div className="info-block">
          <h2>Community guidelines</h2>
          <ul>
            <li>You must be 18 or older.</li>
            <li>No nudity, sexual content, harassment, hate speech or threats.</li>
            <li>No spam, advertising or asking for personal information.</li>
            <li>
              Use the report button if someone breaks these rules. Repeat offenders are suspended.
            </li>
          </ul>
        </div>
        <div className="info-block">
          <h2>
            <ShieldIcon /> Privacy
          </h2>
          <ul>
            <li>No account, no name, no profile. Each visit is a fresh, anonymous session.</li>
            <li>
              Audio and video are encrypted and sent between you and the stranger, not through our
              servers. We never record or store calls or messages.
            </li>
            <li>
              Like any peer-to-peer call, the other person's device may be able to see your IP
              address unless the service is configured to relay calls.
            </li>
            <li>Never share personal details with strangers.</li>
          </ul>
        </div>
      </section>

      <footer className="landing__footer">
        <span>Meet Strangers</span>
        <span className="muted">Be kind. Stay safe.</span>
      </footer>
    </main>
  );
}
