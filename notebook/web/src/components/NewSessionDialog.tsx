import { useState } from 'react';

export interface NewSessionOpts {
  label?: string;
  cwd?: string;
  permissionMode?: string;
  env?: string[];
}

const MODES = ['acceptEdits', 'default', 'auto', 'bypassPermissions'];

export function NewSessionDialog({ onCreate, onCancel }: {
  onCreate: (opts: NewSessionOpts) => void;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState('');
  const [cwd, setCwd] = useState('');
  const [mode, setMode] = useState('acceptEdits');
  const [env, setEnv] = useState('');

  function submit(e: React.FormEvent) {
    e.preventDefault();
    // One KEY=VALUE per line; blanks and lines without '=' are dropped.
    const envPairs = env.split('\n').map((l) => l.trim()).filter((l) => l.includes('='));
    onCreate({
      label: label.trim() || undefined,
      cwd: cwd.trim() || undefined,
      permissionMode: mode,
      env: envPairs.length ? envPairs : undefined,
    });
  }

  return (
    <div className="login-overlay" onMouseDown={onCancel}>
      <form className="login-form dialog" onMouseDown={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>New Claude session</h2>
        <label className="field">
          <span>Label</span>
          <input value={label} placeholder="optional" onChange={(e) => setLabel(e.target.value)} autoFocus />
        </label>
        <label className="field">
          <span>Working directory</span>
          <input value={cwd} placeholder="server default" onChange={(e) => setCwd(e.target.value)} />
        </label>
        <label className="field">
          <span>Permission mode</span>
          <select value={mode} onChange={(e) => setMode(e.target.value)}>
            {MODES.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Environment</span>
          <textarea
            value={env}
            rows={3}
            placeholder={'KEY=VALUE per line\ne.g. FOO=bar'}
            spellCheck={false}
            onChange={(e) => setEnv(e.target.value)}
          />
        </label>
        <div className="dialog-actions">
          <button type="button" onClick={onCancel}>Cancel</button>
          <button type="submit" className="primary">Create</button>
        </div>
      </form>
    </div>
  );
}
