(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }

  // --------------------------------------------------------------------------
  // Session id: from ?session= in the URL, else localStorage, else generated.
  // It is reflected back into the URL so the page is bookmarkable / shareable,
  // and persisted in localStorage so a plain refresh resumes the same shell.
  // --------------------------------------------------------------------------
  function resolveSessionId() {
    const url = new URL(window.location.href);
    let id = url.searchParams.get('session') || localStorage.getItem('rs_session') || '';
    id = id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
    if (!id) {
      id = (crypto.randomUUID ? crypto.randomUUID() : 's' + Date.now().toString(36) + Math.random().toString(36).slice(2));
      id = id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
    }
    localStorage.setItem('rs_session', id);
    if (url.searchParams.get('session') !== id) {
      url.searchParams.set('session', id);
      window.history.replaceState({}, '', url.toString());
    }
    return id;
  }

  const sessionId = resolveSessionId();
  let token = localStorage.getItem('rs_token') || '';

  // --------------------------------------------------------------------------
  // Terminal
  // --------------------------------------------------------------------------
  const THEMES = {
    dark: { background: '#1e1e1e', foreground: '#d4d4d4', cursor: '#ffffff', selectionBackground: '#264f78' },
    light: { background: '#ffffff', foreground: '#1e1e1e', cursor: '#000000', selectionBackground: '#add6ff' },
  };
  let themeName = localStorage.getItem('rs_theme') || 'dark';
  let fontSize = parseInt(localStorage.getItem('rs_fontsize') || '14', 10);

  const term = new Terminal({
    cursorBlink: true,
    fontFamily: 'Menlo, Consolas, "DejaVu Sans Mono", "Courier New", monospace',
    fontSize: fontSize,
    scrollback: 1000,
    theme: THEMES[themeName],
    allowProposedApi: true,
  });
  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  try { term.loadAddon(new WebLinksAddon.WebLinksAddon()); } catch (e) { /* optional */ }
  term.open($('terminal'));
  fitAddon.fit();
  term.focus();

  // --------------------------------------------------------------------------
  // WebSocket connection + auto-reconnect
  // --------------------------------------------------------------------------
  let ws = null;
  let reconnectTimer = null;
  let reconnectDelay = 1000;
  let intentionalClose = false;

  function setStatus(state, text) {
    const el = $('status');
    el.className = 'status status-' + state;
    el.textContent = text;
  }

  function wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const params = new URLSearchParams({
      token: token,
      session: sessionId,
      cols: String(term.cols),
      rows: String(term.rows),
    });
    return proto + '//' + location.host + '/ws?' + params.toString();
  }

  function send(op, data) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(op + data);
  }
  function sendResize() {
    send('1', JSON.stringify({ cmd: 'resize', cols: term.cols, rows: term.rows }));
  }

  function connect() {
    if (!token) { showLogin(); return; }
    clearTimeout(reconnectTimer);
    setStatus('connecting', 'connecting…');
    intentionalClose = false;

    ws = new WebSocket(wsUrl());

    ws.onopen = function () {
      reconnectDelay = 1000;
      setStatus('on', 'online');
      // tmux repaints the whole screen on attach, so clear stale content first.
      term.reset();
      sendResize();
      term.focus();
    };

    ws.onmessage = function (ev) {
      const msg = typeof ev.data === 'string' ? ev.data : '';
      const op = msg[0];
      const body = msg.slice(1);
      if (op === '0') {
        term.write(body);
      } else if (op === '1') {
        let m;
        try { m = JSON.parse(body); } catch (e) { return; }
        handleEvent(m);
      }
    };

    ws.onclose = async function () {
      setStatus('off', 'offline');
      if (intentionalClose) return;
      // Distinguish "token expired" from "network blip" before retrying.
      const ok = await verifyToken();
      if (!ok) { showLogin(); return; }
      setStatus('connecting', 'reconnecting…');
      reconnectTimer = setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 1.5, 10000);
    };

    ws.onerror = function () { /* onclose handles the retry */ };
  }

  function handleEvent(m) {
    if (m.event === 'session') {
      $('session-label').textContent = (m.isNew ? 'new · ' : 'resumed · ') + sessionId;
    } else if (m.event === 'error') {
      term.write('\r\n\x1b[31m[remote-shell] ' + (m.message || 'error') + '\x1b[0m\r\n');
    } else if (m.event === 'ended') {
      term.write('\r\n\x1b[33m[remote-shell] session ended\x1b[0m\r\n');
    }
  }

  term.onData(function (d) { sendKey(d); });

  async function verifyToken() {
    if (!token) return false;
    try {
      const r = await fetch('/api/me', { headers: { Authorization: 'Bearer ' + token } });
      if (r.status === 401) { token = ''; localStorage.removeItem('rs_token'); return false; }
      return r.ok;
    } catch (e) {
      return true; // network error: keep trying, don't bounce to login
    }
  }

  // --------------------------------------------------------------------------
  // Resize (debounced via rAF)
  // --------------------------------------------------------------------------
  let resizeRAF = null;
  function doFit() {
    cancelAnimationFrame(resizeRAF);
    resizeRAF = requestAnimationFrame(function () {
      try { fitAddon.fit(); } catch (e) { /* ignore */ }
      sendResize();
    });
  }
  window.addEventListener('resize', doFit);
  if (window.ResizeObserver) new ResizeObserver(doFit).observe($('terminal'));

  // --------------------------------------------------------------------------
  // Login
  // --------------------------------------------------------------------------
  function showLogin() {
    setStatus('off', 'offline');
    $('login').classList.remove('hidden');
    $('login-user').focus();
  }
  function hideLogin() { $('login').classList.add('hidden'); }

  $('login-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    const username = $('login-user').value;
    const password = $('login-pass').value;
    const errEl = $('login-error');
    errEl.classList.add('hidden');
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username, password: password }),
      });
      if (!res.ok) {
        errEl.textContent = 'Invalid credentials';
        errEl.classList.remove('hidden');
        return;
      }
      const data = await res.json();
      token = data.token;
      localStorage.setItem('rs_token', token);
      hideLogin();
      connect();
    } catch (err) {
      errEl.textContent = 'Login failed: ' + err.message;
      errEl.classList.remove('hidden');
    }
  });

  // --------------------------------------------------------------------------
  // Toolbar
  // --------------------------------------------------------------------------
  function applyFont() {
    term.options.fontSize = fontSize;
    localStorage.setItem('rs_fontsize', String(fontSize));
    doFit();
  }
  function applyTheme() {
    term.options.theme = THEMES[themeName];
    localStorage.setItem('rs_theme', themeName);
    document.body.classList.toggle('light', themeName === 'light');
  }

  async function copySelection() {
    const sel = term.getSelection();
    if (!sel) return;
    try { await navigator.clipboard.writeText(sel); } catch (e) { /* ignore */ }
    term.focus();
  }
  async function pasteClipboard() {
    try {
      const t = await navigator.clipboard.readText();
      if (t) send('0', t);
    } catch (e) { /* clipboard may be blocked; user can use Ctrl/Cmd+V */ }
    term.focus();
  }

  $('btn-font-inc').onclick = function () { fontSize = Math.min(fontSize + 1, 40); applyFont(); };
  $('btn-font-dec').onclick = function () { fontSize = Math.max(fontSize - 1, 8); applyFont(); };
  $('btn-theme').onclick = function () { themeName = themeName === 'dark' ? 'light' : 'dark'; applyTheme(); };
  $('btn-copy').onclick = copySelection;
  $('btn-paste').onclick = pasteClipboard;
  $('btn-clear').onclick = function () { term.clear(); term.focus(); };
  $('btn-reconnect').onclick = function () {
    if (ws) { intentionalClose = true; try { ws.close(); } catch (e) {} }
    reconnectDelay = 1000;
    connect();
  };
  $('btn-disconnect').onclick = function () {
    intentionalClose = true;
    if (ws) { try { ws.close(); } catch (e) {} }
    setStatus('off', 'disconnected');
  };
  $('btn-kill').onclick = function () {
    if (!confirm('Terminate the persistent session? Running processes will be killed.')) return;
    send('1', JSON.stringify({ cmd: 'kill' }));
    intentionalClose = true;
    localStorage.removeItem('rs_session');
  };
  $('btn-logout').onclick = function () {
    // Token is a stateless HMAC token, so logout just discards it client-side.
    intentionalClose = true;
    if (ws) { try { ws.close(); } catch (e) {} }
    token = '';
    localStorage.removeItem('rs_token');
    showLogin();
  };

  // Ctrl/Cmd+Shift+C / V for copy / paste (don't steal a plain Ctrl+C — that's SIGINT).
  term.attachCustomKeyEventHandler(function (e) {
    if (e.type !== 'keydown') return true;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.shiftKey && (e.key === 'C' || e.key === 'c')) { copySelection(); return false; }
    if (mod && e.shiftKey && (e.key === 'V' || e.key === 'v')) { pasteClipboard(); return false; }
    return true;
  });

  // Auto-copy on selection (desktop / fine pointer only).
  term.onSelectionChange(function () {
    const sel = term.getSelection();
    if (sel && sel.length && navigator.clipboard && window.matchMedia('(pointer: fine)').matches) {
      navigator.clipboard.writeText(sel).catch(function () {});
    }
  });

  // --------------------------------------------------------------------------
  // Modifier keys (Ctrl / Shift / Alt) — three-state sticky behavior:
  //   released --(tap)--> latched  (applies to the next key, then auto-releases)
  //   released --(double-tap)--> locked  (applies to every key until tapped again)
  // sendKey() is the single path for both on-screen keys and soft-keyboard input
  // (via term.onData), so a latched/locked modifier transforms whatever comes next.
  // --------------------------------------------------------------------------
  const modState = { ctrl: 0, shift: 0, alt: 0 }; // 0 = released, 1 = latched, 2 = locked
  const modBtns = {};
  const lastModTap = { ctrl: 0, shift: 0, alt: 0 };

  function updateModUI(name) {
    const b = modBtns[name];
    if (!b) return;
    b.classList.toggle('latched', modState[name] === 1);
    b.classList.toggle('locked', modState[name] === 2);
  }
  function toggleMod(name) {
    const now = Date.now();
    const isDouble = now - lastModTap[name] < 300;
    lastModTap[name] = now;
    if (isDouble) modState[name] = modState[name] === 2 ? 0 : 2; // double-tap: lock / unlock
    else modState[name] = modState[name] === 0 ? 1 : 0;          // single tap: latch / release
    updateModUI(name);
  }
  function clearLatched() {
    ['ctrl', 'shift', 'alt'].forEach(function (n) {
      if (modState[n] === 1) { modState[n] = 0; updateModUI(n); }
    });
  }

  // Map a single character to its Ctrl- control code (letters -> 0x01..0x1a).
  function ctrlChar(ch) {
    const c = ch.codePointAt(0);
    if (c >= 0x61 && c <= 0x7a) return String.fromCharCode(c - 0x60); // a-z
    if (c >= 0x41 && c <= 0x5a) return String.fromCharCode(c - 0x40); // A-Z
    const map = { ' ': 0, '@': 0, '[': 27, '\\': 28, ']': 29, '^': 30, '_': 31, '?': 127 };
    return ch in map ? String.fromCharCode(map[ch]) : ch;
  }

  function applyModifiers(data) {
    const ctrl = modState.ctrl > 0, shift = modState.shift > 0, alt = modState.alt > 0;
    if (!ctrl && !shift && !alt) return data;

    // Arrow keys -> standard CSI modifier parameter (e.g. Shift+Up = ESC[1;2A).
    const arrow = { '\x1b[A': 'A', '\x1b[B': 'B', '\x1b[C': 'C', '\x1b[D': 'D' }[data];
    if (arrow) {
      const mod = 1 + (shift ? 1 : 0) + (alt ? 2 : 0) + (ctrl ? 4 : 0);
      return mod > 1 ? '\x1b[1;' + mod + arrow : data;
    }
    // Tab: Shift+Tab is the back-tab (CSI Z); Alt+Tab is ESC-prefixed.
    if (data === '\t') return shift ? '\x1b[Z' : (alt ? '\x1b\t' : '\t');

    // Single character: shift (uppercase) -> ctrl (control code) -> alt (ESC prefix).
    if (data.length === 1) {
      let ch = data;
      if (shift) ch = ch.toUpperCase();
      if (ctrl) ch = ctrlChar(ch);
      if (alt) ch = '\x1b' + ch;
      return ch;
    }
    // Everything else (pastes, other sequences): Alt just ESC-prefixes.
    return alt ? '\x1b' + data : data;
  }

  function sendKey(data) {
    send('0', applyModifiers(data));
    clearLatched();
  }

  // --------------------------------------------------------------------------
  // Mobile helper keys
  // --------------------------------------------------------------------------
  const keybar = $('keybar');

  // Modifier buttons (left side of the bar). preventDefault on mousedown keeps
  // focus on the terminal so the soft keyboard stays open while arming a modifier.
  [['Ctrl', 'ctrl'], ['Shift', 'shift'], ['Alt', 'alt']].forEach(function (m) {
    const b = document.createElement('button');
    b.textContent = m[0];
    b.className = 'mod';
    b.addEventListener('mousedown', function (e) { e.preventDefault(); });
    b.addEventListener('click', function (e) { e.preventDefault(); toggleMod(m[1]); term.focus(); });
    modBtns[m[1]] = b;
    keybar.appendChild(b);
  });

  // [label, sequence, raw?] — raw keys are pre-baked control codes that bypass
  // the modifier transform; the rest flow through sendKey so modifiers apply.
  const KEYS = [
    ['Esc', '\x1b'], ['Tab', '\t'],
    ['^C', '\x03', true], ['^D', '\x04', true], ['^Z', '\x1a', true],
    ['↑', '\x1b[A'], ['↓', '\x1b[B'], ['←', '\x1b[D'], ['→', '\x1b[C'],
    ['|', '|'], ['~', '~'], ['/', '/'], ['-', '-'],
  ];
  KEYS.forEach(function (k) {
    const b = document.createElement('button');
    b.textContent = k[0];
    b.addEventListener('click', function (e) {
      e.preventDefault();
      if (k[2]) send('0', k[1]); else sendKey(k[1]);
      term.focus();
    });
    keybar.appendChild(b);
  });
  if (window.matchMedia('(pointer: coarse)').matches) document.body.classList.add('touch');

  // --------------------------------------------------------------------------
  // Touch scroll. tmux attaches on the ALTERNATE screen, so xterm's own
  // scrollback is empty — the history lives in tmux. To scroll it on mobile we
  // translate a one-finger drag into SGR mouse-wheel events sent to tmux (the
  // same thing a desktop wheel does: enter copy-mode and scroll). We preventDefault
  // from the first move so the browser never synthesizes the mouse drag that
  // tmux would otherwise turn into a selection. Requires tmux `mouse on`.
  // --------------------------------------------------------------------------
  (function () {
    const el = $('terminal');
    let lastY = null, accum = 0;
    // SGR wheel: button 64 = up (older history), 65 = down (newer). Coordinates
    // pick the cell under the finger so the right pane scrolls.
    function wheel(up, x, y) {
      const rect = el.getBoundingClientRect();
      const cols = term.cols || 80, rows = term.rows || 24;
      const col = Math.min(cols, Math.max(1, Math.ceil((x - rect.left) / (rect.width / cols))));
      const row = Math.min(rows, Math.max(1, Math.ceil((y - rect.top) / (rect.height / rows))));
      send('0', '\x1b[<' + (up ? 64 : 65) + ';' + col + ';' + row + 'M');
    }
    el.addEventListener('touchstart', function (e) {
      if (e.touches.length !== 1) { lastY = null; return; }
      lastY = e.touches[0].clientY; accum = 0;
    }, { passive: true, capture: true });
    el.addEventListener('touchmove', function (e) {
      if (lastY === null || e.touches.length !== 1) return;
      e.preventDefault(); e.stopPropagation();
      const t = e.touches[0], x = t.clientX, y = t.clientY;
      accum += y - lastY;
      lastY = y;
      const step = (el.clientHeight / (term.rows || 24)) * 2; // drag px per wheel notch
      while (accum >= step) { wheel(true, x, y); accum -= step; }   // finger down -> older
      while (accum <= -step) { wheel(false, x, y); accum += step; } // finger up   -> newer
    }, { passive: false, capture: true });
  })();

  // --------------------------------------------------------------------------
  // Soft keyboard: shrink the app to the visual viewport so the helper keybar
  // floats just above the keyboard instead of being hidden behind it. On mobile
  // the keyboard overlays the layout viewport (its height is unchanged), but
  // window.visualViewport.height reports the actually-visible area.
  // --------------------------------------------------------------------------
  (function () {
    const vv = window.visualViewport;
    if (!vv) return;
    function fitViewport() {
      // Only on touch devices; leave desktop layout to the CSS height: 100%.
      if (!document.body.classList.contains('touch')) { document.body.style.height = ''; return; }
      document.body.style.height = vv.height + 'px';
    }
    vv.addEventListener('resize', fitViewport);
    vv.addEventListener('scroll', fitViewport);
    fitViewport();
  })();

  // --------------------------------------------------------------------------
  // Boot
  // --------------------------------------------------------------------------
  applyTheme();
  if (token) {
    verifyToken().then(function (ok) { if (ok) connect(); else showLogin(); });
  } else {
    showLogin();
  }
})();
