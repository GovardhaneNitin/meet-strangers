import { useEffect, useRef, useState, type FormEvent } from 'react';
import { LIMITS } from '@meet-strangers/shared';
import type { ChatEntry } from '../lib/chatController';
import { SendIcon } from './Icons';

interface ChatPanelProps {
  messages: ChatEntry[];
  enabled: boolean;
  onSend: (text: string) => boolean;
}

/**
 * Text chat with the current stranger. Messages are rendered as plain text
 * (React escapes them), and links are deliberately not made clickable:
 * phishing links are a common abuse pattern on anonymous chat services.
 */
export function ChatPanel({ messages, enabled, onSend }: ChatPanelProps) {
  const [draft, setDraft] = useState('');
  const listRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [messages]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (draft.trim() && onSend(draft)) setDraft('');
  };

  return (
    <section className="chat-panel" aria-label="Text chat">
      <ol className="chat-panel__messages" ref={listRef} aria-live="polite">
        {messages.map((message) => (
          <li key={message.id} className={`chat-message chat-message--${message.from}`}>
            {message.from !== 'system' && (
              <span className="chat-message__author">
                {message.from === 'me' ? 'You' : 'Stranger'}
              </span>
            )}
            <span className="chat-message__text">{message.text}</span>
          </li>
        ))}
      </ol>
      <form className="chat-panel__composer" onSubmit={submit}>
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          maxLength={LIMITS.MAX_CHAT_MESSAGE_LENGTH}
          placeholder={enabled ? 'Type a message…' : 'Chat opens when you are connected'}
          disabled={!enabled}
          aria-label="Message"
          autoComplete="off"
          enterKeyHint="send"
        />
        <button
          type="submit"
          className="button button--icon button--primary"
          disabled={!enabled || draft.trim() === ''}
          aria-label="Send message"
        >
          <SendIcon />
        </button>
      </form>
    </section>
  );
}
