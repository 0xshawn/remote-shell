# Web UI Modernization (Modern Slate) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the web terminal's chrome (toolbar, tabs, buttons, menu, keybar, overlays) and subtly retune the terminal palette into a modern, clean "Modern Slate" look with an indigo accent — cosmetic only, no layout or behavior changes.

**Architecture:** Introduce CSS custom-property design tokens at `:root` (dark) and `body.light` (light) in `web/css/style.css`, then convert every rule to reference those tokens with the new Modern Slate values. Because tokens centralize the palette, the per-selector `body.light` colour overrides that exist today are deleted as each section is converted. One 2-line colour edit lands in `web/js/app.js` (`THEMES`), plus a one-line `theme-color` meta update in `web/index.html`.

**Tech Stack:** Vanilla HTML/CSS/JS (no framework, no build step). Assets are self-hosted (no CDN). xterm.js renders the terminal; its colours come from the `THEMES` object in `app.js`, not CSS.

## Global Constraints

- No new dependencies, no build step, no CDN, no new bundled assets. Pure CSS + minimal JS colour edits.
- No HTML structure changes. Every `id`/`class` that `web/js/app.js` reads must be preserved (do not rename or remove elements).
- No layout restructure and no behavior/logic changes. Cosmetics only.
- Both dark and light themes must be modernized together (light is not left behind).
- Keep `font-size: 16px` on all overlay text inputs (prevents iOS Safari zoom-on-focus).
- Preserve mobile responsiveness: keep touch targets ≥44px and the existing `@media (max-width: 640px)` block.
- The existing test `web/test/scroll-routing.test.js` must still pass (it is behavior-only; these changes must not affect it).
- Accent colour is indigo `#6366f1`. Radii: `--radius 8px`, `--radius-lg 12px`.

## How to verify (applies to every task)

There is no CSS test harness. For visual checks, serve the `web/` folder as web root so the absolute `/vendor`, `/css`, `/js` paths resolve:

```bash
cd web && python3 -m http.server 8000
# open http://localhost:8000 in a browser
```

Without the backend the app falls back to showing the login overlay (fetch fails) — that is expected and lets you inspect login styling. To inspect the other overlays (`#paste-overlay`, `#chpw-overlay`, `#users-overlay`) and the menu (`#menu`), open devtools and remove the `hidden` class from that element, or set `class=""` on it, to reveal it. Toggle dark/light by running `document.body.classList.toggle('light')` in the devtools console.

The existing JS test runs with:

```bash
node --test web/test/scroll-routing.test.js
```

## File Structure

- `web/css/style.css` — MODIFY. Add the token layer at the top; convert each section to tokens with new values; delete now-redundant `body.light` per-selector overrides. This is the bulk of the work.
- `web/js/app.js` — MODIFY. `THEMES` object colours only (~2 lines).
- `web/index.html` — MODIFY. One line: `<meta name="theme-color">` value.

---

### Task 1: Design tokens + base foundation

**Files:**
- Modify: `web/css/style.css` (the `* { box-sizing }` / `html, body` / `body` / `body.light` block, currently around lines 29-40)
- Modify: `web/index.html:8` (`theme-color` meta)

**Interfaces:**
- Produces: the CSS custom properties consumed by every later task — `--bg`, `--surface`, `--surface-2`, `--overlay`, `--border`, `--border-strong`, `--text`, `--text-dim`, `--accent`, `--accent-hover`, `--accent-soft`, `--danger`, `--danger-soft`, `--ok`, `--warn`, `--radius`, `--radius-lg`, `--shadow`, `--transition`. Later tasks reference these names exactly.

- [ ] **Step 1: Add the token layer and convert the base rules**

In `web/css/style.css`, replace this block:

```css
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }

body {
  display: flex;
  flex-direction: column;
  background: #1e1e1e;
  color: #ddd;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  overflow: hidden;
}
body.light { background: #ffffff; color: #222; }
```

with:

