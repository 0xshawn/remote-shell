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
const { SessionManager } = require('./sessionManager');

function sanitizeSessionId(raw) {
  return String(raw || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
}

function main() {
  const config = parseConfig();
  logger.setLevel(config.logLevel);

  // tmux is the persistence backend; fail fast with a clear message if missing.
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

  const auth = createAuth(config.auth);
  const sessions = new SessionManager(config);

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));

  // --- Static assets ---
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // Vendored xterm.js assets, served straight from node_modules (no build step).
  const xtermDir = path.dirname(require.resolve('@xterm/xterm/package.json'));
  const fitDir = path.dirname(require.resolve('@xterm/addon-fit/package.json'));
  const linksDir = path.dirname(require.resolve('@xterm/addon-web-links/package.json'));
  app.use('/vendor/xterm', express.static(path.join(xtermDir, 'lib')));
  app.use('/vendor/xterm/css', express.static(path.join(xtermDir, 'css')));
  app.use('/vendor/addon-fit', express.static(path.join(fitDir, 'lib')));
  app.use('/vendor/addon-web-links', express.static(path.join(linksDir, 'lib')));

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

  // --- HTTP(S) server ---
  const useTLS = Boolean(config.ssl.key && config.ssl.cert);
  const server = useTLS
    ? https.createServer(
        { key: fs.readFileSync(config.ssl.key), cert: fs.readFileSync(config.ssl.cert) },
        app,
      )
    : http.createServer(app);

  // --- WebSocket (manual upgrade so we can authenticate before accepting) ---
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== '/ws') {
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
      wss.emit('connection', ws, req, payload, url);
    });
  });

  wss.on('connection', (ws, req, payload, url) => {
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
      handle = sessions.attach(user, sessionId, { cols, rows }, ws);
    } catch (err) {
      logger.error(`attach failed: ${err.message}`);
      ws.send('1' + JSON.stringify({ event: 'error', message: err.message }));
      ws.close();
      return;
    }

    ws.send('1' + JSON.stringify({ event: 'session', key: handle.key, isNew: handle.isNew }));

    // --- wire protocol ---
    // client -> server:  '0'<data> = input,  '1'<json> = control {cmd:'resize'|'kill'}
    // server -> client:  '0'<data> = output, '1'<json> = event   {event:'session'|'error'|'ended'}
    ws.on('message', (raw) => {
      const msg = raw.toString('utf8');
      const op = msg[0];
      const body = msg.slice(1);
      if (op === '0') {
        handle.write(body);
      } else if (op === '1') {
        let cmd;
        try { cmd = JSON.parse(body); } catch { return; }
        if (cmd.cmd === 'resize') {
          handle.resize(cmd.cols, cmd.rows);
        } else if (cmd.cmd === 'kill') {
          handle.killSession();
          try { ws.close(); } catch { /* ignore */ }
        }
      }
    });

    ws.on('close', () => {
      handle.detach(); // detach the tmux client; the session keeps running
      logger.info(`ws closed for ${handle.key} (session persists)`);
    });

    ws.on('error', (err) => logger.debug(`ws error: ${err.message}`));
  });

  // Heartbeat: drop sockets that stopped responding (e.g. laptop closed).
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
    logger.info(`remote-shell listening on ${proto}://${config.host}:${config.port}`);
    if (config.ssh.host) {
      logger.info(`backend=ssh target=${config.ssh.user}@${config.ssh.host}:${config.ssh.port}` +
        `${config.ssh.key ? ' key=' + config.ssh.key : ' (password/agent auth)'} tls=${useTLS ? 'on' : 'off'}`);
    } else {
      logger.info(`backend=local shell=${config.shell} cwd=${config.cwd} tls=${useTLS ? 'on' : 'off'}`);
    }
    if (config.auth.enabled) {
      logger.info(`auth: username=${config.auth.username}`);
      if (config.auth.generatedPassword) {
        logger.info(`auth: GENERATED password = ${config.auth.password}`);
      }
    } else {
      logger.warn('auth DISABLED (--no-auth) — never expose this to an untrusted network');
    }
    if (config.timeoutMinutes > 0) logger.info(`idle session timeout: ${config.timeoutMinutes} min`);
  });

  // Graceful shutdown: detach clients, but leave tmux sessions running.
  function shutdown(signal) {
    logger.info(`received ${signal}, shutting down (tmux sessions are left running)`);
    clearInterval(heartbeat);
    sessions.shutdown();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
