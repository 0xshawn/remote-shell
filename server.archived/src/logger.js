'use strict';

// Tiny leveled logger. No external dependency on purpose.
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
let currentLevel = LEVELS.info;

function setLevel(name) {
  if (name in LEVELS) currentLevel = LEVELS[name];
}

function emit(level, args) {
  if (LEVELS[level] > currentLevel) return;
  const prefix = `[${new Date().toISOString()}] [${level.toUpperCase()}]`;
  const fn = level === 'error' ? console.error : console.log;
  fn(prefix, ...args);
}

module.exports = {
  setLevel,
  error: (...a) => emit('error', a),
  warn: (...a) => emit('warn', a),
  info: (...a) => emit('info', a),
  debug: (...a) => emit('debug', a),
};