```css
/* ---------- design tokens ---------- */
:root {
  --bg: #0f1115;
  --surface: #171a21;
  --surface-2: #1b1f27;
  --overlay: #1e222b;
  --border: rgba(255, 255, 255, 0.08);
  --border-strong: rgba(255, 255, 255, 0.14);
  --text: #e5e7eb;
  --text-dim: #9aa3b2;
  --accent: #6366f1;
  --accent-hover: #7c7ff2;
  --accent-soft: rgba(99, 102, 241, 0.15);
  --danger: #ef4444;
  --danger-soft: rgba(239, 68, 68, 0.15);
  --ok: #34d399;
  --warn: #f5b301;
  --radius: 8px;
  --radius-lg: 12px;
  --shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
  --transition: 0.15s ease;
}
body.light {
  --bg: #ffffff;
  --surface: #f6f7f9;
  --surface-2: #eef0f3;
  --overlay: #ffffff;
  --border: rgba(0, 0, 0, 0.10);
  --border-strong: rgba(0, 0, 0, 0.16);
  --text: #1f2430;
  --text-dim: #5b6472;
  --accent: #6366f1;
  --accent-hover: #5457e0;
  --accent-soft: rgba(99, 102, 241, 0.12);
  --danger: #dc2626;
  --danger-soft: rgba(220, 38, 38, 0.10);
  --ok: #16a34a;
  --warn: #b7791f;
  --shadow: 0 10px 30px rgba(0, 0, 0, 0.12);
}

* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }

body {
  display: flex;
  flex-direction: column;
  background: var(--bg);
  color: var(--text);
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  overflow: hidden;
}
```

Note: the old `body.light { background: #ffffff; color: #222; }` rule is intentionally removed — the token override now handles it.

- [ ] **Step 2: Update the mobile theme-color to match the new background**

In `web/index.html`, replace line 8:

```html
  <meta name="theme-color" content="#1e1e1e" />
```

with:

```html
  <meta name="theme-color" content="#0f1115" />
```

- [ ] **Step 3: Verify the tokens render**

Run: `cd web && python3 -m http.server 8000` and open `http://localhost:8000`.
Expected: page background is deep slate (`#0f1115`), not the old `#1e1e1e`. Running `document.body.classList.toggle('light')` in the console flips the background to white. (The toolbar/tabs still look old — they are converted in later tasks. That is expected.)

- [ ] **Step 4: Confirm the token blocks exist**

Run: `grep -c -- '--accent' web/css/style.css`
Expected: a number ≥ 2 (defined in both `:root` and `body.light`).

- [ ] **Step 5: Commit**

```bash
git add web/css/style.css web/index.html
git commit -m "feat(web): add Modern Slate design tokens and base surface"
```

---

### Task 2: Toolbar, status dot, and tabs

**Files:**
- Modify: `web/css/style.css` (the `#toolbar` block + its `body.light` override; the `.status-dot` block; the `#tabs` / `.tab` blocks + their `body.light` overrides)

**Interfaces:**
- Consumes: all tokens from Task 1.

- [ ] **Step 1: Convert the toolbar**

Replace:

```css
#toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: #252526;
  border-bottom: 1px solid #333;
  flex: 0 0 auto;
}
body.light #toolbar { background: #f3f3f3; border-color: #ddd; }
```

with:

```css
#toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  flex: 0 0 auto;
}
```

- [ ] **Step 2: Convert the tab strip and tabs**

Replace:

```css
.tab {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 0 0 auto;
  max-width: 160px;
  padding: 4px 4px 4px 10px;
  border: 1px solid #555;
  border-radius: 6px;
  background: #2d2d2e;
  color: #ccc;
  cursor: pointer;
  font-size: 13px;
  user-select: none;
}
.tab:hover { background: #37373a; }
.tab.active { background: #0e639c; border-color: #1177bb; color: #fff; }
.tab-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tab-close {
  flex: 0 0 auto;
  padding: 0 5px;
  border: none;
  background: transparent;
  color: inherit;
  font-size: 15px;
  line-height: 1;
  border-radius: 4px;
  opacity: 0.6;
}
.tab-close:hover { opacity: 1; background: rgba(255, 255, 255, 0.15); }
#tab-add { flex: 0 0 auto; padding: 5px 9px; font-size: 15px; line-height: 1; }
body.light .tab { background: #ececec; color: #333; border-color: #ccc; }
body.light .tab.active { background: #0e639c; color: #fff; border-color: #0e639c; }
```

with:

