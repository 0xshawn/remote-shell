'use strict';

// ============================================================================
// NotebookStore
//
// Per-session ordered list of normalized cells. The server OWNS notebook
// history here (independent of any live `claude` child), so a page refresh or
// WS reconnect just replays this list. Every mutation bumps a monotonic `seq`
// and notifies subscribers with a small patch, so the frontend can apply
// incremental updates after the initial snapshot.
// ============================================================================

const MAX_CELLS = 5000; // safety cap so a runaway session can't grow unbounded

class NotebookStore {
  constructor() {
    this.cells = [];
    this.byId = new Map();
    this.seq = 0;
    this._idCounter = 0;
    this.subscribers = new Set();
  }

  // Add a new cell. Assigns an id (if absent) and a seq, then emits 'add'.
  add(cell) {
    if (!cell.id) cell.id = `cell-${++this._idCounter}`;
    if (!cell.ts) cell.ts = Date.now();
    cell.seq = ++this.seq;
    this.cells.push(cell);
    this.byId.set(cell.id, cell);
    if (this.cells.length > MAX_CELLS) {
      const dropped = this.cells.shift();
      this.byId.delete(dropped.id);
    }
    this._emit('add', cell);
    return cell;
  }

  // Mark an already-mutated cell as changed: bump seq and emit 'update'.
  update(cell) {
    if (!cell || !this.byId.has(cell.id)) return cell;
    cell.seq = ++this.seq;
    this._emit('update', cell);
    return cell;
  }

  get(id) {
    return this.byId.get(id);
  }

  // Full current state, used to seed a freshly-attached client.
  snapshot() {
    return { cells: this.cells, seq: this.seq };
  }

  subscribe(fn) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  _emit(op, cell) {
    for (const fn of this.subscribers) {
      try { fn({ op, cell, seq: this.seq }); } catch { /* a bad subscriber must not break others */ }
    }
  }
}

module.exports = { NotebookStore, MAX_CELLS };
