'use strict';

const os = require('os');
const crypto = require('crypto');
const { Command } = require('commander');

// Parse CLI flags (with environment-variable fallbacks) into a config object.
function parseConfig(argv = process.argv) {
  const program = new Command();
  program
    .name('remote-shell')
    .description('Persistent web shell with transparent tmux-backed sessions')
    .option('-p, --port <number>', 'HTTP(S) listen port', (v) => parseInt(v, 10),
      parseInt(process.env.PORT || '7681', 10))
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
    .option('--ssh-host <host>', 'SSH into this host instead of running a local shell (e.g. host.docker.internal)',
      process.env.SSH_HOST || '')
    .option('--ssh-user <user>', 'SSH username (required when --ssh-host is set)',
      process.env.SSH_USER || '')
    .option('--ssh-port <port>', 'SSH port', (v) => parseInt(v, 10),
      parseInt(process.env.SSH_PORT || '22', 10))
    .option('--ssh-key <path>', 'SSH private key path (omit to use password / agent auth)',
      process.env.SSH_KEY || '')
    .option('--timeout <minutes>', 'kill a session after it has been DETACHED & idle this long (0 = never)',
      (v) => parseInt(v, 10), parseInt(process.env.SESSION_TIMEOUT || '0', 10))
    .option('--max-sessions <n>', 'max concurrent persistent sessions (0 = unlimited)',
      (v) => parseInt(v, 10), parseInt(process.env.MAX_SESSIONS || '0', 10))
    .option('--no-auth', 'disable authentication (DANGEROUS, local dev only)')
    .option('--log-level <level>', 'log level: error|warn|info|debug',
      process.env.LOG_LEVEL || 'info')
    .option('--log-io', 'also record terminal I/O per session under ./logs (privacy sensitive)')
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
  };
}

module.exports = { parseConfig };
