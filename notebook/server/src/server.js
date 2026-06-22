#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { execFileSync } = require('child_process');
const express = require('express');
const { WebSocketServer } = require('ws');

const { parseConfig } = require('./config');
const logger = require('./logger');
const { createAuth } = require('./auth');
const { ShellManager } = require('./shellManager');
const { ClaudeManager } = require('./claudeManager');

function sanitizeSessionId(raw) {
  return String(raw || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
}

// Static web root: the built Vite app (notebook/web/dist), falling back to the
// dev placeholder so the server runs before the first `vite build`.
function resolveWebRoot() {
  const dist = path.join(__dirname, '..', '..', 'web', 'dist');
  if (fs.existsSync(path.join(dist, 'index.html'))) return dist;
  return path.join(__dirname, '..', 'public');
}

function main() {
  const config = parseConfig();
  logger.setLevel(config.logLevel);

  // tmux is the shell-persistence backend; fail fast if missing.
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
  } catch {
    logger.error('tmux is not installed or not on PATH. Install it (e.g. `apt install tmux`).');
    process.exit(1);
  }

  if (config.ssh.host && !config.ssh.user) {
    logger.error('--ssh-host requires --ssh-user (or SSH_USER).');
    process.exit(1);
  }
  if (config.claude.captureDir) {
    try { fs.mkdirSync(config.claude.captureDir, { recursive: true }); } catch { /* ignore */ }
  }

  const auth = createAuth(config.auth);
  const shells = new ShellManager(config);
  const claude = new ClaudeManager(config);

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  const webRoot = resolveWebRoot();
  app.use(express.static(webRoot));

  // --- API ---
  app.get('/healthz', (req, res) => res.json({ ok: true }));

  app.post('/api/login', (req, res) => {
    const { username, password } = req.body || {};
    if (!auth.checkCredentials(username, password)) {
      logger.warn(`failed login attempt user=${username}`);
      return res.status(401).json({ error: 'invalid credentials' });
    }
    const token = auth.issueToken(auth.enabled ? username : 'anonymous');
    res.json({ token });
  });

  app.get('/api/me', auth.requireAuth, (req, res) => {
    res.json({ user: req.user, authEnabled: auth.enabled });
  });

  // List both shell (from tmux) and claude sessions for this user.
  app.get('/api/sessions', auth.requireAuth, (req, res) => {
    const prefix = `nb_${req.user}_`.replace(/[^A-Za-z0-9_-]/g, '');
    const shellSessions = shells.list()
      .filter((s) => s.key.startsWith(prefix))
      .map((s) => ({ id: s.key.slice(prefix.length), kind: 'shell', label: s.key.slice(prefix.length), createdAt: s.createdAt }));
    res.json([...shellSessions, ...claude.list(req.user)]);
  });

  // Create a claude session (shell sessions are created implicitly on WS attach).
  app.post('/api/sessions', auth.requireAuth, (req, res) => {
    const { kind, cwd, model, permissionMode, label, env } = req.body || {};
    if (kind && kind !== 'claude') return res.status(400).json({ error: 'only claude sessions are created via this endpoint' });
    // env: array of "KEY=VALUE" strings from the dialog (cap to keep it sane).
    const envPairs = Array.isArray(env) ? env.filter((s) => typeof s === 'string').slice(0, 50) : [];
    try {
      const summary = claude.createSession(req.user, { cwd, model, permissionMode, label, env: envPairs });
      res.json(summary);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.delete('/api/sessions/:id', auth.requireAuth, (req, res) => {
    const id = req.params.id;
    if (claude.get(id, req.user)) {
      claude.deleteSession(id, req.user);
    } else {
      // Treat it as a shell session id.
      shells.killSession(shells.key(req.user, sanitizeSessionId(id)));
    }
    res.json({ ok: true });
  });

  // --- HTTP(S) server ---
  const useTLS = Boolean(config.ssl.key && config.ssl.cert);
  const server = useTLS
    ? https.createServer(
        { key: fs.readFileSync(config.ssl.key), cert: fs.readFileSync(config.ssl.cert) },
        app,
      )
    : http.createServer(app);

  // --- WebSocket: /ws (shell, one per tab) and /nbws (claude, multiplexed) ---
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== '/ws' && url.pathname !== '/nbws') {
      socket.destroy();
      return;
    }
    const payload = auth.verifyToken(url.searchParams.get('token'));
    if (!payload) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (url.pathname === '/ws') handleShellWs(ws, payload, url);
      else handleClaudeWs(ws, payload);
    });
  });

  // ---- Shell WebSocket (verbatim contract from remote-shell) ----
  function handleShellWs(ws, payload, url) {
    const user = payload.user || 'anonymous';
    const sessionId = sanitizeSessionId(url.searchParams.get('session'));
    const cols = parseInt(url.searchParams.get('cols'), 10) || 80;
    const rows = parseInt(url.searchParams.get('rows'), 10) || 24;

    if (!sessionId) {
      ws.send('1' + JSON.stringify({ event: 'error', message: 'missing session id' }));
      ws.close();
      return;
    }
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    let handle;
    try {
      handle = shells.attach(user, sessionId, { cols, rows }, ws);
    } catch (err) {
      ws.send('1' + JSON.stringify({ event: 'error', message: err.message }));
      ws.close();
      return;
    }
    ws.send('1' + JSON.stringify({ event: 'session', key: handle.key, isNew: handle.isNew }));

    ws.on('message', (raw) => {
      const msg = raw.toString('utf8');
      const op = msg[0];
      const body = msg.slice(1);
      if (op === '0') {
        handle.write(body);
      } else if (op === '1') {
        let cmd;
        try { cmd = JSON.parse(body); } catch { return; }
        if (cmd.cmd === 'resize') handle.resize(cmd.cols, cmd.rows);
        else if (cmd.cmd === 'kill') { handle.killSession(); try { ws.close(); } catch { /* ignore */ } }
      }
    });
    ws.on('close', () => { handle.detach(); });
    ws.on('error', (err) => logger.debug(`shell ws error: ${err.message}`));
  }

  // ---- Claude WebSocket (multiplexed; all '1'+JSON messages) ----
  function handleClaudeWs(ws, payload) {
    const user = payload.user || 'anonymous';
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    function reply(msg) { try { ws.send('1' + JSON.stringify(msg)); } catch { /* ignore */ } }

    ws.on('message', (raw) => {
      const msg = raw.toString('utf8');
      if (msg[0] !== '1') return;
      let m;
      try { m = JSON.parse(msg.slice(1)); } catch { return; }
      const rec = m.sessionId ? claude.get(m.sessionId, user) : null;
      switch (m.cmd) {
        case 'attach':
          if (!rec) return reply({ type: 'error', sessionId: m.sessionId, message: 'no such session' });
          return claude.attach(rec, ws);
        case 'detach':
          if (rec) claude.detach(rec, ws);
          return;
        case 'turn':
          try { claude.sendTurn(m.sessionId, user, m.text); }
          catch (err) { reply({ type: 'error', sessionId: m.sessionId, message: err.message }); }
          return;
        case 'interrupt':
          claude.interrupt(m.sessionId, user);
          return;
        case 'kill':
          claude.deleteSession(m.sessionId, user);
          return;
        default:
          return;
      }
    });
    ws.on('close', () => claude.detachAll(ws));
    ws.on('error', (err) => logger.debug(`claude ws error: ${err.message}`));
  }

  // Heartbeat across BOTH ws kinds.
  const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) return ws.terminate();
      ws.isAlive = false;
      try { ws.ping(); } catch { /* ignore */ }
    });
  }, 30000);
  wss.on('close', () => clearInterval(heartbeat));

  server.listen(config.port, config.host, () => {
    const proto = useTLS ? 'https' : 'http';
    logger.info(`notebook listening on ${proto}://${config.host}:${config.port}`);
    logger.info(`web root: ${webRoot}`);
    logger.info(`claude: command=${config.claude.command} model=${config.claude.model || '(default)'} ` +
      `permission-mode=${config.claude.permissionMode} cwd=${config.claude.cwd}`);
    if (config.auth.enabled) {
      logger.info(`auth: username=${config.auth.username}`);
      if (config.auth.generatedPassword) logger.info(`auth: GENERATED password = ${config.auth.password}`);
    } else {
      logger.warn('auth DISABLED (--no-auth) — never expose this to an untrusted network');
    }
  });

  function shutdown(signal) {
    logger.info(`received ${signal}, shutting down (tmux shell sessions are left running; claude children are killed)`);
    clearInterval(heartbeat);
    shells.shutdown();
    claude.shutdown();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
