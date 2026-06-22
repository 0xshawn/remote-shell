'use strict';

const fs = require('fs');
const { spawn } = require('child_process');
const logger = require('./logger');

const STDERR_MAX = 16 * 1024; // keep only the tail of stderr for diagnostics

// ============================================================================
// ClaudeProcess
//
// Thin wrapper around ONE `claude --print --output-format stream-json` child.
// The manager owns lifecycle (one child per turn by default). This class only:
//   - spawns the child with the configured command/args/env/cwd,
//   - writes user turns as stream-json lines to stdin,
//   - splits stdout into lines, JSON-parses each, and forwards parsed events,
//   - keeps a tail of stderr and reports exit/error.
//
// Wire shapes (verified against claude v2.1.183):
//   stdin  : {"type":"user","message":{"role":"user","content":[{"type":"text","text":"…"}]}}\n
//   stdout : newline-delimited JSON events (system/stream_event/assistant/user/result)
// ============================================================================
class ClaudeProcess {
  // spawnOpts: { command, args, cwd, env, captureFile? }
  // handlers:  { onEvent(obj), onExit(code, signal), onError(err) }
  constructor(spawnOpts, handlers = {}) {
    this.opts = spawnOpts;
    this.onEvent = handlers.onEvent || (() => {});
    this.onExit = handlers.onExit || (() => {});
    this.onError = handlers.onError || (() => {});
    this.child = null;
    this._buf = '';
    this._stderr = '';
    this._capture = null;
    this._killTimer = null;
    this._exited = false;
  }

  start() {
    const { command, args, cwd, env, captureFile } = this.opts;
    logger.debug(`spawn claude: ${command} ${args.join(' ')} (cwd=${cwd})`);
    try {
      this.child = spawn(command, args, {
        cwd,
        env: { ...process.env, ...(env || {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      this.onError(err);
      this.onExit(null, null);
      return;
    }

    if (captureFile) {
      try { this._capture = fs.createWriteStream(captureFile, { flags: 'a' }); } catch { /* ignore */ }
    }

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this._onStdout(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => {
      this._stderr = (this._stderr + chunk).slice(-STDERR_MAX);
    });

    this.child.on('error', (err) => {
      logger.warn(`claude child error: ${err.message}`);
      this.onError(err);
    });
    this.child.on('exit', (code, signal) => {
      this._exited = true;
      clearTimeout(this._killTimer);
      this._flushLine(); // process any trailing buffered line
      if (this._capture) { try { this._capture.end(); } catch { /* ignore */ } }
      logger.debug(`claude child exit code=${code} signal=${signal}`);
      this.onExit(code, signal);
    });
  }

  _onStdout(chunk) {
    this._buf += chunk;
    let nl;
    while ((nl = this._buf.indexOf('\n')) !== -1) {
      const line = this._buf.slice(0, nl);
      this._buf = this._buf.slice(nl + 1);
      this._handleLine(line);
    }
  }

  _flushLine() {
    if (this._buf.trim()) this._handleLine(this._buf);
    this._buf = '';
  }

  _handleLine(line) {
    if (!line.trim()) return;
    if (this._capture) { try { this._capture.write(line + '\n'); } catch { /* ignore */ } }
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      logger.debug(`skip non-JSON claude line: ${line.slice(0, 120)}`);
      return;
    }
    try { this.onEvent(obj); } catch (err) { logger.warn(`onEvent threw: ${err.message}`); }
  }

  // Write one user turn as a stream-json line.
  write(text) {
    if (!this.child || !this.child.stdin.writable) return false;
    const line = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: String(text) }] },
    }) + '\n';
    try { return this.child.stdin.write(line); } catch { return false; }
  }

  // Signal end-of-input (per-turn mode: the child finishes the turn and exits).
  endInput() {
    if (this.child && this.child.stdin.writable) {
      try { this.child.stdin.end(); } catch { /* ignore */ }
    }
  }

  get stderrTail() {
    return this._stderr;
  }

  // Cooperative interrupt: SIGINT, then hard-kill if it doesn't exit in time.
  interrupt() {
    if (!this.child || this._exited) return;
    try { this.child.kill('SIGINT'); } catch { /* ignore */ }
    this._scheduleHardKill();
  }

  kill() {
    if (!this.child || this._exited) return;
    try { this.child.kill('SIGTERM'); } catch { /* ignore */ }
    this._scheduleHardKill();
  }

  _scheduleHardKill() {
    clearTimeout(this._killTimer);
    this._killTimer = setTimeout(() => {
      if (!this._exited && this.child) {
        try { this.child.kill('SIGKILL'); } catch { /* ignore */ }
      }
    }, 3000);
    this._killTimer.unref();
  }
}

module.exports = { ClaudeProcess };
