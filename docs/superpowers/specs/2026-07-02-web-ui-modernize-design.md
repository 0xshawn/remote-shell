# Web UI Modernization — Modern Slate

**Date:** 2026-07-02
**Status:** Approved (pending implementation)
**Scope:** Restyle the web terminal's chrome and subtly tune the terminal palette. Cosmetic only.

## Goal

Make the web UI more modern, clean, and beautiful without changing layout or behavior.
Direction: **Modern Slate** — neutral slate/zinc surfaces, soft elevation, indigo accent.

## Background

`web/` is a mobile-friendly web terminal built on xterm.js. It is vanilla
HTML/CSS/JS — no framework, no build step, all assets self-hosted (no CDN, since
the app may run offline over plain HTTP and is baked into the server image).

Visible surfaces:
- Toolbar: status dot, tab strip, keyboard toggle, Paste button, overflow menu.
- Terminal area (xterm panes, one per tab).
- Touch keybar (helper keys, modifier latched/locked states).
- Four overlays: login, paste fallback, change-password, manage-users.

Current look is a functional VS Code dark theme (`#1e1e1e` / `#252526` /
`#0e639c`) with a matching light theme via `body.light`. Colors are hard-coded
~40 times across `web/css/style.css`.

## Approach

Introduce **CSS custom properties (design tokens)** at `:root` (dark) and
`body.light`, then make every rule reference them. This centralizes the palette
so both themes — and any future accent change — are one-line edits.

No HTML structure changes. Every `id`/`class` that `web/js/app.js` reads is
preserved, so behavior is untouched. The only JS edit is the `THEMES` color
object.

### Design tokens (dark theme, `:root`)

| Token | Value | Use |
| --- | --- | --- |
| `--bg` | `#0f1115` | app background |
| `--surface` | `#171a21` | toolbar, keybar |
| `--surface-2` | `#1b1f27` | tabs, buttons, inputs |
| `--overlay` | `#1e222b` | menu + modal cards |
| `--border` | `rgba(255,255,255,.08)` | hairline borders |
| `--border-strong` | `rgba(255,255,255,.14)` | inputs, emphasized edges |
| `--text` | `#e5e7eb` | primary text |
| `--text-dim` | `#9aa3b2` | hints, secondary text |
| `--accent` | `#6366f1` | indigo accent (active tab, primary btn) |
| `--accent-hover` | `#7c7ff2` | accent hover |
| `--danger` | `#ef4444` | destructive actions |
| `--ok` | `#34d399` | success text, connected dot |
| `--radius` | `8px` | buttons, tabs, inputs |
| `--radius-lg` | `12px` | menu, modal cards |
| `--shadow` | `0 10px 30px rgba(0,0,0,.45)` | elevated surfaces |
| `--transition` | `.15s ease` | hover/active/focus |

Light theme (`body.light`) redefines the same token names: near-white surfaces
(`#ffffff` / `#f6f7f9` / `#eef0f3`), slate text (`#1f2430` / `#5b6472`), slate
borders, softer shadow, and the **same indigo accent** for continuity.

## Component-level changes

1. **Body / base** — `--bg` background, `--text` color; keep the existing
   `system-ui` font stack.
2. **Toolbar** — `--surface` background, hairline `--border` bottom, consistent
   spacing. Status dot gains a soft colored glow per state (on `--ok`,
   off `--danger`, connecting amber).
3. **Tabs** — pill tabs; active tab uses `--accent` (calmer than today's bright
   `#0e639c`); smooth hover via `--transition`; refined close button.
4. **Buttons (unified system)** — three token-driven variants:
   - *default*: `--surface-2` fill, `--border` edge.
   - *primary* (`.primary`): `--accent` fill.
   - *danger* (`.danger`): `--danger` fill/text.
   Add `transition` on hover/active and a `:focus-visible` ring for keyboard a11y.
5. **Overflow menu** — `--overlay` surface, `--radius-lg`, `--shadow`,
   indigo-tinted hover.
6. **Keybar** — refined key surfaces, touch targets kept ≥44px. Modifier states:
   *latched* = accent fill; *locked* = accent fill + inset ring.
7. **Overlays (login / paste / change-password / manage-users)** — modern cards:
   `--radius-lg`, `--overlay` surface, `--shadow`, backdrop with a light blur;
   inputs get `--border-strong` + a focus ring; **keep `font-size:16px` on inputs**
   (prevents iOS Safari zoom-on-focus). Login title gets subtle polish.
8. **Terminal palette (`web/js/app.js` `THEMES`)** — the only JS edit, colors only:
   - dark: `background` `#1e1e1e` → `#14161b` (sits under the chrome),
     foreground stays high-contrast/readable, `selectionBackground` tinted toward
     indigo (`#3b3f8f` range).
   - light: stays near-white; `selectionBackground` lightly indigo-tinted.

## Non-goals / constraints

- No layout restructure, no behavior/logic changes.
- No framework, no build step, no CDN, no new bundled assets.
- Both **dark and light** themes modernized together.
- Mobile responsiveness and existing `@media (max-width: 640px)` rules preserved.

## Files touched

- `web/css/style.css` — rewritten around tokens (bulk of the work).
- `web/js/app.js` — `THEMES` object colors only (~2 lines).

## Verification

No visual test suite exists. Success criteria — load `index.html` in a browser
and confirm, in **both dark and light** themes:

- Toolbar, tabs, overflow menu, keybar, login, and all overlays render cleanly.
- Terminal text stays readable (adequate contrast) against the softened bg.
- Layout holds at mobile widths (≤640px); touch targets remain comfortable.
- Theme toggle still switches all surfaces (tokens flip correctly).

The existing `web/test/scroll-routing.test.js` is behavior-only and unaffected.

**Deploy note:** the live server bakes `web/` into its image, so seeing changes
on the real server requires a rebuild + container recreate. Local `index.html`
review requires no rebuild.
