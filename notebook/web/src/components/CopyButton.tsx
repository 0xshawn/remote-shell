import { useState } from 'react';

export function CopyButton({ text, title = 'Copy' }: { text: string; title?: string }) {
  const [copied, setCopied] = useState(false);
  async function copy(e: React.MouseEvent) {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch { /* clipboard blocked */ }
  }
  return (
    <button className="copy-btn" title={title} onClick={copy}>
      {copied ? '✓' : '⧉'}
    </button>
  );
}
