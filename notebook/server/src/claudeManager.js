'use strict';

const crypto = require('crypto');
const path = require('path');
const logger = require('./logger');
const { NotebookStore } = require('./notebookStore');
const { Normalizer } = require('./normalizer');
const { ClaudeProcess } = require('./claudeProcess');

// POSIX single-quote a string for safe embedding in a remote shell command.
function shq(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

// Parse `KEY=VALUE` lines/pairs into an object (ignores blanks and bad lines).
function parseEnvPairs(pairs) {
  const out = {};
  for (const p of pairs || []) {
    const i = String(p).indexOf('=');
    if (i <= 0) continue;
    out[String(p).slice(0, i).trim()] = String(p).slice(i + 1);
  }
  return out;
}

// ============================================================================
// ClaudeManager
//
// One record per Claude session. Session identity is a UUID (used as claude's
// --session-id / --resume id). History lives in the per-session NotebookStore
// on the SERVER, independent of any live child, so reconnect just replays it.
//
// Lifecycle = per-turn: each user turn spawns a fresh `claude --print` child
// (first turn --session-id, later turns --resume), streams its events through
// the normalizer into the store, and exits on `result`. A dead child between
// turns is normal, not an error.
// ============================================================================
class ClaudeManager {
  constructor(config) {
    this.config = config;
    this.cfg = config.claude;
    this.sessions = new Map(); // id -> record
    this._sweeper = setInterval(() => this._sweep(), 60 * 1000);
    this._sweeper.unref();
  }

  _summary(rec) {
    return {
      id: rec.id,
      kind: 'claude',
      label: rec.label,
      status: rec.status,
      cwd: rec.cwd,
      model: rec.model || null,
      permissionMode: rec.permissionMode,
      createdAt: rec.createdAt,
    };
  }

  _countFor(user) {
    let n = 0;
    for (const r of this.sessions.values()) if (r.user === user) n++;
    return n;
  }

  list(user) {
    return [...this.sessions.values()].filter((r) => r.user === user).map((r) => this._summary(r));
  }

  // Look up a record, enforcing ownership.
  get(id, user) {
    const rec = this.sessions.get(id);
    if (rec && rec.user === user) return rec;
    return null;
  }

  createSession(user, opts = {}) {
    if (this.cfg.maxSessions > 0 && this._countFor(user) >= this.cfg.maxSessions) {
      throw new Error('maximum number of claude sessions reached');
    }
    const id = crypto.randomUUID();
    const store = new NotebookStore();
    const rec = {
      id,
      user,
      label: (opts.label && String(opts.label).slice(0, 80)) || `Claude ${id.slice(0, 8)}`,
      cwd: opts.cwd || this.cfg.cwd,
      model: opts.model || this.cfg.model || '',
      permissionMode: opts.permissionMode || this.cfg.permissionMode,
      // Global claude env overlaid with per-session env from the New Session dialog.
      env: { ...this.cfg.env, ...parseEnvPairs(opts.env) },
      status: 'idle',
      store,
      child: null,
      started: false,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      subscribers: new Set(),
    };
    rec.normalizer = new Normalizer(store, { onStatus: (s) => this._setStatus(rec, s) });
    // Every store mutation is broadcast to attached clients as a cell patch.
    store.subscribe(({ op, cell }) =>
      this._broadcast(rec, { type: 'cell', sessionId: id, op, seq: cell.seq, cell }));
    this.sessions.set(id, rec);
    logger.info(`created claude session ${id} user=${user} model=${rec.model || '(default)'} mode=${rec.permissionMode}`);
    return this._summary(rec);
  }

  _setStatus(rec, status) {
    rec.status = status;
    rec.lastActivity = Date.now();
    this._broadcast(rec, { type: 'status', sessionId: rec.id, status });
  }

  attach(rec, ws) {
    rec.subscribers.add(ws);
    rec.lastActivity = Date.now();
    const snap = rec.store.snapshot();
    try {
      ws.send('1' + JSON.stringify({
        type: 'snapshot', sessionId: rec.id, status: rec.status, seq: snap.seq, cells: snap.cells,
      }));
    } catch { /* ws closing */ }
  }

  detach(rec, ws) {
    rec.subscribers.delete(ws);
  }

  detachAll(ws) {
    for (const rec of this.sessions.values()) rec.subscribers.delete(ws);
  }

  _broadcast(rec, msg) {
    const frame = '1' + JSON.stringify(msg);
    for (const ws of rec.subscribers) {
      try { ws.send(frame); } catch { /* ignore a closing client */ }
    }
  }

  _buildArgs(rec) {
    const a = [
      '--print',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--replay-user-messages',
      '--verbose',
    ];
    a.push(rec.started ? '--resume' : '--session-id', rec.id);
    a.push('--permission-mode', rec.permissionMode);
    if (rec.model) a.push('--model', rec.model);
    if (Array.isArray(this.cfg.extraArgs)) a.push(...this.cfg.extraArgs);
    return a;
  }

  // How to spawn the claude child for this turn. With SSH configured (the Docker
  // deployment), claude runs on the HOST as the SSH user so it uses the host's
  // real environment + ~/.claude config; otherwise it runs locally.
  _spawnSpec(rec) {
    const claudeArgs = this._buildArgs(rec);
    const s = this.config.ssh;
    if (s && s.host) {
      return { command: 'ssh', args: this._sshArgs(this._remoteClaudeCmd(rec, claudeArgs)), cwd: undefined, env: {} };
    }
    return { command: this.cfg.command, args: claudeArgs, cwd: rec.cwd, env: rec.env };
  }

  // Build the single remote command string run on the host via `ssh`. cwd, env,
  // and every arg are POSIX-quoted; the claude binary's own directory is put on
  // PATH so a co-located node (e.g. an nvm install) is found.
  _remoteClaudeCmd(rec, claudeArgs) {
    const cmd = this.cfg.command;
    const assigns = [];
    if (path.isAbsolute(cmd)) assigns.push(`PATH=${shq(path.dirname(cmd))}:$PATH`);
    for (const [k, v] of Object.entries(rec.env || {})) assigns.push(`${k}=${shq(v)}`);
    return [`cd ${shq(rec.cwd)} &&`, 'exec', 'env', ...assigns, shq(cmd), ...claudeArgs.map(shq)].join(' ');
  }

  // ssh options for a clean, non-interactive stream: -T (no TTY) keeps stdout a
  // raw pipe so the stream-json output is not mangled.
  _sshArgs(remoteCmd) {
    const s = this.config.ssh;
    const args = [
      '-T',
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'ServerAliveInterval=30',
      '-o', 'ServerAliveCountMax=3',
    ];
    if (s.port && s.port !== 22) args.push('-p', String(s.port));
    if (s.key) args.push('-i', s.key);
    args.push(`${s.user}@${s.host}`, remoteCmd);
    return args;
  }

  sendTurn(id, user, text) {
    const rec = this.get(id, user);
    if (!rec) throw new Error('no such session');
    if (rec.status === 'running') throw new Error('session is busy');
    if (!String(text || '').trim()) throw new Error('empty turn');

    // Optimistic user cell (the manager owns this; the normalizer ignores the
    // isReplay echo). Broadcast happens via the store subscription.
    rec.store.add({ kind: 'user', text: String(text) });
    this._setStatus(rec, 'running');

    const captureFile = this.cfg.captureDir ? path.join(this.cfg.captureDir, `${rec.id}.jsonl`) : null;
    const spec = this._spawnSpec(rec);
    const child = new ClaudeProcess(
      { command: spec.command, args: spec.args, cwd: spec.cwd, env: spec.env, captureFile },
      {
        onEvent: (o) => rec.normalizer.handle(o),
        onExit: (code, signal) => this._onChildExit(rec, code, signal),
        onError: (err) => rec.store.add({ kind: 'error', message: `failed to start claude: ${err.message}` }),
      },
    );
    rec.child = child;
    rec.started = true;
    child.start();
    child.write(text);
    child.endInput(); // per-turn: signal no more input so the child finishes & exits
  }

  _onChildExit(rec, code, signal) {
    const tail = rec.child ? rec.child.stderrTail : '';
    rec.child = null;
    if (!this.sessions.has(rec.id)) return; // session was deleted; nothing to report
    // A user-requested interrupt is expected, not an error: just return to idle.
    if (rec.interrupting) {
      rec.interrupting = false;
      if (rec.status === 'running') this._setStatus(rec, 'idle');
      return;
    }
    // `result` normally drives status to idle/error first. If the child died
    // without a terminal result while we still think it's running, surface it.
    if (rec.status === 'running') {
      if (code && code !== 0) {
        rec.store.add({
          kind: 'error',
          message: `claude exited code=${code}${signal ? ' signal=' + signal : ''}` + (tail ? `\n${tail.slice(-2000)}` : ''),
        });
        this._setStatus(rec, 'error');
      } else {
        // Exited cleanly but no result (e.g. interrupted): return to idle.
        this._setStatus(rec, 'idle');
      }
    }
  }

  interrupt(id, user) {
    const rec = this.get(id, user);
    if (!rec || !rec.child) return;
    rec.interrupting = true;
    rec.store.add({ kind: 'error', message: 'interrupted' });
    rec.child.interrupt();
  }

  deleteSession(id, user) {
    const rec = this.get(id, user);
    if (!rec) return;
    if (rec.child) { try { rec.child.kill(); } catch { /* ignore */ } }
    this._broadcast(rec, { type: 'session_ended', sessionId: id });
    this.sessions.delete(id);
    logger.info(`deleted claude session ${id}`);
  }

  // Reap idle sessions with no attached clients past the configured timeout.
  _sweep() {
    const minutes = this.cfg.idleTimeout;
    if (!minutes || minutes <= 0) return;
    const now = Date.now();
    for (const rec of [...this.sessions.values()]) {
      if (rec.child || rec.subscribers.size > 0 || rec.status === 'running') continue;
      if (now - rec.lastActivity > minutes * 60 * 1000) {
        logger.info(`idle timeout: dropping claude session ${rec.id}`);
        this.sessions.delete(rec.id);
      }
    }
  }

  shutdown() {
    clearInterval(this._sweeper);
    for (const rec of this.sessions.values()) {
      if (rec.child) { try { rec.child.kill(); } catch { /* ignore */ } }
    }
    this.sessions.clear();
  }
}

module.exports = { ClaudeManager };
