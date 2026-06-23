'use strict';

// Tests for the touch-scroll routing decision (web/js/scroll-routing.js).
//
// Run from the repo root:  node --test
//                    or:    node --test web/test/scroll-routing.test.js
//
// Background — the bug this guards against:
//   On mobile we translate one-finger drags into scrolling ourselves. The first
//   implementation routed by buffer type: alternate buffer -> wheel to the app,
//   normal buffer -> xterm scrollback. But claude code runs in the NORMAL buffer
//   while turning ON mouse reporting (mode 'vt200'). So drags inside claude were
//   sent to xterm's scrollback instead of to claude. Symptoms the user reported:
//   "the whole screen scrolls", claude's bottom status line scrolls off, and the
//   scrolled-out text is garbled — because xterm's scrollback was moving
//   underneath claude's in-place redraws.
//
//   Fix: route by mouse reporting first, buffer second. These tests pin that
//   truth table down, with the regression case called out by name.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chooseScrollTarget } = require('../js/scroll-routing.js');

test('claude code (normal buffer + mouse reporting) -> app [the regression]', () => {
  // This is the exact case that broke. mouseTrackingMode 'vt200' is what claude
  // code's mouse reporting reports; the buffer is 'normal', not 'alternate'.
  assert.equal(chooseScrollTarget('vt200', 'normal'), 'app');
});

test('plain shell (normal buffer, no mouse reporting) -> scrollback', () => {
  // A bare shell has no mouse capture and real scrollback history to pan through.
  assert.equal(chooseScrollTarget('none', 'normal'), 'scrollback');
});

test('full-screen app without mouse reporting (alternate buffer) -> app', () => {
  // e.g. less/man: no mouse capture, but alternate-scroll turns the wheel into
  // arrow keys, and the alternate buffer has no scrollback to pan anyway.
  assert.equal(chooseScrollTarget('none', 'alternate'), 'app');
});

test('full-screen app with mouse reporting (alternate buffer) -> app', () => {
  // e.g. vim/htop with the mouse on.
  assert.equal(chooseScrollTarget('vt200', 'alternate'), 'app');
});

test('every non-none mouse mode routes to the app, in both buffers', () => {
  // xterm reports one of these for an app that has enabled mouse tracking.
  for (const mode of ['x10', 'vt200', 'drag', 'any']) {
    assert.equal(chooseScrollTarget(mode, 'normal'), 'app', `mode=${mode} normal`);
    assert.equal(chooseScrollTarget(mode, 'alternate'), 'app', `mode=${mode} alternate`);
  }
});

test('only normal buffer without mouse reporting reaches scrollback', () => {
  // The single combination that should ever touch xterm's own scrollback.
  assert.equal(chooseScrollTarget('none', 'normal'), 'scrollback');
});

test('missing/garbage mouse mode is treated as no mouse reporting', () => {
  // Defensive: scrollTarget() in app.js falls back to 'none'/'normal' if reading
  // term state throws, but guard against undefined/empty slipping through too.
  for (const mode of [undefined, null, '']) {
    assert.equal(chooseScrollTarget(mode, 'normal'), 'scrollback');
    assert.equal(chooseScrollTarget(mode, 'alternate'), 'app');
  }
});
