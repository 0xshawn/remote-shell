(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }

  // --------------------------------------------------------------------------
  // Auth token storage. "Remember me" decides persistence: localStorage survives
  // a browser restart, sessionStorage is cleared when the tab closes. We read
  // from whichever holds it so an existing session keeps working either way.
  // --------------------------------------------------------------------------
  function getToken() {
    return localStorage.getItem('rs_token') || sessionStorage.getItem('rs_token') || '';
  }
  function storeToken(tok, remember) {
    if (remember) {
      localStorage.setItem('rs_token', tok);
      sessionStorage.removeItem('rs_token');
    } else {
      sessionStorage.setItem('rs_token', tok);
      localStorage.removeItem('rs_token');
    }
  }
  function clearToken() {
    localStorage.removeItem('rs_token');
    sessionStorage.removeItem('rs_token');
  }
  let token = getToken();

  // --------------------------------------------------------------------------
  // Multi-terminal state. Each tab is a server-side persistent session keyed by
  // sid; the server is the source of truth (GET /api/sessions), so any device
  // logged in as the same user sees the same tabs. We keep ONE xterm + ONE
  // WebSocket PER tab (a "pane"), all kept alive at once: switching tabs just
  // shows/hides a pane, so the newly shown terminal is instant — no reconnect,
  // no scrollback replay. A pane connects lazily the first time it is shown,
  // then keeps streaming in the background.
  // --------------------------------------------------------------------------
  let sessions = [];        // [{id,title,createdAt,lastActive,attached,cols,rows}]
  let activeSid = (localStorage.getItem('rs_active') || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  const panes = new Map();  // sid -> pane
  let activePane = null;

  function newSid() {
    const id = (crypto.randomUUID ? crypto.randomUUID() : 's' + Date.now().toString(36) + Math.random().toString(36).slice(2));
    return id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  }

  // --------------------------------------------------------------------------
  // Terminal look & feel (shared by every pane). The frontend owns all scrollback
  // (50k lines) and renders on the GPU via the WebGL addon.
  // --------------------------------------------------------------------------
  const THEMES = {
    dark: { background: '#1e1e1e', foreground: '#d4d4d4', cursor: '#ffffff', selectionBackground: '#264f78' },
    light: { background: '#ffffff', foreground: '#1e1e1e', cursor: '#000000', selectionBackground: '#add6ff' },
  };
  let themeName = localStorage.getItem('rs_theme') || 'dark';
  let fontSize = parseInt(localStorage.getItem('rs_fontsize') || '14', 10);

  // Cascadia Code is a bundled webfont; xterm caches glyph cell metrics per
  // Terminal when it opens, so each pane re-measures once both weights load
  // (round-trip the font size, then refit). Load the font once for the page.
  const fontsReady = (document.fonts && document.fonts.load)
    ? Promise.all([
        document.fonts.load(fontSize + 'px "Cascadia Code"'),
        document.fonts.load('bold ' + fontSize + 'px "Cascadia Code"'),
      ]).catch(function () { /* font load failed: keep fallback metrics */ })
    : Promise.resolve();

  function setStatus(state, text) {
    const el = $('status');
    el.className = 'status-dot status-' + state;
    el.title = text;
  }

  // --------------------------------------------------------------------------
  // Pane: one xterm + one WebSocket bound to a single session sid. All terminal
  // and socket state lives here; the module-level handlers below route to the
  // active pane. connGen rises on every connect(); a socket's handlers no-op once
  // a newer connection (or a dispose) supersedes them, so a stale socket can't
  // keep auto-reconnecting.
  // --------------------------------------------------------------------------
  function makePane(sid) {
    const el = document.createElement('div');
    el.className = 'term-pane';
    el.style.visibility = 'hidden';
    $('terminals').appendChild(el);

    const term = new Terminal({
      cursorBlink: true,
      // "SymbolsMedia" is first but unicode-range-scoped to U+23F5, so it only wins
      // for that glyph; "Cascadia Code" (bundled webfont) is the real terminal face.
      fontFamily: '"SymbolsMedia", "Cascadia Code", Menlo, Consolas, "DejaVu Sans Mono", "Courier New", monospace',
      fontSize: fontSize,
      scrollback: 50000,
      theme: THEMES[themeName],
      allowProposedApi: true,
    });
    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(el);

    const pane = {
      sid: sid,
      term: term,
      fitAddon: fitAddon,
      webgl: null,
      el: el,
      ws: null,
      connGen: 0,
      reconnectTimer: null,
      reconnectDelay: 1000,
      intentionalClose: false,
      pendingTitle: '',   // title sent on this pane's next connect (used when creating)
      connected: false,   // whether we've started this pane's connection lifecycle
    };

    // WebGL renderer: GPU-accelerated, falls back to the default renderer if the
    // context is unavailable or lost (e.g. too many tabs, or the tab is
    // backgrounded too long). For a handful of tabs this stays under the browser's
    // ~16 live-context limit; beyond that, panes degrade gracefully to canvas/DOM.
    try {
      const webgl = new WebglAddon.WebglAddon();
      webgl.onContextLoss(function () { webgl.dispose(); pane.webgl = null; });
      term.loadAddon(webgl);
      pane.webgl = webgl;
    } catch (e) { /* WebGL unavailable: xterm uses its canvas/DOM fallback */ }

    fitAddon.fit();

    fontsReady.then(function () {
      term.options.fontSize = fontSize + 1;
      term.options.fontSize = fontSize;
      if (pane === activePane) pane.fit();
    });

    // Per-Terminal handlers (instance APIs, so each pane wires its own). Only the
    // focused terminal fires these, and only the active pane is ever focused, so
    // the active-pane-aware callbacks always target the right terminal.
    term.onData(function (d) { sendKey(d); });
    term.attachCustomKeyEventHandler(function (e) {
      if (e.type !== 'keydown') return true;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.shiftKey && (e.key === 'C' || e.key === 'c')) { copySelection(); return false; }
      if (mod && e.shiftKey && (e.key === 'V' || e.key === 'v')) { pasteClipboard(); return false; }
      return true;
    });
    term.onSelectionChange(function () {
      const sel = term.getSelection();
      if (sel && sel.length && navigator.clipboard && window.matchMedia('(pointer: fine)').matches) {
        navigator.clipboard.writeText(sel).catch(function () {});
      }
    });

    // status() only touches the global dot for the active pane, so a background
    // pane's connect/close never flips it.
    pane.status = function (state, text) { if (pane === activePane) setStatus(state, text); };
    pane.fit = function () { try { fitAddon.fit(); } catch (e) { /* ignore */ } };

    pane.wsUrl = function () {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const params = new URLSearchParams({
        token: token,
        session: pane.sid,
        cols: String(term.cols),
        rows: String(term.rows),
      });
      if (pane.pendingTitle) params.set('title', pane.pendingTitle);
      return proto + '//' + location.host + '/ws?' + params.toString();
    };

    pane.send = function (op, data) {
      if (pane.ws && pane.ws.readyState === WebSocket.OPEN) pane.ws.send(op + data);
    };
    pane.sendResize = function () {
      pane.send('1', JSON.stringify({ cmd: 'resize', cols: term.cols, rows: term.rows }));
    };

    pane.connect = function () {
      if (!token) { showLogin(); return; }
      if (pane.ws && pane.ws.readyState <= WebSocket.OPEN) return; // already connecting/open
      clearTimeout(pane.reconnectTimer);
      pane.status('connecting', 'connecting…');
      pane.intentionalClose = false;
      const myGen = ++pane.connGen;
      const sock = new WebSocket(pane.wsUrl());
      pane.ws = sock;

      sock.onopen = function () {
        if (myGen !== pane.connGen) { try { sock.close(); } catch (e) {} return; }
        pane.reconnectDelay = 1000;
        pane.status('on', 'online');
        // The server dumps the session's scrollback buffer right after connect,
        // so clear any stale content first to avoid stacking it on top.
        term.reset();
        pane.sendResize();
        if (pane === activePane) term.focus();
      };

      sock.onmessage = function (ev) {
        if (myGen !== pane.connGen) return;
        const msg = typeof ev.data === 'string' ? ev.data : '';
        const op = msg[0];
        const body = msg.slice(1);
        if (op === '0') {
          term.write(body);
        } else if (op === '1') {
          let m;
          try { m = JSON.parse(body); } catch (e) { return; }
          pane.handleEvent(m);
        }
      };

      sock.onclose = async function () {
        if (myGen !== pane.connGen) return; // superseded by a newer connection
        pane.status('off', 'offline');
        if (pane.intentionalClose) return;
        // Distinguish "token expired" from "network blip" before retrying.
        const ok = await verifyToken();
        if (myGen !== pane.connGen) return;
        if (!ok) { showLogin(); return; }
        pane.status('connecting', 'reconnecting…');
        pane.reconnectTimer = setTimeout(pane.connect, pane.reconnectDelay);
        pane.reconnectDelay = Math.min(pane.reconnectDelay * 1.5, 10000);
      };

      sock.onerror = function () { /* onclose handles the retry */ };
    };

    pane.handleEvent = function (m) {
      if (m.event === 'session') {
        // A session was (re)attached; clear the create-title and resync the tabs
        // (a freshly created session now exists server-side).
        pane.pendingTitle = '';
        fetchSessions();
      } else if (m.event === 'error') {
        term.write('\r\n\x1b[31m[remote-shell] ' + (m.message || 'error') + '\x1b[0m\r\n');
      } else if (m.event === 'ended') {
        pane.intentionalClose = true; // the PTY is gone; don't auto-reconnect to it
        removeSession(pane.sid);
      }
    };

    pane.dispose = function () {
      pane.intentionalClose = true;
      pane.connGen++; // no-op any in-flight socket handlers / pending reconnect
      clearTimeout(pane.reconnectTimer);
      if (pane.ws) { try { pane.ws.close(); } catch (e) {} }
      if (pane.webgl) { try { pane.webgl.dispose(); } catch (e) {} }
      try { term.dispose(); } catch (e) {}
      el.remove();
    };

    return pane;
  }

  // --------------------------------------------------------------------------
  // Pane lifecycle / tabs. The server (GET /api/sessions) is the source of truth
  // for the tab list; panes are created lazily on first switch and disposed when
  // their session disappears. Functions are hoisted declarations so ordering
  // among them doesn't matter.
  // --------------------------------------------------------------------------
  function ensurePane(sid) {
    let p = panes.get(sid);
    if (!p) { p = makePane(sid); panes.set(sid, p); }
    return p;
  }
  function disposePane(sid) {
    const p = panes.get(sid);
    if (p) { p.dispose(); panes.delete(sid); }
  }
  // reconcilePanes drops panes whose session no longer exists server-side (e.g.
  // closed on another device). It stays lazy — it never pre-creates panes for
  // sessions not yet visited. If the active pane vanished, fall back to another.
  function reconcilePanes() {
    const hadActive = activePane;
    const live = new Set(sessions.map(function (s) { return s.id; }));
    panes.forEach(function (p, sid) { if (!live.has(sid)) disposePane(sid); });
    if (hadActive && !panes.has(hadActive.sid)) {
      activePane = null;
      switchToAny();
    }
  }

  function paneStatus(p) {
    if (!p || !p.ws) return ['off', 'offline'];
    if (p.ws.readyState === WebSocket.OPEN) return ['on', 'online'];
    if (p.ws.readyState === WebSocket.CONNECTING) return ['connecting', 'connecting…'];
    return ['off', 'offline'];
  }

  function switchTo(sid) {
    if (!sid) return;
    const target = ensurePane(sid);
    if (activePane === target) { target.term.focus(); return; }
    if (activePane) activePane.el.style.visibility = 'hidden';
    activePane = target;
    activeSid = sid;
    localStorage.setItem('rs_active', sid);
    target.el.style.visibility = '';
    renderTabs();

    if (!target.connected) {
      target.connected = true;
      target.connect();
    } else if (!target.ws || target.ws.readyState > WebSocket.OPEN) {
      // Dropped while hidden and waiting on backoff — reconnect now instead of
      // making the user stare at stale content until the next retry.
      target.reconnectDelay = 1000;
      clearTimeout(target.reconnectTimer);
      target.connect();
    } else {
      const st = paneStatus(target);
      setStatus(st[0], st[1]);
    }

    // Fit after the visibility change flushes to layout, then resync the PTY size
    // (the window may have resized while this pane was hidden).
    requestAnimationFrame(function () {
      target.fit();
      target.sendResize();
      target.term.focus();
    });
  }

  // switchToAny picks a remaining tab after the active one is closed/ended, or
  // creates a fresh terminal if none are left.
  function switchToAny() {
    if (activeSid && panes.has(activeSid) && sessions.some(function (s) { return s.id === activeSid; })) return;
    if (sessions.length) switchTo(sessions[sessions.length - 1].id);
    else createSession();
  }

  // removeSession drops a session from the tab list and disposes its pane. Only
  // switches away when it was the *active* session — a background session ending
  // must not yank the tab the user is looking at.
  function removeSession(sid) {
    const wasActive = sid === activeSid;
    sessions = sessions.filter(function (s) { return s.id !== sid; });
    disposePane(sid);
    renderTabs();
    if (wasActive) { activePane = null; switchToAny(); }
  }

  async function verifyToken() {
    if (!token) return false;
    try {
      const r = await fetch('/api/me', { headers: { Authorization: 'Bearer ' + token } });
      if (r.status === 401) { token = ''; clearToken(); return false; }
      return r.ok;
    } catch (e) {
      return true; // network error: keep trying, don't bounce to login
    }
  }

  async function fetchSessions() {
    if (!token) return;
    try {
      const r = await fetch('/api/sessions', { headers: { Authorization: 'Bearer ' + token } });
      if (r.status === 401) { token = ''; clearToken(); showLogin(); return; }
      if (!r.ok) return;
      const data = await r.json();
      sessions = Array.isArray(data.sessions) ? data.sessions : [];
      reconcilePanes();
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
    const p = ensurePane(sid);
    p.pendingTitle = nextShellName();
    // Optimistically add the tab; the server creates the PTY on connect and the
    // 'session' event triggers a fetchSessions() that reconciles the list.
    sessions.push({ id: sid, title: p.pendingTitle, createdAt: Date.now() });
    switchTo(sid);
  }

  async function deleteSession(sid) {
    if (!confirm('Close this terminal? Its running processes will be killed.')) return;
    const wasActive = sid === activeSid;
    disposePane(sid); // closes its socket (intentionalClose) so it won't reconnect
    try {
      await fetch('/api/sessions?id=' + encodeURIComponent(sid), {
        method: 'DELETE',
        headers: { Authorization: 'Bearer ' + token },
      });
    } catch (e) { /* still drop it locally */ }
    sessions = sessions.filter(function (s) { return s.id !== sid; });
    renderTabs();
    if (wasActive) { activePane = null; switchToAny(); }
  }

  async function boot() {
    await fetchSessions();
    if (!sessions.length) { createSession(); return; }
    // Honor the saved active tab if it still exists, else the most recent.
    if (!sessions.some(function (s) { return s.id === activeSid; })) {
      activeSid = sessions[sessions.length - 1].id;
    }
    localStorage.setItem('rs_active', activeSid);
    switchTo(activeSid);
  }

  // --------------------------------------------------------------------------
  // Resize (debounced via rAF). Only the active pane is visible, so only it needs
  // fitting on a window/layout change; background panes re-fit when next shown.
  // --------------------------------------------------------------------------
  let resizeRAF = null;
  function doFit() {
    cancelAnimationFrame(resizeRAF);
    resizeRAF = requestAnimationFrame(function () {
      if (!activePane) return;
      activePane.fit();
      activePane.sendResize();
    });
  }
  window.addEventListener('resize', doFit);
  if (window.ResizeObserver) new ResizeObserver(doFit).observe($('terminals'));

  // --------------------------------------------------------------------------
  // Login
  // --------------------------------------------------------------------------
  function showLogin() {
    setStatus('off', 'offline');
    const savedUser = localStorage.getItem('rs_user') || '';
    $('login-user').value = savedUser;
    $('login-pass').value = ''; // Chrome re-autofills the saved password
    $('login-remember').checked = localStorage.getItem('rs_remember') !== '0';
    $('login').classList.remove('hidden');
    if (savedUser) $('login-pass').focus(); else $('login-user').focus();
  }
  function hideLogin() { $('login').classList.add('hidden'); }

  $('login-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    const username = $('login-user').value;
    const password = $('login-pass').value;
    const remember = $('login-remember').checked;
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
      storeToken(token, remember);
      localStorage.setItem('rs_remember', remember ? '1' : '0');
      if (remember) localStorage.setItem('rs_user', username);
      else localStorage.removeItem('rs_user');
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
    localStorage.setItem('rs_fontsize', String(fontSize));
    panes.forEach(function (p) { p.term.options.fontSize = fontSize; });
    doFit();
  }
  function applyTheme() {
    localStorage.setItem('rs_theme', themeName);
    document.body.classList.toggle('light', themeName === 'light');
    panes.forEach(function (p) { p.term.options.theme = THEMES[themeName]; });
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
    if (!activePane) return;
    const sel = activePane.term.getSelection();
    if (!sel) return;
    await copyText(sel);
    activePane.term.focus();
  }

  async function pasteClipboard() {
    if (!activePane) return;
    if (navigator.clipboard && navigator.clipboard.readText) {
      try {
        const t = await navigator.clipboard.readText();
        if (t) activePane.send('0', t);
        activePane.term.focus();
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
    if (activePane) activePane.term.focus();
  }
  $('paste-cancel').onclick = closePasteOverlay;
  $('paste-send').onclick = function () {
    const v = $('paste-text').value;
    if (v && activePane) activePane.send('0', v);
    closePasteOverlay();
  };

  // Paste stays a top-level button (mobile-friendly); everything secondary lives
  // in the ⋯ overflow menu so the toolbar never wraps to two rows.
  $('btn-paste').onclick = function () { closeMenu(); pasteClipboard(); };

  const MENU_ACTIONS = {
    copy: copySelection,
    clear: function () { if (activePane) { activePane.term.clear(); activePane.term.focus(); } },
    'font-dec': function () { fontSize = Math.max(fontSize - 1, 8); applyFont(); },
    'font-inc': function () { fontSize = Math.min(fontSize + 1, 40); applyFont(); },
    theme: function () { themeName = themeName === 'dark' ? 'light' : 'dark'; applyTheme(); },
    reconnect: function () {
      if (!activePane) return;
      activePane.intentionalClose = true;
      if (activePane.ws) { try { activePane.ws.close(); } catch (e) {} }
      activePane.reconnectDelay = 1000;
      activePane.connected = true;
      activePane.connect();
    },
    disconnect: function () {
      if (!activePane) return;
      activePane.intentionalClose = true;
      activePane.connGen++;
      if (activePane.ws) { try { activePane.ws.close(); } catch (e) {} }
      activePane.connected = false; // so revisiting this tab reconnects
      setStatus('off', 'disconnected');
    },
    kill: function () { if (activeSid) deleteSession(activeSid); },
    logout: function () {
      // Token is a stateless HMAC token, so logout just discards it client-side.
      panes.forEach(function (p) { p.dispose(); });
      panes.clear();
      activePane = null;
      token = '';
      clearToken();
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

  // --------------------------------------------------------------------------
  // Modifier keys (Ctrl / Shift / Alt) — three-state sticky behavior:
  //   released --(tap)--> latched  (applies to the next key, then auto-releases)
  //   released --(double-tap)--> locked  (applies to every key until tapped again)
  // sendKey() is the single path for both on-screen keys and soft-keyboard input
  // (via term.onData), so a latched/locked modifier transforms whatever comes next.
  // The modifier UI is global (one keybar for whichever tab is active).
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
    if (!activePane) return;
    activePane.send('0', applyModifiers(data));
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
    b.addEventListener('click', function (e) { e.preventDefault(); toggleMod(name); if (activePane) activePane.term.focus(); });
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
      if (raw) { if (activePane) activePane.send('0', seq); } else sendKey(seq);
      if (activePane) activePane.term.focus();
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
    if (activePane) activePane.term.focus();
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
  // Touch scroll. We own one-finger vertical drags entirely (CSS sets
  // touch-action: none on the panes, so the browser never hijacks the drag) and
  // route each notch of finger travel by what the running program wants:
  //   - If the app has mouse reporting on (claude code, vim, htop, …) OR runs in
  //     the alternate buffer, dispatch a wheel event on the terminal element:
  //     xterm forwards a mouse-wheel/arrow sequence and the APP scrolls its own
  //     view, keeping its status line in place. We must NOT scroll xterm's
  //     scrollback for these apps — that only smears their in-place redraws and
  //     drags their status line off-screen.
  //   - Otherwise (a plain shell) scroll xterm's own scrollback via scrollLines().
  // One handler bound to the host reads the *active* pane's terminal, since only
  // the active pane is visible/touchable.
  // --------------------------------------------------------------------------
  (function () {
    const el = $('terminals');
    let tracking = false, lastY = 0, lastX = 0, step = 18;

    // 'app' (forward the wheel to the program) or 'scrollback' (scroll xterm's
    // own history). The decision lives in chooseScrollTarget (scroll-routing.js)
    // so it can be unit tested; here we just read the live xterm state.
    function scrollTarget() {
      const t = activePane && activePane.term;
      let mode = 'none', buf = 'normal';
      if (t) {
        try { mode = t.modes.mouseTrackingMode; } catch (e) { /* keep 'none' */ }
        try { buf = t.buffer.active.type; } catch (e) { /* keep 'normal' */ }
      }
      return chooseScrollTarget(mode, buf);
    }
    // dir: +1 scrolls toward newer content, -1 toward older. DOM_DELTA_LINE with
    // deltaY ±1 makes xterm emit exactly one wheel notch; the finger coords keep
    // the mouse report on the right row.
    function emitWheel(dir) {
      if (!activePane) return;
      activePane.term.element.dispatchEvent(new WheelEvent('wheel', {
        deltaY: dir, deltaMode: 1, clientX: lastX, clientY: lastY,
        bubbles: true, cancelable: true,
      }));
    }

    el.addEventListener('touchstart', function (e) {
      if (e.touches.length !== 1 || !activePane) { tracking = false; return; }
      tracking = true;
      lastX = e.touches[0].clientX;
      lastY = e.touches[0].clientY;
      // One wheel notch / scrollback line per rendered row of finger travel.
      step = Math.max(8, Math.round(el.clientHeight / Math.max(activePane.term.rows, 1)));
    }, { passive: true });

    el.addEventListener('touchmove', function (e) {
      if (!tracking || e.touches.length !== 1 || !activePane) return;
      e.preventDefault(); // we own the vertical drag
      const y = e.touches[0].clientY;
      lastX = e.touches[0].clientX;
      let dy = lastY - y; // finger up => positive => scroll toward newer content
      const target = scrollTarget();
      while (Math.abs(dy) >= step) {
        const dir = dy > 0 ? 1 : -1;
        lastY = y;
        if (target === 'app') emitWheel(dir); else activePane.term.scrollLines(dir);
        dy -= dir * step;
      }
      lastY = y + dy; // carry the sub-step remainder into the next move
    }, { passive: false });

    function stop() { tracking = false; }
    el.addEventListener('touchend', stop);
    el.addEventListener('touchcancel', stop);
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
