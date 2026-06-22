import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { SessionSummary } from '../types';
import { nb } from '../ws';
import { CellView } from './CellView';
import { Composer } from './Composer';
import { StatusBadge } from './StatusBadge';

export function NotebookView({ session }: { session: SessionSummary }) {
  const id = session.id;

  // Attach once; we intentionally do NOT detach on unmount so a backgrounded
  // session keeps streaming into the client store and is current on return.
  useEffect(() => { nb.attach(id); }, [id]);

  const snap = useSyncExternalStore(
    (cb) => nb.subscribe(id, cb),
    () => nb.getSnapshot(id),
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const [pinned, setPinned] = useState(true);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    atBottomRef.current = atBottom;
    setPinned(atBottom);
  }

  function scrollToBottom() {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }

  // Keep pinned to the bottom while new content streams, unless the user scrolled up.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [snap]);

  return (
    <div className="view">
      <div className="notebook">
        <div className="nb-head">
          <strong>{session.label}</strong>
          <StatusBadge status={snap.status} connected={snap.connected} />
          <span className="spacer" style={{ flex: 1 }} />
          {session.model && <span className="status idle">{session.model}</span>}
        </div>
        <div className="nb-cells" ref={scrollRef} onScroll={onScroll}>
          {snap.cells.length === 0 && (
            <div className="center-msg">Send a message to start this Claude session.</div>
          )}
          {snap.cells.map((c) => <CellView key={c.id} cell={c} />)}
        </div>
        {!pinned && (
          <button className="scroll-bottom" title="Scroll to bottom" onClick={scrollToBottom}>↓</button>
        )}
        <Composer
          running={snap.status === 'running'}
          onSend={(t) => nb.turn(id, t)}
          onInterrupt={() => nb.interrupt(id)}
        />
      </div>
    </div>
  );
}
