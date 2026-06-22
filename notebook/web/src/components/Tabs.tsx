import { useSyncExternalStore } from 'react';
import type { SessionSummary, SessionStatus } from '../types';
import { nb } from '../ws';

interface Props {
  sessions: SessionSummary[];
  activeId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
}

export function Tabs({ sessions, activeId, onSelect, onClose }: Props) {
  return (
    <div className="tabs">
      {sessions.map((s) => (
        <TabItem
          key={s.id}
          session={s}
          active={s.id === activeId}
          onSelect={() => onSelect(s.id)}
          onClose={() => onClose(s.id)}
        />
      ))}
    </div>
  );
}

function TabItem({ session, active, onSelect, onClose }: {
  session: SessionSummary; active: boolean; onSelect: () => void; onClose: () => void;
}) {
  return (
    <div
      className={'tab' + (active ? ' active' : '')}
      onClick={onSelect}
      title={session.kind === 'claude' ? `${session.label} (${session.cwd ?? ''})` : session.label}
    >
      {session.kind === 'claude'
        ? <ClaudeDot id={session.id} />
        : <span className="kind">$</span>}
      <span className="tab-label">{session.label}</span>
      <button className="close" title="Close" onClick={(e) => { e.stopPropagation(); onClose(); }}>×</button>
    </div>
  );
}

// Live status dot for a claude tab, even when the tab is not the active view.
function ClaudeDot({ id }: { id: string }) {
  const snap = useSyncExternalStore(
    (cb) => nb.subscribe(id, cb),
    () => nb.getSnapshot(id),
  );
  const status: SessionStatus = snap.status;
  return <span className={'tab-dot ' + status} title={status} />;
}
