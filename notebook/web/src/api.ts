import type { SessionSummary } from './types';

const TOKEN_KEY = 'nb_token';

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) || '';
}
export function setToken(t: string) {
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
}

function authHeaders(): HeadersInit {
  const t = getToken();
  return t ? { Authorization: 'Bearer ' + t } : {};
}

export async function login(username: string, password: string): Promise<string> {
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error('invalid credentials');
  const data = await res.json();
  return data.token as string;
}

// Returns true if the current token is valid; false if it was rejected.
export async function verifyToken(): Promise<boolean> {
  const t = getToken();
  if (!t) return false;
  try {
    const res = await fetch('/api/me', { headers: authHeaders() });
    if (res.status === 401) { setToken(''); return false; }
    return res.ok;
  } catch {
    return true; // network blip: don't bounce to login
  }
}

export async function listSessions(): Promise<SessionSummary[]> {
  const res = await fetch('/api/sessions', { headers: authHeaders() });
  if (!res.ok) return [];
  return res.json();
}

export async function createClaudeSession(opts: {
  cwd?: string; permissionMode?: string; label?: string; env?: string[];
} = {}): Promise<SessionSummary> {
  const res = await fetch('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ kind: 'claude', ...opts }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'failed to create session');
  return res.json();
}

export async function deleteSession(id: string): Promise<void> {
  await fetch('/api/sessions/' + encodeURIComponent(id), { method: 'DELETE', headers: authHeaders() });
}