```css
.tab {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 0 0 auto;
  max-width: 160px;
  padding: 5px 5px 5px 12px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface-2);
  color: var(--text-dim);
  cursor: pointer;
  font-size: 13px;
  user-select: none;
  transition: background var(--transition), color var(--transition), border-color var(--transition);
}
.tab:hover { background: var(--overlay); color: var(--text); }
.tab.active { background: var(--accent); border-color: var(--accent); color: #fff; }
.tab-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tab-close {
  flex: 0 0 auto;
  padding: 0 5px;
  border: none;
  background: transparent;
  color: inherit;
  font-size: 15px;
  line-height: 1;
  border-radius: 999px;
  opacity: 0.6;
  transition: opacity var(--transition), background var(--transition);
}
.tab-close:hover { opacity: 1; background: rgba(255, 255, 255, 0.18); }
#tab-add { flex: 0 0 auto; padding: 5px 10px; font-size: 15px; line-height: 1; }
```

Note: both `body.light .tab` overrides are removed — tokens handle light mode now.

- [ ] **Step 3: Convert the status dot**

Replace:

```css
.status-dot { flex: 0 0 auto; width: 10px; height: 10px; border-radius: 50%; background: #6e1f1f; }
.status-on { background: #2ea043; }
.status-off { background: #6e1f1f; }
.status-connecting { background: #b08800; }
```

with:

```css
.status-dot {
  flex: 0 0 auto;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--danger);
  transition: background var(--transition), box-shadow var(--transition);
}
.status-on { background: var(--ok); box-shadow: 0 0 0 3px rgba(52, 211, 153, 0.18); }
.status-off { background: var(--danger); box-shadow: 0 0 0 3px rgba(239, 68, 68, 0.15); }
.status-connecting { background: var(--warn); box-shadow: 0 0 0 3px rgba(245, 179, 1, 0.18); }
```

- [ ] **Step 4: Verify**

Reload `http://localhost:8000`. Expected: toolbar is a soft slate bar with a hairline bottom border; tabs are pill-shaped; the active tab (if any is shown) is indigo. Toggle light mode in the console — toolbar becomes light grey, tabs stay legible, active tab stays indigo.

- [ ] **Step 5: Confirm legacy toolbar/tab colours are gone**

Run: `grep -nE '#0e639c|#252526|#2d2d2e|#37373a|#1177bb' web/css/style.css`
Expected: no matches in the toolbar/tab/status region (matches may still exist elsewhere until later tasks convert them; visually confirm the toolbar block itself is clean).

- [ ] **Step 6: Commit**

```bash
git add web/css/style.css
git commit -m "feat(web): modernize toolbar, tabs, and status dot"
```

---

### Task 3: Buttons, overflow menu, and keybar

**Files:**
- Modify: `web/css/style.css` (the base `button` block + `body.light button`; the `#menu` block + its `body.light` overrides; the `#keybar` block + `body.light #keybar`; the `#kb-fab` and modifier-state blocks)

**Interfaces:**
- Consumes: all tokens from Task 1. Establishes the shared `button` / `button.primary` / `button.danger` system reused by overlays in Task 4.

- [ ] **Step 1: Convert the overflow menu**

Replace:

```css
#btn-paste { flex: 0 0 auto; }
#menu-wrap { position: relative; flex: 0 0 auto; }
#btn-menu { font-size: 16px; line-height: 1; padding: 5px 10px; }
#menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 60;
  display: flex;
  flex-direction: column;
  min-width: 170px;
  padding: 6px;
  gap: 2px;
  background: #252526;
  border: 1px solid #444;
  border-radius: 8px;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.5);
}
#menu button {
  text-align: left;
  background: transparent;
  border: none;
  padding: 9px 10px;
  border-radius: 6px;
  font-size: 14px;
}
#menu button:hover { background: #37373a; }
#menu button.danger { background: transparent; color: #f48771; }
#menu button.danger:hover { background: #6e1f1f; color: #fff; }
body.light #menu { background: #fff; border-color: #ddd; }
body.light #menu button:hover { background: #ececec; }
```

with:

