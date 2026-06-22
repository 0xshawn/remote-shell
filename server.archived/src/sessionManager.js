'use strict';

const fs = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const pty = require('node-pty');
const logger = require('./logger');

const TMUX_CONF = path.join(__dirname, 'tmux.conf');
const PREFIX = 'rs_'; // namespace for all tmux sessions owned by remote-shell

// Keep tmux session names to a safe character set (tmux dislikes '.' and ':').
function sanitize(s) {
  return String(s || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'default';
}

// ============================================================================
// SessionManager
//
// Persistence model:
//   - Each (user, sessionId) maps to ONE long-lived tmux session.
//   - node-pty spawns a tmux CLIENT that lives only while the WebSocket is open.
//   - WS closes  -> we kill the pty (detaches the client). The tmux session,
//     held by the separate tmux server process, keeps running -> persistence.
//   - WS reopens -> a fresh pty re-attaches; tmux repaints the screen.
// ============================================================================
class SessionManager {
  constructor(config) {
    this.config = config;
    this.clients = new Map(); // key -> { pty, ws, ioStream }

    if (config.logIO) {
      this.logDir = path.join(process.cwd(), 'logs');
      try { fs.mkdirSync(this.logDir, { recursive: true }); } catch { /* ignore */ }
    }

    // Periodically reap idle, detached sessions if a timeout is configured.
    this._sweeper = setInterval(() => this._sweep(), 60 * 1000);
    this._sweeper.unref();
  }

  key(user, sessionId) {
    return `${PREFIX}${sanitize(user)}_${sanitize(sessionId)}`;
  }

  // The command tmux runs: either a local shell, or an SSH login to a host.
  // In SSH mode the container-side tmux holds the connection, so a browser
  // refresh still resumes the same host shell (cwd/env/foreground job kept).
  command() {
    const s = this.config.ssh;
    if (s && s.host) {
      const parts = [
        'ssh', '-tt',
        '-o', 'StrictHostKeyChecking=accept-new',
        '-o', 'ServerAliveInterval=30',
        '-o', 'ServerAliveCountMax=3',
      ];
      if (s.port && s.port !== 22) parts.push('-p', String(s.port));
      if (s.key) parts.push('-i', s.key);
      parts.push(`${s.user}@${s.host}`);
      // Passed to tmux as a single shell-command string (tmux runs it via `sh -c`).
      return parts.join(' ');
    }
    return this.config.shell;
  }

  tmuxExists(key) {
    try {
      // `=key` forces an EXACT match (avoids rs_a_1 matching rs_a_10).
      execFileSync('tmux', ['has-session', '-t', `=${key}`], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  countTmux() {
    try {
      const out = execFileSync('tmux', ['list-sessions', '-F', '#{session_name}'], { encoding: 'utf8' });
      return out.split('\n').filter((n) => n.startsWith(PREFIX)).length;
    } catch {
      return 0; // no server running yet => 0 sessions
    }
  }

  // Attach a WebSocket to a persistent tmux session, creating it if needed.
  attach(user, sessionId, { cols, rows }, ws) {
    const key = this.key(user, sessionId);
    const exists = this.tmuxExists(key);

    if (!exists && this.config.maxSessions > 0 && this.countTmux() >= this.config.maxSessions) {
      throw new Error('maximum number of sessions reached');
    }

    // "Last tab wins": replace any client already attached to this session so
    // tmux doesn't shrink the window to the smallest of multiple clients.
    const prev = this.clients.get(key);
    if (prev) {
      try { prev.pty.kill(); } catch { /* ignore */ }
      if (prev.ioStream) { try { prev.ioStream.end(); } catch { /* ignore */ } }
      this.clients.delete(key);
    }

    const c = Math.max(parseInt(cols, 10) || 80, 2);
    const r = Math.max(parseInt(rows, 10) || 24, 2);

    // `new-session -A`: attach if the session exists, otherwise create it
    // running the configured shell. -x/-y/-c only apply when creating.
    const args = [
      '-f', TMUX_CONF,
      'new-session', '-A',
      '-s', key,
      '-x', String(c),
      '-y', String(r),
      '-c', this.config.cwd,
      this.command(),
    ];

    const term = pty.spawn('tmux', args, {
      name: 'xterm-256color',
      cols: c,
      rows: r,
      cwd: this.config.cwd,
      // Force a UTF-8 locale for the tmux client. The frontend (xterm.js) is
      // always UTF-8, but slim base images leave LANG unset (POSIX), which makes
      // tmux render CJK / wide characters as placeholders. C.UTF-8 is built into
      // glibc, so no locales package is required.
      env: { ...process.env, TERM: 'xterm-256color', LANG: process.env.LANG || 'C.UTF-8' },
    });

    let ioStream = null;
    if (this.config.logIO && this.logDir) {
      ioStream = fs.createWriteStream(path.join(this.logDir, `${key}.log`), { flags: 'a' });
      ioStream.write(`\n--- attach ${new Date().toISOString()} user=${user} ---\n`);
    }

    const client = { pty: term, ws, ioStream };
    this.clients.set(key, client);

    // tmux -> browser
    term.onData((data) => {
      try { ws.send('0' + data); } catch { /* ws may be closing */ }
      if (ioStream) { try { ioStream.write(data); } catch { /* ignore */ } }
    });

    // The pty (tmux client) exited. This happens on detach (WS close) AND when
    // the user runs `exit` and tmux tears the session down.
    term.onExit(({ exitCode }) => {
      logger.debug(`tmux client for ${key} exited code=${exitCode}`);
      if (this.clients.get(key) === client) this.clients.delete(key);
      if (ioStream) { try { ioStream.end(); } catch { /* ignore */ } }
      // If the underlying session is truly gone, tell the browser.
      if (!this.tmuxExists(key)) {
        try { ws.send('1' + JSON.stringify({ event: 'ended' })); } catch { /* ignore */ }
      }
    });

    logger.info(`${exists ? 'attached' : 'created'} ${key} user=${user} size=${c}x${r}`);

    return {
      key,
      isNew: !exists,
      write: (d) => { try { term.write(d); } catch { /* ignore */ } },
      resize: (cc, rr) => {
        try { term.resize(Math.max(parseInt(cc, 10) || c, 2), Math.max(parseInt(rr, 10) || r, 2)); }
        catch { /* ignore */ }
      },
      // Detach only: kills the client, keeps the tmux session alive.
      detach: () => { try { term.kill(); } catch { /* ignore */ } },
      // Destroy the persistent session entirely.
      killSession: () => this.killSession(key),
    };
  }

  killSession(key) {
    const c = this.clients.get(key);
    if (c) {
      try { c.pty.kill(); } catch { /* ignore */ }
      this.clients.delete(key);
    }
    try { execFileSync('tmux', ['kill-session', '-t', `=${key}`], { stdio: 'ignore' }); } catch { /* ignore */ }
    logger.info(`killed session ${key}`);
  }

  // Reap sessions that are detached (no client) and idle past the timeout.
  // Driven entirely by tmux state, so it works even after a server restart.
  _sweep() {
    const minutes = this.config.timeoutMinutes;
    if (!minutes || minutes <= 0) return;
    execFile(
      'tmux',
      ['list-sessions', '-F', '#{session_name} #{session_attached} #{session_activity}'],
      { encoding: 'utf8' },
      (err, stdout) => {
        if (err) return; // no server / no sessions
        const now = Date.now();
        stdout.split('\n').forEach((line) => {
          if (!line) return;
          const [name, attached, activity] = line.split(' ');
          if (!name || !name.startsWith(PREFIX)) return;
          if (parseInt(attached, 10) > 0) return; // a client is connected
          const lastMs = parseInt(activity, 10) * 1000;
          if (Number.isNaN(lastMs)) return;
          if (now - lastMs > minutes * 60 * 1000) {
            logger.info(`idle timeout: killing ${name}`);
            execFile('tmux', ['kill-session', '-t', `=${name}`], () => {});
          }
        });
      },
    );
  }

  // On process shutdown: detach clients but DO NOT kill tmux sessions.
  shutdown() {
    clearInterval(this._sweeper);
    for (const [, c] of this.clients) {
      try { c.pty.kill(); } catch { /* ignore */ }
      if (c.ioStream) { try { c.ioStream.end(); } catch { /* ignore */ } }
    }
    this.clients.clear();
  }
}

module.exports = { SessionManager };
