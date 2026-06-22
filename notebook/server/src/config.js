'use strict';

const os = require('os');
const crypto = require('crypto');
const { Command } = require('commander');

// Split a space/comma-separated env string into an argv array (empty -> []).
function splitArgs(s) {
  return String(s || '').split(/\s+/).filter(Boolean);
}

// Parse `KEY=VALUE` pairs (from --claude-env or CLAUDE_ENV) into an object.
function parseEnvPairs(pairs) {
  const out = {};
  for (const p of pairs || []) {
    const i = String(p).indexOf('=');
    if (i <= 0) continue;
    out[String(p).slice(0, i)] = String(p).slice(i + 1);
  }
  return out;
}

// Parse CLI flags (with environment-variable fallbacks) into a config object.
function parseConfig(argv = process.argv) {
  const program = new Command();
  program
    .name('notebook')
    .description('Jupyter-style web client for Claude Code, with a tmux-backed shell')
    .option('-p, --port <number>', 'HTTP(S) listen port', (v) => parseInt(v, 10),
      parseInt(process.env.PORT || '7682', 10))
    .option('-H, --host <host>', 'listen address', process.env.HOST || '0.0.0.0')
    .option('-s, --shell <path>', 'shell to launch inside tmux',
      process.env.SHELL_PATH || process.env.SHELL || '/bin/bash')
    .option('-c, --cwd <dir>', 'initial working directory for NEW sessions',
      process.env.WORK_DIR || os.homedir())
    .option('-u, --username <name>', 'auth username', process.env.AUTH_USER || 'admin')
    .option('-k, --password <pass>', 'auth password (auto-generated if omitted)',
      process.env.AUTH_PASS || '')
    .option('--token-secret <secret>', 'secret used to sign session tokens',
      process.env.TOKEN_SECRET || '')
    .option('--ssl-key <file>', 'path to TLS private key (enables built-in HTTPS)',
      process.env.SSL_KEY || '')
    .option('--ssl-cert <file>', 'path to TLS certificate (enables built-in HTTPS)',
      process.env.SSL_CERT || '')
    .option('--ssh-host <host>', 'SSH into this host instead of running a local shell',
      process.env.SSH_HOST || '')
    .option('--ssh-user <user>', 'SSH username (required when --ssh-host is set)',
      process.env.SSH_USER || '')
    .option('--ssh-port <port>', 'SSH port', (v) => parseInt(v, 10),
      parseInt(process.env.SSH_PORT || '22', 10))
    .option('--ssh-key <path>', 'SSH private key path (omit to use password / agent auth)',
      process.env.SSH_KEY || '')
    .option('--timeout <minutes>', 'kill a SHELL session after it has been DETACHED & idle this long (0 = never)',
      (v) => parseInt(v, 10), parseInt(process.env.SESSION_TIMEOUT || '0', 10))
    .option('--max-sessions <n>', 'max concurrent persistent SHELL sessions (0 = unlimited)',
      (v) => parseInt(v, 10), parseInt(process.env.MAX_SESSIONS || '0', 10))
    .option('--no-auth', 'disable authentication (DANGEROUS, local dev only)')
    .option('--log-level <level>', 'log level: error|warn|info|debug',
      process.env.LOG_LEVEL || 'info')
    .option('--log-io', 'also record shell terminal I/O per session under ./logs (privacy sensitive)')
    // --- Claude launch profile (the configurable engine) ---
    .option('--claude-command <path>', 'the claude binary to launch',
      process.env.CLAUDE_BIN || 'claude')
    .option('--claude-arg <arg...>', 'extra args appended to every claude invocation (repeatable)',
      splitArgs(process.env.CLAUDE_EXTRA_ARGS))
    .option('--claude-model <model>', 'model passed to claude (--model); empty = CLI default',
      process.env.CLAUDE_MODEL || '')
    .option('--permission-mode <mode>', 'claude --permission-mode (default|acceptEdits|auto|bypassPermissions)',
      process.env.CLAUDE_PERMISSION_MODE || 'acceptEdits')
    .option('--claude-cwd <dir>', 'working directory for NEW claude sessions (default = --cwd)',
      process.env.CLAUDE_CWD || '')
    .option('--claude-env <KEY=VAL...>', 'env vars injected into the claude child (repeatable)',
      (val, prev) => prev.concat([val]), [])
    .option('--max-claude-sessions <n>', 'max concurrent claude sessions (0 = unlimited)',
      (v) => parseInt(v, 10), parseInt(process.env.MAX_CLAUDE_SESSIONS || '0', 10))
    .option('--claude-idle-timeout <minutes>', 'drop an idle claude session after this long (0 = never)',
      (v) => parseInt(v, 10), parseInt(process.env.CLAUDE_IDLE_TIMEOUT || '0', 10))
    .option('--capture <dir>', 'dev: tee raw claude stdout stream-json lines into this dir',
      process.env.CLAUDE_CAPTURE_DIR || '')
    .parse(argv);

  const opts = program.opts();

  // commander maps --no-auth -> opts.auth === false
  const authEnabled = opts.auth !== false;

  let password = opts.password;
  let generatedPassword = false;
  if (authEnabled && !password) {
    // Jupyter-style: if no password is configured, generate one and print it on boot.
    password = crypto.randomBytes(9).toString('base64url');
    generatedPassword = true;
  }

  // A stable secret keeps tokens valid across restarts; a random one logs everyone out on restart.
  const tokenSecret = opts.tokenSecret || crypto.randomBytes(32).toString('hex');

  // CLAUDE_ENV may also carry KEY=VAL pairs (space-separated) in addition to --claude-env.
  const envPairs = splitArgs(process.env.CLAUDE_ENV).concat(opts.claudeEnv || []);

  return {
    port: opts.port,
    host: opts.host,
    shell: opts.shell,
    cwd: opts.cwd,
    auth: {
      enabled: authEnabled,
      username: opts.username,
      password,
      generatedPassword,
      tokenSecret,
    },
    ssl: { key: opts.sslKey, cert: opts.sslCert },
    ssh: { host: opts.sshHost, user: opts.sshUser, port: opts.sshPort, key: opts.sshKey },
    timeoutMinutes: opts.timeout,
    maxSessions: opts.maxSessions,
    logLevel: opts.logLevel,
    logIO: Boolean(opts.logIo),
    claude: {
      command: opts.claudeCommand,
      extraArgs: opts.claudeArg || [],
      model: opts.claudeModel,
      permissionMode: opts.permissionMode,
      cwd: opts.claudeCwd || opts.cwd,
      env: parseEnvPairs(envPairs),
      maxSessions: opts.maxClaudeSessions,
      idleTimeout: opts.claudeIdleTimeout,
      captureDir: opts.capture,
    },
  };
}

module.exports = { parseConfig };