```css
#btn-paste { flex: 0 0 auto; }
#menu-wrap { position: relative; flex: 0 0 auto; }
#btn-menu { font-size: 16px; line-height: 1; padding: 6px 11px; }
#menu {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  z-index: 60;
  display: flex;
  flex-direction: column;
  min-width: 180px;
  padding: 6px;
  gap: 2px;
  background: var(--overlay);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow);
}
#menu button {
  text-align: left;
  background: transparent;
  border: none;
  padding: 9px 11px;
  border-radius: var(--radius);
  font-size: 14px;
  color: var(--text);
}
#menu button:hover { background: var(--accent-soft); color: var(--text); }
#menu button.danger { background: transparent; color: var(--danger); }
#menu button.danger:hover { background: var(--danger); color: #fff; }
```

Note: both `body.light #menu` overrides are removed — tokens handle them.

- [ ] **Step 2: Convert the base button system**

Replace:

```css
button {
  background: #3a3d41;
  color: #eee;
  border: 1px solid #555;
  border-radius: 4px;
  padding: 5px 9px;
  font-size: 13px;
  cursor: pointer;
}
button:hover { background: #4a4d51; }
button.danger { background: #6e1f1f; border-color: #8a2a2a; }
button.danger:hover { background: #8a2a2a; }
body.light button { background: #e7e7e7; color: #222; border-color: #ccc; }
```

with:

```css
button {
  background: var(--surface-2);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 6px 10px;
  font-size: 13px;
  cursor: pointer;
  transition: background var(--transition), border-color var(--transition), color var(--transition);
}
button:hover { background: var(--overlay); border-color: var(--border-strong); }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
button.primary:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
button.danger { background: var(--danger-soft); border-color: transparent; color: var(--danger); }
button.danger:hover { background: var(--danger); color: #fff; }
```

Note: `body.light button` is removed — tokens handle it.

- [ ] **Step 3: Convert the keybar and modifier states**

Replace:

```css
#keybar {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 6px;
  background: #252526;
  border-top: 1px solid #333;
  flex: 0 0 auto;
}
#keybar.hidden { display: none; }
body.light #keybar { background: #f3f3f3; border-color: #ddd; }
```

with:

```css
#keybar {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  background: var(--surface);
  border-top: 1px solid var(--border);
  flex: 0 0 auto;
}
#keybar.hidden { display: none; }
```

Then replace:

```css
#kb-fab { flex: 0 0 auto; font-size: 20px; line-height: 1; padding: 3px 9px; }
#kb-fab.active { background: #0e639c; border-color: #1177bb; color: #fff; }

/* Modifier-key states: latched = mild accent, locked = strong accent + ring. */
#keybar button.mod.latched {
  background: #0e639c;
  border-color: #1177bb;
  color: #fff;
}
#keybar button.mod.locked {
  background: #0e639c;
  border-color: #ffffff;
  color: #fff;
  box-shadow: inset 0 0 0 2px #ffffff;
}
```

with:

```css
#kb-fab { flex: 0 0 auto; font-size: 20px; line-height: 1; padding: 3px 9px; }
#kb-fab.active { background: var(--accent); border-color: var(--accent); color: #fff; }

/* Modifier-key states: latched = accent fill, locked = accent fill + ring. */
#keybar button.mod.latched {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
#keybar button.mod.locked {
  background: var(--accent);
  border-color: #ffffff;
  color: #fff;
  box-shadow: inset 0 0 0 2px #ffffff;
}
```

(The `#keybar-keys` and `#keybar button` sizing rules between these two blocks are unchanged — leave them as-is.)

- [ ] **Step 4: Verify**

Reload. Click the `⌨️` keyboard button in the toolbar to open the keybar; keys are soft slate, ≥44px tall. Tap a modifier key (e.g. `Ctrl`) — it fills indigo (latched); double-tap — indigo + white ring (locked). Open the `⋯` menu — it is a rounded card with soft shadow and indigo-tinted hover; the "Kill terminal" entry is red and turns solid red on hover. Toggle light mode and confirm all stay legible.

- [ ] **Step 5: Confirm legacy button/menu colours are gone**

Run: `grep -nE '#3a3d41|#4a4d51|#6e1f1f|#8a2a2a|#f48771|#e7e7e7' web/css/style.css`
Expected: matches only remain inside overlay sections not yet converted (Task 4). The button/menu/keybar regions themselves show no matches.

- [ ] **Step 6: Commit**

```bash
git add web/css/style.css
git commit -m "feat(web): unify button system, modernize menu and keybar"
```

