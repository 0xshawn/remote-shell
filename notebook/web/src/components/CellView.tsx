import { useState } from 'react';
import type { Cell } from '../types';
import { Markdown } from './Markdown';
import { CopyButton } from './CopyButton';

export function CellView({ cell }: { cell: Cell }) {
  switch (cell.kind) {
    case 'system': return <SystemCell cell={cell} />;
    case 'user': return <UserCell cell={cell} />;
    case 'assistant_text': return <AssistantCell cell={cell} />;
    case 'thinking': return <ThinkingCell cell={cell} />;
    case 'tool_call': return <ToolCell cell={cell} />;
    case 'result': return <ResultCell cell={cell} />;
    case 'error': return <ErrorCell cell={cell} />;
    default: return null;
  }
}

function Avatar({ who }: { who: 'user' | 'claude' }) {
  return <div className={'avatar ' + who}>{who === 'user' ? 'You' : 'C'}</div>;
}

function SystemCell({ cell }: { cell: Cell }) {
  return (
    <div className="cell cell-system">
      <span className="dot" /> Claude session started · {cell.model ?? 'default model'}
      {cell.permissionMode ? ` · ${cell.permissionMode}` : ''}
      {cell.cwd ? ` · ${cell.cwd}` : ''}
    </div>
  );
}

function UserCell({ cell }: { cell: Cell }) {
  return (
    <div className="cell cell-row cell-user">
      <Avatar who="user" />
      <div className="bubble">
        <div className="body">{cell.text}</div>
      </div>
    </div>
  );
}

function AssistantCell({ cell }: { cell: Cell }) {
  const text = cell.text ?? '';
  return (
    <div className="cell cell-row cell-assistant">
      <Avatar who="claude" />
      <div className="bubble">
        {/* While streaming, render fast plain text (incomplete markdown looks
            broken); once finalized, render rich markdown. */}
        {cell.streaming
          ? <div className="body stream">{text}<span className="cursor">▍</span></div>
          : <Markdown text={text} />}
        {!cell.streaming && text.trim() && <CopyButton text={text} title="Copy reply" />}
      </div>
    </div>
  );
}

function ThinkingCell({ cell }: { cell: Cell }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="cell cell-thinking">
      <div className="think-head" onClick={() => setOpen((v) => !v)}>
        <span>💭 Thinking{cell.streaming ? '…' : ''}</span>
        <span className="chev">{open ? '▾' : '▸'}</span>
      </div>
      {open && <div className="think-body">{cell.text}{cell.streaming && <span className="cursor">▍</span>}</div>}
    </div>
  );
}

function prettyInput(cell: Cell): string {
  if (cell.input && typeof cell.input === 'object') {
    try { return JSON.stringify(cell.input, null, 2); } catch { /* fall through */ }
  }
  return cell.inputPartial || '';
}

function oneLineArg(cell: Cell): string {
  if (cell.input && typeof cell.input === 'object') {
    const o = cell.input as Record<string, unknown>;
    const v = o.command ?? o.file_path ?? o.path ?? o.pattern ?? o.url ?? o.query ?? o.description;
    if (v != null) return String(v);
    try { return JSON.stringify(o); } catch { return ''; }
  }
  return cell.inputPartial || '';
}

function ToolCell({ cell }: { cell: Cell }) {
  const [open, setOpen] = useState(false);
  const status = cell.status ?? 'pending';
  const busy = status === 'streaming' || status === 'pending';
  return (
    <div className={'cell cell-tool' + (cell.isError ? ' err' : '')}>
      <div className="tool-head" onClick={() => setOpen((v) => !v)}>
        <span className="chev">{open ? '▾' : '▸'}</span>
        <span className="tool-name">{cell.name}</span>
        <span className="tool-arg mono">{oneLineArg(cell)}</span>
        {busy ? <span className="spinner" /> : <span className={'badge ' + status}>{status}</span>}
      </div>
      {open && (
        <div className="tool-body">
          <div className="tool-section-label">
            input <CopyButton text={prettyInput(cell)} title="Copy input" />
          </div>
          <pre className="mono">{prettyInput(cell)}</pre>
        </div>
      )}
      {cell.result != null && (
        <div className="tool-result">
          <div className="tool-section-label">
            result <CopyButton text={cell.result} title="Copy result" />
          </div>
          <pre className="mono">{cell.result}</pre>
        </div>
      )}
    </div>
  );
}

function ResultCell({ cell }: { cell: Cell }) {
  const cost = typeof cell.costUsd === 'number' ? `$${cell.costUsd.toFixed(4)}` : null;
  const dur = typeof cell.durationMs === 'number' ? `${(cell.durationMs / 1000).toFixed(1)}s` : null;
  return (
    <div className={'cell cell-result' + (cell.isError ? ' err' : '')}>
      <span className="hr" />
      <span className="label">
        {cell.isError ? '✗ turn ended with error' : '✓ turn complete'}
        {cell.numTurns != null ? ` · ${cell.numTurns} turn(s)` : ''}
        {dur ? ` · ${dur}` : ''}
        {cost ? ` · ${cost}` : ''}
      </span>
      <span className="hr" />
    </div>
  );
}

function ErrorCell({ cell }: { cell: Cell }) {
  return <div className="cell cell-error">⚠ {cell.message}</div>;
}
