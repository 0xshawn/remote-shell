import { getToken } from './api';

export type ShellState = 'connecting' | 'online' | 'offline';

interface ShellHooks {
  onData: (data: string) => void;       // raw PTY bytes -> write to xterm
  onState: (s: ShellState) => void;
  getSize: () => { cols: number; rows: number };
}

// ============================================================================
// ShellConnection: one /ws connection for a single shell tab, with the same
// auto-reconnect/backoff behavior as the original remote-shell client.
// Wire protocol: '0'<data> = I/O, '1'<json> = control/events.
// ============================================================================
export class ShellConnection {
  private ws: WebSocket | null = null;
  private reconnectDelay = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(private sessionId: string, private hooks: ShellHooks) {}

  private url(): string {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const { cols, rows } = this.hooks.getSize();
    const params = new URLSearchParams({
      token: getToken(), session: this.sessionId, cols: String(cols), rows: String(rows),
    });
    return `${proto}//${location.host}/ws?${params.toString()}`;
  }

  connect() {
    this.closed = false;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.hooks.onState('connecting');
    const ws = new WebSocket(this.url());
    this.ws = ws;
    ws.onopen = () => {
      this.reconnectDelay = 1000;
      this.hooks.onState('online');
      this.sendResize();
    };
    ws.onmessage = (ev) => {
      const msg = typeof ev.data === 'string' ? ev.data : '';
      if (msg[0] === '0') this.hooks.onData(msg.slice(1));
      // '1' control events (session/error/ended) are not surfaced in v1.
    };
    ws.onclose = () => {
      this.hooks.onState('offline');
      if (this.closed) return;
      this.hooks.onState('connecting');
      this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, 10000);
    };
    ws.onerror = () => { /* onclose drives retry */ };
  }

  private send(op: string, data: string) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(op + data);
  }
  input(data: string) { this.send('0', data); }
  sendResize() {
    const { cols, rows } = this.hooks.getSize();
    this.send('1', JSON.stringify({ cmd: 'resize', cols, rows }));
  }
  kill() { this.send('1', JSON.stringify({ cmd: 'kill' })); }

  close() {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) { try { this.ws.close(); } catch { /* ignore */ } }
  }
}