---

### Task 4: Overlays (login, paste, change-password, manage-users)

**Files:**
- Modify: `web/css/style.css` (the `#login` / `#login-form` blocks; the `#paste-overlay` / `#paste-box` blocks + `body.light` overrides; the `#chpw-overlay` / `#chpw-form` blocks + `body.light` overrides; the `#users-overlay` / `#users-box` blocks + `body.light` overrides). The `@media (max-width: 640px)` block stays unchanged.

**Interfaces:**
- Consumes: all tokens from Task 1; reuses the `.primary` convention from Task 3.

- [ ] **Step 1: Convert the login overlay**

Replace:

```css
#login {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.75);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
}
.hidden, #login.hidden { display: none !important; }

#login-form {
  background: #252526;
  padding: 28px;
  border-radius: 8px;
  width: 300px;
  max-width: 90vw;
  display: flex;
  flex-direction: column;
  gap: 12px;
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
}
#login-form h2 { margin: 0 0 4px; color: #eee; text-align: center; }
#login-form input {
  padding: 10px;
  border-radius: 4px;
  border: 1px solid #555;
  background: #1e1e1e;
  color: #eee;
  font-size: 16px; /* >=16px stops iOS Safari from zooming on focus */
}
#login-form #login-remember-row {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #ccc;
  font-size: 14px;
  cursor: pointer;
}
#login-form input[type="checkbox"] {
  width: auto;
  padding: 0;
  margin: 0;
  border: 0;
  background: none;
  font-size: inherit;
  accent-color: #0e639c;
}
#login-form button { padding: 10px; font-size: 15px; background: #0e639c; border-color: #0e639c; color: #fff; }
#login-form .error { color: #f48771; font-size: 13px; margin: 0; text-align: center; }
```

with:

```css
#login {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(6px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
}
.hidden, #login.hidden { display: none !important; }

#login-form {
  background: var(--overlay);
  padding: 28px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  width: 320px;
  max-width: 90vw;
  display: flex;
  flex-direction: column;
  gap: 12px;
  box-shadow: var(--shadow);
}
#login-form h2 { margin: 0 0 4px; color: var(--text); text-align: center; font-weight: 600; }
#login-form input {
  padding: 11px 12px;
  border-radius: var(--radius);
  border: 1px solid var(--border-strong);
  background: var(--bg);
  color: var(--text);
  font-size: 16px; /* >=16px stops iOS Safari from zooming on focus */
  transition: border-color var(--transition), box-shadow var(--transition);
}
#login-form input:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
#login-form #login-remember-row {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-dim);
  font-size: 14px;
  cursor: pointer;
}
#login-form input[type="checkbox"] {
  width: auto;
  padding: 0;
  margin: 0;
  border: 0;
  background: none;
  font-size: inherit;
  accent-color: var(--accent);
}
#login-form button {
  padding: 11px;
  font-size: 15px;
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
#login-form button:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
#login-form .error { color: var(--danger); font-size: 13px; margin: 0; text-align: center; }
```

- [ ] **Step 2: Convert the paste fallback overlay**

Replace:

```css
#paste-overlay {
  position: fixed;
  inset: 0;
  z-index: 70;
  background: rgba(0, 0, 0, 0.75);
  display: flex;
  align-items: center;
  justify-content: center;
}
#paste-box {
  background: #252526;
  padding: 20px;
  border-radius: 8px;
  width: 380px;
  max-width: 92vw;
  display: flex;
  flex-direction: column;
  gap: 10px;
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
}
#paste-box h3 { margin: 0; color: #eee; }
#paste-box .hint { margin: 0; font-size: 12px; color: #999; }
#paste-text {
  height: 120px;
  resize: vertical;
  padding: 10px;
  border-radius: 4px;
  border: 1px solid #555;
  background: #1e1e1e;
  color: #eee;
  font-size: 16px; /* >=16px stops iOS Safari zooming on focus */
  font-family: Menlo, Consolas, "DejaVu Sans Mono", monospace;
}
.paste-actions { display: flex; justify-content: flex-end; gap: 8px; }
.paste-actions .primary { background: #0e639c; border-color: #0e639c; color: #fff; }
body.light #paste-box { background: #fff; }
body.light #paste-box h3 { color: #222; }
body.light #paste-text { background: #fff; color: #222; }
```

