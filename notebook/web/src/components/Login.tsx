import { useState } from 'react';
import { login, setToken } from '../api';

export function Login({ onSuccess }: { onSuccess: () => void }) {
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [err, setErr] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr('');
    try {
      const token = await login(user, pass);
      setToken(token);
      onSuccess();
    } catch {
      setErr('Invalid credentials');
    }
  }

  return (
    <div className="login-overlay">
      <form className="login-form" onSubmit={submit}>
        <h2>notebook</h2>
        {err && <p className="err">{err}</p>}
        <input placeholder="Username" autoComplete="username" autoCapitalize="off"
          value={user} onChange={(e) => setUser(e.target.value)} />
        <input placeholder="Password" type="password" autoComplete="current-password"
          value={pass} onChange={(e) => setPass(e.target.value)} />
        <button className="primary" type="submit">Sign in</button>
      </form>
    </div>
  );
}
