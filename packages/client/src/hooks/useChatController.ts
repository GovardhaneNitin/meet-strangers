import { useEffect, useState, useSyncExternalStore } from 'react';
import { ChatController, type ChatState } from '../lib/chatController';
import { defaultSignalingUrl } from '../lib/signaling';

/** One controller per app lifetime; connects on mount, tears down on unmount. */
export function useChatController(): [ChatController, ChatState] {
  const [controller] = useState(() => new ChatController(defaultSignalingUrl()));

  useEffect(() => {
    controller.connect();
    return () => controller.dispose();
  }, [controller]);

  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  return [controller, state];
}