with:

```css
#paste-overlay {
  position: fixed;
  inset: 0;
  z-index: 70;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(6px);
  display: flex;
  align-items: center;
  justify-content: center;
}
#paste-box {
  background: var(--overlay);
  padding: 20px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  width: 380px;
  max-width: 92vw;
  display: flex;
  flex-direction: column;
  gap: 10px;
  box-shadow: var(--shadow);
}
#paste-box h3 { margin: 0; color: var(--text); }
#paste-box .hint { margin: 0; font-size: 12px; color: var(--text-dim); }
#paste-text {
  height: 120px;
  resize: vertical;
  padding: 10px;
  border-radius: var(--radius);
  border: 1px solid var(--border-strong);
  background: var(--bg);
  color: var(--text);
  font-size: 16px; /* >=16px stops iOS Safari zooming on focus */
  font-family: Menlo, Consolas, "DejaVu Sans Mono", monospace;
}
#paste-text:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.paste-actions { display: flex; justify-content: flex-end; gap: 8px; }
.paste-actions .primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.paste-actions .primary:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
```

Note: the three `body.light #paste-*` overrides are removed — tokens handle them.

- [ ] **Step 3: Convert the change-password overlay**

Replace:

```css
#chpw-overlay {
  position: fixed;
  inset: 0;
  z-index: 70;
  background: rgba(0, 0, 0, 0.75);
  display: flex;
  align-items: center;
  justify-content: center;
}
#chpw-form {
  background: #252526;
  padding: 24px;
  border-radius: 8px;
  width: 300px;
  max-width: 90vw;
  display: flex;
  flex-direction: column;
  gap: 12px;
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
}
#chpw-form h3 { margin: 0; color: #eee; text-align: center; }
#chpw-form input {
  padding: 10px;
  border-radius: 4px;
  border: 1px solid #555;
  background: #1e1e1e;
  color: #eee;
  font-size: 16px;
}
#chpw-form .hint { margin: 0; font-size: 13px; color: #f48771; text-align: center; }
#chpw-form .hint.ok { color: #89d185; }
.chpw-actions { display: flex; gap: 8px; }
.chpw-actions button { flex: 1; padding: 10px; font-size: 15px; }
.chpw-actions .primary { background: #0e639c; border-color: #0e639c; color: #fff; }
body.light #chpw-form { background: #fff; }
body.light #chpw-form h3 { color: #222; }
```

with:

```css
#chpw-overlay {
  position: fixed;
  inset: 0;
  z-index: 70;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(6px);
  display: flex;
  align-items: center;
  justify-content: center;
}
#chpw-form {
  background: var(--overlay);
  padding: 24px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  width: 320px;
  max-width: 90vw;
  display: flex;
  flex-direction: column;
  gap: 12px;
  box-shadow: var(--shadow);
}
#chpw-form h3 { margin: 0; color: var(--text); text-align: center; }
#chpw-form input {
  padding: 11px 12px;
  border-radius: var(--radius);
  border: 1px solid var(--border-strong);
  background: var(--bg);
  color: var(--text);
  font-size: 16px;
}
#chpw-form input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
#chpw-form .hint { margin: 0; font-size: 13px; color: var(--danger); text-align: center; }
#chpw-form .hint.ok { color: var(--ok); }
.chpw-actions { display: flex; gap: 8px; }
.chpw-actions button { flex: 1; padding: 11px; font-size: 15px; }
.chpw-actions .primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.chpw-actions .primary:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
```

Note: the two `body.light #chpw-*` overrides are removed.

- [ ] **Step 4: Convert the manage-users overlay**

Replace:

