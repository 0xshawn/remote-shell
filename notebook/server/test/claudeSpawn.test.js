'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { ClaudeManager } = require('../src/claudeManager');

// Minimal config factory; only the fields _spawnSpec/_buildArgs touch matter.
function makeConfig(overrides = {}) {
  return {
    claude: {
      command: '/opt/nvm/bin/claude',
      extraArgs: [],
      model: '',
      permissionMode: 'acceptEdits',
      cwd: '/home/shawn',
      env: {},
      maxSessions: 0,
      idleTimeout: 0,
      captureDir: '',
    },
    ssh: { host: '', user: '', port: 22, key: '' },
    ...overrides,
  };
}

test('local mode: spawns the claude binary directly with per-session env', () => {
  const mgr = new ClaudeManager(makeConfig());
  mgr.createSession('u', { env: ['FOO=bar'] });
  const rec = [...mgr.sessions.values()][0];
  const spec = mgr._spawnSpec(rec);
  assert.strictEqual(spec.command, '/opt/nvm/bin/claude');
  assert.ok(spec.args.includes('--session-id'));
  assert.strictEqual(spec.env.FOO, 'bar');
  mgr.shutdown();
});

test('ssh mode: wraps claude in a non-TTY ssh command on the host', () => {
  const mgr = new ClaudeManager(makeConfig({
    ssh: { host: 'host.docker.internal', user: 'shawn', port: 22, key: '/k/id' },
  }));
  mgr.createSession('u', { env: ['CLAUDE_CONFIG_DIR=/home/shawn/.cfg'] });
  const rec = [...mgr.sessions.values()][0];
  const spec = mgr._spawnSpec(rec);

  assert.strictEqual(spec.command, 'ssh');
  assert.ok(spec.args.includes('-T'), 'forces no pseudo-tty');
  assert.ok(spec.args.includes('-i') && spec.args.includes('/k/id'), 'uses the key');
  assert.ok(spec.args.includes('shawn@host.docker.internal'), 'targets user@host');

  // The remote command is the last arg.
  const remote = spec.args[spec.args.length - 1];
  assert.ok(remote.startsWith("cd '/home/shawn' &&"), 'cd into the quoted cwd');
  assert.ok(remote.includes("PATH='/opt/nvm/bin':$PATH"), 'puts the binary dir on PATH');
  assert.ok(remote.includes("CLAUDE_CONFIG_DIR='/home/shawn/.cfg'"), 'inlines session env');
  assert.ok(remote.includes("'/opt/nvm/bin/claude'"), 'quotes the claude binary');
  assert.ok(remote.includes('--session-id'), 'carries claude args');
  mgr.shutdown();
});

test('ssh mode: single quotes in values are escaped safely', () => {
  const mgr = new ClaudeManager(makeConfig({
    ssh: { host: 'h', user: 'u', port: 22, key: '' },
  }));
  mgr.createSession('u', { cwd: "/tmp/it's here", env: ["X=a'b"] });
  const rec = [...mgr.sessions.values()][0];
  const remote = mgr._spawnSpec(rec).args.slice(-1)[0];
  assert.ok(remote.includes("cd '/tmp/it'\\''s here' &&"), 'cwd quote-escaped');
  assert.ok(remote.includes("X='a'\\''b'"), 'env value quote-escaped');
  mgr.shutdown();
});
