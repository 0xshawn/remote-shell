import type { SessionStatus } from '../types';

const LABEL: Record<SessionStatus, string> = {
  idle: 'idle',
  running: 'running…',
  waiting_input: 'waiting',
  error: 'error',
  exited: 'ended',
};

export function StatusBadge({ status, connected }: { status: SessionStatus; connected: boolean }) {
  if (!connected) return <span className="status offline">offline</span>;
  return <span className={'status ' + status}>{LABEL[status] ?? status}</span>;
}
