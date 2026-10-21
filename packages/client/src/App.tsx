import { useCallback, useEffect, useState } from 'react';
import type { ChatMode } from '@meet-strangers/shared';
import { ChatRoom } from './components/ChatRoom';
import { Landing } from './components/Landing';
import { useChatController } from './hooks/useChatController';
import { useLocalMedia } from './hooks/useLocalMedia';
import type { ChatPreferences } from './lib/chatController';
import { MediaAccessError } from './lib/media';

export function App() {
  const [controller, state] = useChatController();
  const [inRoom, setInRoom] = useState(false);
  const [mode, setMode] = useState<ChatMode>('video');
  const [starting, setStarting] = useState(false);
  const [mediaError, setMediaError] = useState<{ text: string; suggestVoiceOnly: boolean } | null>(
    null,
  );

  const leaveRoom = useCallback(
    (error: string | null) => {
      controller.stop();
      setInRoom(false);
      setMediaError(error ? { text: error, suggestVoiceOnly: false } : null);
    },
    [controller],
  );

  const media = useLocalMedia(
    useCallback(() => leaveRoom('Your camera or microphone was disconnected.'), [leaveRoom]),
  );

  const start = async (prefs: ChatPreferences) => {
    setStarting(true);
    setMediaError(null);
    try {
      const stream = await media.acquire(prefs.mode);
      setMode(prefs.mode);
      controller.start(prefs, stream);
      setInRoom(true);
    } catch (error) {
      setMediaError(
        error instanceof MediaAccessError
          ? { text: error.message, suggestVoiceOnly: error.suggestVoiceOnly }
          : { text: 'Something went wrong. Please try again.', suggestVoiceOnly: false },
      );
    } finally {
      setStarting(false);
    }
  };

  const stop = () => {
    leaveRoom(null);
    // Release the devices so the camera light turns off immediately.
    media.release();
  };

  // A ban (or other fatal condition) ends the session for good.
  const { release } = media;
  useEffect(() => {
    if (state.fatal) release();
  }, [state.fatal, release]);

  if (!inRoom || state.fatal) {
    return (
      <Landing
        onStart={(prefs) => void start(prefs)}
        busy={starting}
        error={mediaError?.text ?? null}
        suggestVoiceOnly={mediaError?.suggestVoiceOnly ?? false}
        onlineCount={state.onlineCount}
        signaling={state.signaling}
        fatal={state.fatal}
      />
    );
  }

  return (
    <ChatRoom
      state={state}
      mode={mode}
      media={media}
      onNext={() => controller.next()}
      onStop={stop}
      onSend={(text) => controller.sendChat(text)}
      onReport={(reason) => controller.report(reason)}
      onDismissNotice={() => controller.dismissNotice()}
    />
  );
}
