# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A monorepo for **remote-shell**: a browser-based (and native Android) interactive
shell whose defining feature is **session persistence** — refresh, close the tab,
or switch devices and you resume the *exact* same shell (cwd, env, running
processes, history). It does this **without tmux**: the Go server forks a PTY
directly (`creack/pty`) and keeps a per-session in-memory **ring buffer**; the
client owns scrollback and a reconnect repaints from the buffer.

```
Client (xterm.js/WebGL, or Android Termux emulator)
   │  POST /api/login {user,pass} ─► HMAC token
   │  WS /ws?token&session&cols&rows
   ▼
Go gateway ──fork──► PTY ──► bash/zsh (or `ssh host`)
   │
   per-session ring buffer  (survives WS close → reconnect replays)
```

## Layout

| Path | What |
|------|------|
| `server/` | Go gateway (Go ≥ 1.26). PTY + ring-buffer persistence, WebSocket wire protocol, HMAC auth, multi-user store. |
| `web/`    | Frontend: xterm.js + WebGL. **No build step** — vendored addons in `web/vendor/`, plain ES in `web/js/`. |
| `android/`| Native client: Kotlin + Jetpack Compose, with Termux's `terminal-emulator`/`terminal-view` vendored as local Gradle modules. Speaks the same login + WS protocol. |
| `deploy/` | Dockerfile, docker-compose (server + nginx TLS proxy), self-signed cert bootstrap. |
| `docs/superpowers/` | Design specs + implementation plans (one per feature). |

Root `install.sh` (Docker) and `install-binary.sh` (self-contained binary) are the
end-user installers; both have an `uninstall` subcommand.

## Commands

**Server (Go)** — all `go` commands run from `server/`:
```bash
cd server && go build -o remote-shell . && cd ..
WEB_DIR=web ./server/remote-shell --no-auth      # run locally, http://localhost:7681
go test ./...                                     # from server/ — unit + e2e (real HTTP+WS stack)
go test -run TestMultiDeviceTakeoverE2E ./...      # a single test
```
Tests use `/bin/cat` or `/bin/sh` as the shell so they don't need a real login shell.

**Web** — no bundler. Tests are plain `node:test`, run from the repo root:
```bash
node --test                          # all web tests
node --test web/test/scroll-routing.test.js
```

**Android** — from `android/`, needs the Android SDK (compileSdk 34) + JDK 17. The
SDK lives at `~/Android/Sdk`; pass it inline rather than editing `local.properties`:
```bash
ANDROID_HOME=~/Android/Sdk ./gradlew :app:assembleDebug     # --offline works if deps are cached
# APK -> app/build/outputs/apk/debug/app-debug.apk
```

## Architecture notes (the non-obvious parts)

**Wire protocol** (shared by web + Android) — WebSocket **UTF-8 text frames**, each
with a 1-byte op prefix:
- client→server: `'0'<data>` input · `'1'<json>` control (`{cmd:'resize',...}` / `{cmd:'kill'}`)
- server→client: `'0'<data>` output · `'1'<json>` event (`{event:'session'|'ended'|'superseded'|'error'}`)

Tokens are HMAC-SHA256 self-contained (`base64url(payload).base64url(sig)`), so
there's **no session store**. Auth lives in `server/auth.go`; the persisted
multi-user store (with admin flag) is `server/users.go`.

**Persistence & takeover** (`server/session.go`) — the heart of the system:
- `session.readLoop` always pumps PTY output into the ring buffer, even with no
  client attached. WS close only *detaches*; the PTY keeps running.
- **"Last attach wins"**: a second device attaching to the same session supersedes
  the first (sends `superseded`, closes it via `closeWith` so the frame is flushed
  before the socket drops) instead of the two ping-ponging over the single slot.
- `splitUTF8` holds back a trailing incomplete multibyte sequence so no frame
  splits a CJK char; `stripQueries` strips terminal *query* sequences (OSC color
  queries, CSI DSR/DA) from **replayed** scrollback — otherwise xterm auto-replies
  into the live shell as garbage on reconnect.
- Sessions live in process memory: a server restart/crash loses them by design.
  A detached+idle session is reaped after `--timeout` minutes (default 14 days).

**Local vs SSH backend** (`config.commandFor`) — the PTY runs either the local
`--shell`, or `ssh <user>@<host>` so the web terminal is the *host* user's shell
(the default Docker deployment). In SSH mode the shell lives on the host over the
container's held-open SSH connection.

**Web serving & the embed gotcha** (`server/web_embed.go`) — the server serves
`WEB_DIR` from disk when it exists (dev, container), else an **embedded** copy.
Normal builds embed only `web/.gitkeep`; the **release binary** needs the real
frontend, so `.github/workflows/release.yml` stages `web/` into `server/web/`
*before* `go build` (the embed can't reach `../web` since go.mod is rooted at
`server/`). Static assets are served `Cache-Control: no-cache` so a redeploy is
picked up immediately.

**Deploy** — Docker build context is the **repo root** (compose is one level up)
so the image can COPY both `server/` and `web/`. `web/` is baked into the image:
editing `web/` does not change a running container — rebuild the image and recreate
the container. nginx fronts the app on `:8443` (TLS) → app on `127.0.0.1:7681`.

**Android** — reuses Termux's terminal emulator/view but strips the local-pty JNI
backend; `TerminalSession.java` is reimplemented as a thin WebSocket-backed session
so the emulator renders server bytes and sends keystrokes back. `net/HttpClients.kt`
**always accepts self-signed certs** (like `curl -k`) since the server usually ships
one. (Note: `android/README.md` still describes the old Node+tmux server; the actual
backend is this Go/PTY server — the protocol it documents is still accurate.)

## MCP Tools: code-review-graph

**IMPORTANT: This project has a knowledge graph. ALWAYS use the
code-review-graph MCP tools BEFORE using Grep/Glob/Read to explore
the codebase.** The graph is faster, cheaper (fewer tokens), and gives
you structural context (callers, dependents, test coverage) that file
scanning cannot.

### When to use graph tools FIRST

- **Exploring code**: `semantic_search_nodes` or `query_graph` instead of Grep
- **Understanding impact**: `get_impact_radius` instead of manually tracing imports
- **Code review**: `detect_changes` + `get_review_context` instead of reading entire files
- **Finding relationships**: `query_graph` with callers_of/callees_of/imports_of/tests_for
- **Architecture questions**: `get_architecture_overview` + `list_communities`

Fall back to Grep/Glob/Read **only** when the graph doesn't cover what you need.

### Key Tools

| Tool | Use when |
| ------ | ---------- |
| `detect_changes` | Reviewing code changes — gives risk-scored analysis |
| `get_review_context` | Need source snippets for review — token-efficient |
| `get_impact_radius` | Understanding blast radius of a change |
| `get_affected_flows` | Finding which execution paths are impacted |
| `query_graph` | Tracing callers, callees, imports, tests, dependencies |
| `semantic_search_nodes` | Finding functions/classes by name or keyword |
| `get_architecture_overview` | Understanding high-level codebase structure |
| `refactor_tool` | Planning renames, finding dead code |

### Workflow

1. The graph auto-updates on file changes (via hooks).
2. Use `detect_changes` for code review.
3. Use `get_affected_flows` to understand impact.
4. Use `query_graph` pattern="tests_for" to check coverage.