```css
#users-overlay {
  position: fixed;
  inset: 0;
  z-index: 70;
  background: rgba(0, 0, 0, 0.75);
  display: flex;
  align-items: center;
  justify-content: center;
}
#users-box {
  background: #252526;
  padding: 24px;
  border-radius: 8px;
  width: 360px;
  max-width: 92vw;
  display: flex;
  flex-direction: column;
  gap: 12px;
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
}
#users-box h3 { margin: 0; color: #eee; text-align: center; }
#users-box .hint { margin: 0; font-size: 13px; color: #f48771; text-align: center; }
#users-box .hint.ok { color: #89d185; }
#users-list { list-style: none; margin: 0; padding: 0; max-height: 40vh; overflow-y: auto; }
#users-list li { display: flex; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px solid #333; color: #ddd; }
#users-list .uname { flex: 1; }
#users-list .badge { font-size: 11px; color: #0e639c; border: 1px solid #0e639c; border-radius: 4px; padding: 0 6px; }
#users-list .del { background: transparent; border: 0; color: #f48771; cursor: pointer; }
#users-list .del[disabled] { color: #666; cursor: default; }
#users-create { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
#users-create input[type="text"], #users-create input[type="password"] {
  flex: 1 1 45%;
  padding: 8px;
  border-radius: 4px;
  border: 1px solid #555;
  background: #1e1e1e;
  color: #eee;
  font-size: 16px;
}
#users-create .nu-admin { display: flex; align-items: center; gap: 6px; color: #ccc; font-size: 13px; }
#users-create .primary { padding: 8px 12px; background: #0e639c; border-color: #0e639c; color: #fff; }
.users-actions { display: flex; justify-content: flex-end; }
.users-actions button { padding: 8px 14px; }
body.light #users-box { background: #fff; }
body.light #users-box h3 { color: #222; }
```

with:

```css
#users-overlay {
  position: fixed;
  inset: 0;
  z-index: 70;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(6px);
  display: flex;
  align-items: center;
  justify-content: center;
}
#users-box {
  background: var(--overlay);
  padding: 24px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  width: 380px;
  max-width: 92vw;
  display: flex;
  flex-direction: column;
  gap: 12px;
  box-shadow: var(--shadow);
}
#users-box h3 { margin: 0; color: var(--text); text-align: center; }
#users-box .hint { margin: 0; font-size: 13px; color: var(--danger); text-align: center; }
#users-box .hint.ok { color: var(--ok); }
#users-list { list-style: none; margin: 0; padding: 0; max-height: 40vh; overflow-y: auto; }
#users-list li { display: flex; align-items: center; gap: 8px; padding: 8px 0; border-bottom: 1px solid var(--border); color: var(--text); }
#users-list .uname { flex: 1; }
#users-list .badge { font-size: 11px; color: var(--accent); border: 1px solid var(--accent); border-radius: 999px; padding: 1px 8px; }
#users-list .del { background: transparent; border: 0; color: var(--danger); cursor: pointer; }
#users-list .del[disabled] { color: var(--text-dim); cursor: default; }
#users-create { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
#users-create input[type="text"], #users-create input[type="password"] {
  flex: 1 1 45%;
  padding: 9px 10px;
  border-radius: var(--radius);
  border: 1px solid var(--border-strong);
  background: var(--bg);
  color: var(--text);
  font-size: 16px;
}
#users-create input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
#users-create .nu-admin { display: flex; align-items: center; gap: 6px; color: var(--text-dim); font-size: 13px; }
#users-create input[type="checkbox"] { accent-color: var(--accent); }
#users-create .primary { padding: 9px 14px; background: var(--accent); border-color: var(--accent); color: #fff; }
.users-actions { display: flex; justify-content: flex-end; }
.users-actions button { padding: 8px 14px; }
```

Note: the two `body.light #users-*` overrides are removed.

- [ ] **Step 5: Verify each overlay**

Reload. The login card is a rounded, elevated panel over a blurred backdrop; focusing an input shows an indigo focus ring. In devtools, reveal each of `#paste-overlay`, `#chpw-overlay`, `#users-overlay` (remove their `hidden` class) and confirm each is a matching modern card with legible inputs and indigo primary buttons. Toggle light mode and re-check each — cards become white, text stays dark, accent stays indigo.

- [ ] **Step 6: Confirm no `body.light` per-selector overrides remain**

Run: `grep -c 'body.light ' web/css/style.css`
Expected: `0` (all per-selector light overrides are gone; only the token-defining `body.light { ... }` rule from Task 1 remains, which has no space-then-selector form).

- [ ] **Step 7: Commit**

```bash
git add web/css/style.css
git commit -m "feat(web): modernize login, paste, change-password, and users overlays"
```

---

### Task 5: Terminal palette + final verification pass

