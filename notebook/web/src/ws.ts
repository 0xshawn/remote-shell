import type { Cell, NbServerMsg, SessionStatus } from './types';
import { getToken } from './api';

// Per-session client state. `snapshot` is an immutable record handed to React
// via useSyncExternalStore; it is recreated (new reference) on each flush so
// React re-renders, while streaming deltas are coalesced to one flush per frame.
interface ClientSession {
  cells: Cell[];
  index: Map<string, number>; // cell id -> position in cells
  status: SessionStatus;
  seq: number;
  snapshot: SessionSnapshot;
}

export interface SessionSnapshot {
  cells: Cell[];
  status: SessionStatus;
  connected: boolean;
}

type Listener = () => void;

const EMPTY: SessionSnapshot = { cells: [], status: 'idle', connected: false };

// ============================================================================
// NbClient: a single multiplexed WebSocket to /nbws for all claude sessions.
// ============================================================================
class NbClient {
  private ws: WebSocket | null = null;
  private connected = false;
  private reconnectDelay = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private sessions = new Map<string, ClientSession>();
  private listeners = new Map<string, Set<Listener>>();
  private attached = new Set<string>(); // sessions to (re)attach on connect
  private dirty = new Set<string>();
  private flushScheduled = false;

  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}/nbws?token=${encodeURIComponent(getToken())}`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      this.reconnectDelay = 1000;
      // Re-attach every session we care about; server replies with fresh snapshots.
      for (const id of this.attached) this.sendRaw({ cmd: 'attach', sessionId: id });
      this.markAllDirty();
    };
    ws.onmessage = (ev) => {
      const data = typeof ev.data === 'string' ? ev.data : '';
      if (data[0] !== '1') return;
      let msg: NbServerMsg;
      try { msg = JSON.parse(data.slice(1)); } catch { return; }
      this.handle(msg);
    };
    ws.onclose = () => {
      this.connected = false;
      this.ws = null;
      this.markAllDirty();
      this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, 10000);
    };
    ws.onerror = () => { /* onclose drives the retry */ };
  }

  private sendRaw(obj: Record<string, unknown>) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send('1' + JSON.stringify(obj));
  }

  private ensure(id: string): ClientSession {
    let s = this.sessions.get(id);
    if (!s) {
      s = { cells: [], index: new Map(), status: 'idle', seq: 0, snapshot: EMPTY };
      this.sessions.set(id, s);
    }
    return s;
  }

  private handle(msg: NbServerMsg) {
    if (msg.type === 'error') { console.warn('nbws error:', msg.message); return; }
    if (!('sessionId' in msg) || !msg.sessionId) return;
    const s = this.ensure(msg.sessionId);
    switch (msg.type) {
      case 'snapshot':
        s.cells = msg.cells.slice();
        s.index = new Map(s.cells.map((c, i) => [c.id, i]));
        s.status = msg.status;
        s.seq = msg.seq;
        break;
      case 'cell':
        if (msg.op === 'add') {
          if (!s.index.has(msg.cell.id)) { s.index.set(msg.cell.id, s.cells.length); s.cells.push(msg.cell); }
          else s.cells[s.index.get(msg.cell.id)!] = msg.cell;
        } else {
          const i = s.index.get(msg.cell.id);
          if (i != null) s.cells[i] = msg.cell;
          else { s.index.set(msg.cell.id, s.cells.length); s.cells.push(msg.cell); }
        }
        s.seq = msg.seq;
        break;
      case 'status':
        s.status = msg.status;
        break;
      case 'session_ended':
        s.status = 'exited';
        break;
    }
    this.markDirty(msg.sessionId);
  }

  private markDirty(id: string) {
    this.dirty.add(id);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    const flush = () => {
      this.flushScheduled = false;
      const ids = [...this.dirty];
      this.dirty.clear();
      for (const id2 of ids) {
        const s = this.sessions.get(id2);
        if (!s) continue;
        // New array reference per flush so useSyncExternalStore re-renders.
        s.snapshot = { cells: s.cells.slice(), status: s.status, connected: this.connected };
        const ls = this.listeners.get(id2);
        if (ls) for (const fn of ls) fn();
      }
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flush);
    else setTimeout(flush, 16);
  }

  private markAllDirty() {
    for (const id of this.sessions.keys()) this.markDirty(id);
  }

  // ---- public API used by components ----
  attach(id: string) {
    this.attached.add(id);
    this.ensure(id);
    this.sendRaw({ cmd: 'attach', sessionId: id });
  }
  detach(id: string) {
    this.attached.delete(id);
    this.sendRaw({ cmd: 'detach', sessionId: id });
  }
  turn(id: string, text: string) { this.sendRaw({ cmd: 'turn', sessionId: id, text }); }
  interrupt(id: string) { this.sendRaw({ cmd: 'interrupt', sessionId: id }); }
  kill(id: string) { this.sendRaw({ cmd: 'kill', sessionId: id }); }

  // ---- useSyncExternalStore glue ----
  subscribe(id: string, fn: Listener): () => void {
    let set = this.listeners.get(id);
    if (!set) { set = new Set(); this.listeners.set(id, set); }
    set.add(fn);
    return () => { set!.delete(fn); };
  }
  getSnapshot(id: string): SessionSnapshot {
    return this.sessions.get(id)?.snapshot ?? EMPTY;
  }
}

export const nb = new NbClient();
