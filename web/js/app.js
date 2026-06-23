(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }

  let token = localStorage.getItem('rs_token') || '';

  // --------------------------------------------------------------------------
  // Multi-terminal state. Each tab is a server-side persistent session keyed by
  // sid; the server is the source of truth (GET /api/sessions), so any device
  // logged in as the same user sees the same tabs. We keep ONE xterm + ONE
  // WebSocket and reconnect when switching tabs — the server replays the
  // session's scrollback from its ring buffer on attach, so switching is
  // seamless.
  // --------------------------------------------------------------------------
  let sessions = [];   // [{id,title,createdAt,lastActive,attached,cols,rows}]
  let activeSid = (localStorage.getItem('rs_active') || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  let pendingTitle = ''; // title sent on the next WS connect (used when creating)

  function newSid() {
    const id = (crypto.randomUUID ? crypto.randomUUID() : 's' + Date.now().toString(36) + Math.random().toString(36).slice(2));
    return id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  }

  // --------------------------------------------------------------------------
  // Terminal. The frontend owns all scrollback (50k lines) and renders on the
  // GPU via the WebGL addon — scrolling is browser-native and buttery.
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
    scrollback: 50000,
    theme: THEMES[themeName],
    allowProposedApi: true,
  });
  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open($('terminal'));
  // WebGL renderer: GPU-accelerated, falls back to the default renderer if the
  // context is unavailable or lost (e.g. the tab is backgrounded too long).
  try {
    const webgl = new WebglAddon.WebglAddon();
    webgl.onContextLoss(function () { webgl.dispose(); });
    term.loadAddon(webgl);
  } catch (e) { /* WebGL unavailable: xterm uses its canvas/DOM fallback */ }
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
    el.className = 'status-dot status-' + state;
    el.title = text;
  }

  function wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const params = new URLSearchParams({
      token: token,
      session: activeSid,
      cols: String(term.cols),
      rows: String(term.rows),
    });
    if (pendingTitle) params.set('title', pendingTitle);
    return proto + '//' + location.host + '/ws?' + params.toString();
  }

  function send(op, data) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(op + data);
  }
  function sendResize() {
    send('1', JSON.stringify({ cmd: 'resize', cols: term.cols, rows: term.rows }));
  }

  // connGen rises on every connect(). A socket's handlers no-op once a newer
  // connection supersedes them, so switching tabs (close old, open new) can't
  // leave a stale socket auto-reconnecting.
  let connGen = 0;

  function connect() {
    if (!token) { showLogin(); return; }
    if (!activeSid) return;
    clearTimeout(reconnectTimer);
    setStatus('connecting', 'connecting…');
    intentionalClose = false;
    const myGen = ++connGen;
    const sock = new WebSocket(wsUrl());
    ws = sock;

    sock.onopen = function () {
      if (myGen !== connGen) { try { sock.close(); } catch (e) {} return; }
      reconnectDelay = 1000;
      setStatus('on', 'online');
      // The server dumps the session's scrollback buffer right after connect,
      // so clear any stale content first to avoid stacking it on top.
      term.reset();
      sendResize();
      term.focus();
    };

    sock.onmessage = function (ev) {
      if (myGen !== connGen) return;
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

    sock.onclose = async function () {
      if (myGen !== connGen) return; // superseded by a newer connection
      setStatus('off', 'offline');
      if (intentionalClose) return;
      // Distinguish "token expired" from "network blip" before retrying.
      const ok = await verifyToken();
      if (myGen !== connGen) return;
      if (!ok) { showLogin(); return; }
      setStatus('connecting', 'reconnecting…');
      reconnectTimer = setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 1.5, 10000);
    };

    sock.onerror = function () { /* onclose handles the retry */ };
  }

  function handleEvent(m) {
    if (m.event === 'session') {
      // A session was (re)attached; clear the create-title and resync the tabs
      // (a freshly created session now exists server-side).
      pendingTitle = '';
      fetchSessions();
    } else if (m.event === 'error') {
      term.write('\r\n\x1b[31m[remote-shell] ' + (m.message || 'error') + '\x1b[0m\r\n');
    } else if (m.event === 'ended') {
      term.write('\r\n\x1b[33m[remote-shell] session ended\x1b[0m\r\n');
      intentionalClose = true; // the PTY is gone; don't auto-reconnect to it
      const dead = activeSid;
      sessions = sessions.filter(function (s) { return s.id !== dead; });
      renderTabs();
      switchToAny();
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
  // Tabs / sessions. The server (GET /api/sessions) is the source of truth, so
  // a second device sees the same tab list; we keep one xterm + one WS and
  // reconnect when switching. Functions are hoisted declarations so ordering
  // among them (and vs. connect/showLogin) doesn't matter.
  // --------------------------------------------------------------------------
  async function fetchSessions() {
    if (!token) return;
    try {
      const r = await fetch('/api/sessions', { headers: { Authorization: 'Bearer ' + token } });
      if (r.status === 401) { token = ''; localStorage.removeItem('rs_token'); showLogin(); return; }
      if (!r.ok) return;
      const data = await r.json();
      sessions = Array.isArray(data.sessions) ? data.sessions : [];
      renderTabs();
    } catch (e) { /* keep the last known tabs on a network blip */ }
  }

  function renderTabs() {
    const wrap = $('tabs');
    wrap.textContent = '';
    sessions.forEach(function (s) {
      const tab = document.createElement('div');
      tab.className = 'tab' + (s.id === activeSid ? ' active' : '');
      tab.onclick = function () { switchTo(s.id); };
      const label = document.createElement('span');
      label.className = 'tab-label';
      label.textContent = s.title || 'shell';
      const close = document.createElement('button');
      close.className = 'tab-close';
      close.innerHTML = '&times;';
      close.title = 'Close terminal';
      close.onclick = function (e) { e.stopPropagation(); deleteSession(s.id); };
      tab.appendChild(label);
      tab.appendChild(close);
      wrap.appendChild(tab);
    });
    const add = document.createElement('button');
    add.id = 'tab-add';
    add.innerHTML = '&plus;';
    add.title = 'New terminal';
    add.onclick = function () { createSession(); };
    wrap.appendChild(add);
  }

  function switchTo(sid) {
    if (!sid || sid === activeSid) { term.focus(); return; }
    activeSid = sid;
    localStorage.setItem('rs_active', sid);
    pendingTitle = '';
    intentionalClose = true;
    if (ws) { try { ws.close(); } catch (e) {} }
    reconnectDelay = 1000;
    term.reset();
    renderTabs();
    connect();
  }

  // switchToAny picks a remaining tab after the active one is closed/ended, or
  // creates a fresh terminal if none are left.
  function switchToAny() {
    if (sessions.some(function (s) { return s.id === activeSid; })) return;
    if (sessions.length) {
      activeSid = ''; // force switchTo to proceed
      switchTo(sessions[sessions.length - 1].id);
    } else {
      createSession();
    }
  }

  function nextShellName() {
    let max = 0;
    sessions.forEach(function (s) {
      const m = /^Shell (\d+)$/.exec(s.title || '');
      if (m) max = Math.max(max, parseInt(m[1], 10));
    });
    return 'Shell ' + (max + 1);
  }

  function createSession() {
    const sid = newSid();
    pendingTitle = nextShellName();
    // Optimistically add the tab; the server creates the PTY on connect and the
    // 'session' event triggers a fetchSessions() that reconciles the list.
    sessions.push({ id: sid, title: pendingTitle, createdAt: Date.now() });
    activeSid = '';
    switchTo(sid);
  }

  async function deleteSession(sid) {
    if (!confirm('Close this terminal? Its running processes will be killed.')) return;
    const wasActive = sid === activeSid;
    if (wasActive) { intentionalClose = true; if (ws) { try { ws.close(); } catch (e) {} } }
    try {
      await fetch('/api/sessions?id=' + encodeURIComponent(sid), {
        method: 'DELETE',
        headers: { Authorization: 'Bearer ' + token },
      });
    } catch (e) { /* still drop it locally */ }
    sessions = sessions.filter(function (s) { return s.id !== sid; });
    renderTabs();
    if (wasActive) switchToAny();
  }

  async function boot() {
    await fetchSessions();
    if (!sessions.length) { createSession(); return; }
    // Honor the saved active tab if it still exists, else the most recent.
    if (!sessions.some(function (s) { return s.id === activeSid; })) {
      activeSid = sessions[sessions.length - 1].id;
    }
    localStorage.setItem('rs_active', activeSid);
    renderTabs();
    connect();
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
      boot();
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

  // copyText prefers the async Clipboard API but falls back to a hidden textarea
  // + execCommand, which is the only thing that works over plain HTTP (where
  // navigator.clipboard is undefined). This is what makes the Copy button work
  // on a non-HTTPS deployment.
  function copyText(text) {
    if (!text) return Promise.resolve();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(function () { execCopy(text); });
    }
    execCopy(text);
    return Promise.resolve();
  }
  function execCopy(text) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    } catch (e) { /* ignore */ }
  }

  async function copySelection() {
    const sel = term.getSelection();
    if (!sel) return;
    await copyText(sel);
    term.focus();
  }

  async function pasteClipboard() {
    if (navigator.clipboard && navigator.clipboard.readText) {
      try {
        const t = await navigator.clipboard.readText();
        if (t) send('0', t);
        term.focus();
        return;
      } catch (e) { /* permission denied / unavailable: fall through to overlay */ }
    }
    openPasteOverlay();
  }

  // Manual paste overlay: the reliable cross-browser fallback when the Clipboard
  // API can't read (HTTP, or permission denied). Supports multi-line pastes.
  function openPasteOverlay() {
    const ta = $('paste-text');
    ta.value = '';
    $('paste-overlay').classList.remove('hidden');
    ta.focus();
  }
  function closePasteOverlay() {
    $('paste-overlay').classList.add('hidden');
    term.focus();
  }
  $('paste-cancel').onclick = closePasteOverlay;
  $('paste-send').onclick = function () {
    const v = $('paste-text').value;
    if (v) send('0', v);
    closePasteOverlay();
  };

  // Paste stays a top-level button (mobile-friendly); everything secondary lives
  // in the ⋯ overflow menu so the toolbar never wraps to two rows.
  $('btn-paste').onclick = function () { closeMenu(); pasteClipboard(); };

  const MENU_ACTIONS = {
    copy: copySelection,
    clear: function () { term.clear(); term.focus(); },
    'font-dec': function () { fontSize = Math.max(fontSize - 1, 8); applyFont(); },
    'font-inc': function () { fontSize = Math.min(fontSize + 1, 40); applyFont(); },
    theme: function () { themeName = themeName === 'dark' ? 'light' : 'dark'; applyTheme(); },
    reconnect: function () {
      if (ws) { intentionalClose = true; try { ws.close(); } catch (e) {} }
      reconnectDelay = 1000;
      connect();
    },
    disconnect: function () {
      intentionalClose = true;
      if (ws) { try { ws.close(); } catch (e) {} }
      setStatus('off', 'disconnected');
    },
    kill: function () { deleteSession(activeSid); },
    logout: function () {
      // Token is a stateless HMAC token, so logout just discards it client-side.
      intentionalClose = true;
      if (ws) { try { ws.close(); } catch (e) {} }
      token = '';
      localStorage.removeItem('rs_token');
      showLogin();
    },
  };

  const menu = $('menu');
  function closeMenu() { menu.classList.add('hidden'); }
  $('btn-menu').onclick = function (e) { e.stopPropagation(); menu.classList.toggle('hidden'); };
  menu.addEventListener('click', function (e) {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    closeMenu();
    const act = MENU_ACTIONS[b.getAttribute('data-act')];
    if (act) act();
  });
  document.addEventListener('click', function (e) {
    if (!menu.classList.contains('hidden') && !$('menu-wrap').contains(e.target)) closeMenu();
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeMenu(); });

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
  // Mobile helper keys — a single wrapping panel toggled by the floating button
  // (#kb-fab) in the bottom-left corner. Hidden by default; one tap shows every
  // key, another tap hides them. Keys wrap to fill the width.
  // --------------------------------------------------------------------------
  const keys = $('keybar-keys');

  // Modifier button. preventDefault on mousedown keeps focus on the terminal so
  // the soft keyboard stays open while arming a modifier.
  function addMod(parent, label, name) {
    const b = document.createElement('button');
    b.textContent = label;
    b.className = 'mod';
    b.addEventListener('mousedown', function (e) { e.preventDefault(); });
    b.addEventListener('click', function (e) { e.preventDefault(); toggleMod(name); term.focus(); });
    modBtns[name] = b;
    parent.appendChild(b);
  }
  // raw keys are pre-baked control codes that bypass the modifier transform; the
  // rest flow through sendKey so latched/locked modifiers apply.
  function addKey(parent, label, seq, raw) {
    const b = document.createElement('button');
    b.textContent = label;
    b.addEventListener('mousedown', function (e) { e.preventDefault(); });
    b.addEventListener('click', function (e) {
      e.preventDefault();
      if (raw) send('0', seq); else sendKey(seq);
      term.focus();
    });
    parent.appendChild(b);
  }

  addKey(keys, 'Esc', '\x1b');
  addKey(keys, 'Tab', '\t');
  addMod(keys, 'Ctrl', 'ctrl');
  addKey(keys, '^C', '\x03', true);
  addKey(keys, '←', '\x1b[D');
  addKey(keys, '↑', '\x1b[A');
  addKey(keys, '↓', '\x1b[B');
  addKey(keys, '→', '\x1b[C');
  addMod(keys, 'Shift', 'shift');
  addMod(keys, 'Alt', 'alt');
  addKey(keys, '^D', '\x04', true);
  addKey(keys, '^Z', '\x1a', true);
  addKey(keys, 'Home', '\x1b[H');
  addKey(keys, 'End', '\x1b[F');
  addKey(keys, '|', '|');
  addKey(keys, '~', '~');
  addKey(keys, '/', '/');
  addKey(keys, '-', '-');

  // Floating toggle: show/hide the whole key panel (persisted).
  const keybar = $('keybar');
  const fab = $('kb-fab');
  let kbOpen = localStorage.getItem('rs_kb_open') === '1';
  function applyKbOpen() {
    keybar.classList.toggle('hidden', !kbOpen);
    fab.classList.toggle('active', kbOpen);
  }
  fab.addEventListener('mousedown', function (e) { e.preventDefault(); });
  fab.addEventListener('click', function (e) {
    e.preventDefault();
    kbOpen = !kbOpen;
    localStorage.setItem('rs_kb_open', kbOpen ? '1' : '0');
    applyKbOpen();
    doFit(); // the terminal height changed
    term.focus();
  });

  applyKbOpen();
  if (window.matchMedia('(pointer: coarse)').matches) document.body.classList.add('touch');

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
    verifyToken().then(function (ok) { if (ok) boot(); else showLogin(); });
  } else {
    showLogin();
  }
})();
