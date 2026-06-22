import { useLayoutEffect, useRef, useState } from 'react';

interface Props {
  running: boolean;
  onSend: (text: string) => void;
  onInterrupt: () => void;
}

export function Composer({ running, onSend, onInterrupt }: Props) {
  const [text, setText] = useState('');
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Auto-grow the textarea with content, up to the CSS max-height.
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
  }, [text]);

  function send() {
    const t = text.trim();
    if (!t || running) return;
    onSend(t);
    setText('');
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <div className="composer">
      <textarea
        ref={taRef}
        placeholder={running ? 'Claude is working…  (Stop to interrupt)' : 'Message Claude   ·   Enter to send, Shift+Enter for newline'}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        rows={1}
      />
      {running
        ? <button className="danger send" onClick={onInterrupt}>Stop</button>
        : <button className="primary send" onClick={send} disabled={!text.trim()}>Send</button>}
    </div>
  );
}
