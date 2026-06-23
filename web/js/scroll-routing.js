'use strict';

// Decide where a one-finger touch-scroll drag should go, given what the running
// program is doing. This is the one decision that has bitten us twice, so it
// lives in its own pure function with no DOM/xterm dependencies and is unit
// tested in web/test/scroll-routing.test.js.
//
// Inputs come straight from xterm:
//   mouseTrackingMode  term.modes.mouseTrackingMode
//                      'none' | 'x10' | 'vt200' | 'drag' | 'any'
//   bufferType         term.buffer.active.type — 'normal' | 'alternate'
//
// Returns:
//   'app'         dispatch a wheel event so xterm forwards a mouse-wheel/arrow
//                 sequence to the program, which scrolls its OWN view and keeps
//                 its status line in place.
//   'scrollback'  scroll xterm's own scrollback via term.scrollLines().
//
// The trap we fell into: claude code runs in the NORMAL buffer but turns on
// mouse reporting (vt200). Routing by buffer alone sent its drags to xterm's
// scrollback, which smeared claude's in-place redraws and dragged its status
// line off-screen. So mouse reporting — not the buffer — is the primary signal.
function chooseScrollTarget(mouseTrackingMode, bufferType) {
  // App captures the mouse (claude code, vim, htop): forward the wheel to it.
  if (mouseTrackingMode && mouseTrackingMode !== 'none') return 'app';
  // Full-screen app without mouse reporting (e.g. less): alternate-scroll turns
  // the wheel into arrow keys. The alternate buffer has no scrollback anyway.
  if (bufferType === 'alternate') return 'app';
  // Plain shell: scroll xterm's own scrollback history.
  return 'scrollback';
}

// Dual-use: a global for the browser (classic <script>, no bundler) and a
// CommonJS export for the Node test runner.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { chooseScrollTarget };
}
