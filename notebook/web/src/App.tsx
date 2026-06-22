import { useEffect, useState } from 'react';
import { getToken, setToken, verifyToken, listSessions, createClaudeSession, deleteSession } from './api';
import type { SessionSummary } from './types';
import { nb } from './ws';
import { Login } from './components/Login';
import { Tabs } from './components/Tabs';
import { ShellView } from './components/ShellView';
import { NotebookView } from './components/NotebookView';
import { NewSessionDialog, type NewSessionOpts } from './components/NewSessionDialog';

export function App() {
  // null = still verifying the saved token
  const [authed, setAuthed] = useState<boolean | null>(null);

  useEffect(() => {
    (async () => {
      if (getToken() && (await verifyToken())) { setAuthed(true); nb.connect(); }
      else setAuthed(false);
    })();
  }, []);

  if (authed === null) return <div className="center-msg">…</div>;
  if (!authed) return <Login onSuccess={() => { setAuthed(true); nb.connect(); }} />;
  return <Main onLogout={() => { setToken(''); setAuthed(false); }} />;
}

function Main({ onLogout }: { onLogout: () => void }) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeId, setActiveId] = useState<string>('');
  const [showNew, setShowNew] = useState(false);

  // Initial load: list existing sessions; ensure a default shell tab and land on it.
  useEffect(() => {
    (async () => {
      const list = await listSessions();
      let tabs = list;
      if (!tabs.some((t) => t.kind === 'shell')) {
        tabs = [{ id: 'main', kind: 'shell', label: 'shell' }, ...tabs];
      }
      setSessions(tabs);
      const firstShell = tabs.find((t) => t.kind === 'shell');
      setActiveId((firstShell ?? tabs[0])?.id ?? '');
    })();
  }, []);

  async function newClaude(opts: NewSessionOpts) {
    setShowNew(false);
    try {
      const s = await createClaudeSession(opts);
      setSessions((prev) => [...prev, s]);
      setActiveId(s.id);
    } catch (e) {
      alert((e as Error).message);
    }
  }

  function newShell() {
    const id = 's' + Math.random().toString(36).slice(2, 8);
    setSessions((prev) => [...prev, { id, kind: 'shell', label: 'shell' }]);
    setActiveId(id);
  }

  async function closeTab(id: string) {
    const tab = sessions.find((t) => t.id === id);
    if (!tab) return;
    if (tab.kind === 'claude') nb.kill(id);
    await deleteSession(id).catch(() => {});
    setSessions((prev) => {
      const next = prev.filter((t) => t.id !== id);
      if (activeId === id) setActiveId(next[next.length - 1]?.id ?? '');
      return next;
    });
  }

  const active = sessions.find((t) => t.id === activeId);
  const shellTabs = sessions.filter((t) => t.kind === 'shell');

  return (
    <div className="app">
      <div className="topbar">
        <span className="title">notebook</span>
        <Tabs sessions={sessions} activeId={activeId} onSelect={setActiveId} onClose={closeTab} />
        <button onClick={newShell} title="New shell tab">+ Shell</button>
        <button className="primary" onClick={() => setShowNew(true)} title="New Claude session">+ Claude</button>
        <button onClick={onLogout} title="Log out">Logout</button>
      </div>
      <div className="main">
        {/* Shell tabs stay mounted (hidden when inactive) so their terminals persist. */}
        {shellTabs.map((t) => (
          <ShellView key={t.id} sessionId={t.id} active={t.id === activeId} />
        ))}
        {active?.kind === 'claude' && <NotebookView key={active.id} session={active} />}
        {!active && <div className="center-msg">No tab open. Start a shell or a Claude session above.</div>}
      </div>
      {showNew && <NewSessionDialog onCreate={newClaude} onCancel={() => setShowNew(false)} />}
    </div>
  );
}