**Files:**
- Modify: `web/js/app.js` (the `THEMES` object, currently around lines 52-55)

**Interfaces:**
- Consumes: nothing new. This aligns the xterm terminal background with the Modern Slate chrome.

- [ ] **Step 1: Retune the terminal palette**

In `web/js/app.js`, replace:

```javascript
  const THEMES = {
    dark: { background: '#1e1e1e', foreground: '#d4d4d4', cursor: '#ffffff', selectionBackground: '#264f78' },
    light: { background: '#ffffff', foreground: '#1e1e1e', cursor: '#000000', selectionBackground: '#add6ff' },
  };
```

with:

```javascript
  const THEMES = {
    dark: { background: '#14161b', foreground: '#d4d4d4', cursor: '#ffffff', selectionBackground: '#3b3f8f' },
    light: { background: '#ffffff', foreground: '#1e1e1e', cursor: '#000000', selectionBackground: '#c7d2fe' },
  };
```

- [ ] **Step 2: Verify the terminal harmonizes**

Reload. The terminal background is now a soft near-black (`#14161b`) that sits just under the toolbar rather than a flat `#1e1e1e`. Foreground text remains clearly readable. If you can log in, select text and confirm the selection highlight is indigo-tinted and legible. Toggle light mode — terminal stays white with a light indigo selection.

- [ ] **Step 3: Full dark/light/mobile pass**

With `http://localhost:8000` open:
- Dark mode: toolbar, pill tabs, menu, keybar, and all overlays are consistent Modern Slate with indigo accents.
- Run `document.body.classList.toggle('light')`: everything flips to the light palette; nothing becomes unreadable (no dark-on-dark or light-on-light).
- Narrow the window to ≤640px (or use devtools device mode): toolbar tightens, tabs cap at 120px, keybar keys stay ≥44px tall and tappable.

- [ ] **Step 4: Confirm no legacy chrome colours survive anywhere in the CSS**

Run: `grep -nE '#1e1e1e|#252526|#0e639c|#2d2d2e|#3a3d41|#4a4d51|#6e1f1f|#8a2a2a|#f48771|#89d185|#264f78|#add6ff|#e7e7e7|#ececec|#f3f3f3' web/css/style.css`
Expected: no matches (every legacy hard-coded chrome colour has been replaced by a token).

- [ ] **Step 5: Confirm the existing JS test still passes**

Run: `node --test web/test/scroll-routing.test.js`
Expected: tests pass (this change is cosmetic and must not affect scroll routing).

- [ ] **Step 6: Commit**

```bash
git add web/js/app.js
git commit -m "feat(web): harmonize terminal palette with Modern Slate chrome"
```

---

## Self-Review

**Spec coverage:**
- Design tokens (`:root` + `body.light`) → Task 1. ✅
- Body/base → Task 1. ✅
- Toolbar + status dot → Task 2. ✅
- Tabs (indigo active) → Task 2. ✅
- Buttons unified (default/primary/danger + focus-visible) → Task 3. ✅
- Overflow menu → Task 3. ✅
- Keybar + modifier latched/locked → Task 3. ✅
- Overlays login/paste/change-password/users (cards, focus rings, 16px inputs, blur backdrop) → Task 4. ✅
- Terminal palette tweak (`THEMES`, dark `#14161b`, indigo selection) → Task 5. ✅
- Light theme modernized → tokens in Task 1 + per-section conversions; `body.light` override removal verified in Task 4 Step 6. ✅
- Mobile responsiveness preserved (`@media` untouched, ≥44px targets) → Task 4 note + Task 5 Step 3. ✅
- No new deps / no HTML structure change → Global Constraints; only colour edits to app.js and one meta line in index.html. ✅
- `scroll-routing.test.js` still green → Task 5 Step 5. ✅

**Placeholder scan:** No TBD/TODO; every code step shows complete CSS/JS. ✅

**Type/name consistency:** Token names used in Tasks 2–5 (`--bg`, `--surface`, `--surface-2`, `--overlay`, `--border`, `--border-strong`, `--text`, `--text-dim`, `--accent`, `--accent-hover`, `--accent-soft`, `--danger`, `--danger-soft`, `--ok`, `--warn`, `--radius`, `--radius-lg`, `--shadow`, `--transition`) all match the definitions in Task 1. ✅
