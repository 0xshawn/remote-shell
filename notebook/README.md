# notebook

A **Jupyter-style web client for Claude Code**. After logging in you land in a
normal web **shell**; a **"+ Claude"** button opens a Claude Code session
rendered as a notebook — structured cells for your input, streamed assistant
text, tool calls + results, thinking, and a live status. Run several Claude
sessions at once and switch between them as tabs; refresh the page and each
session's history is still there.

```
Browser (React)
  ├── /ws    ─ shell tab  ─ node-pty ─ tmux ─ persistent shell   (reused from remote-shell)
  └── /nbws  ─ claude tab ─ per-turn `claude --print` child ─ stream-json
                                   │
                          normalizer → NotebookStore (server-owned cell history)
```

## How a Claude session works

The server does **not** screen-scrape Claude's interactive TUI. It drives Claude
in **streaming-JSON** mode and normalizes the structured event stream into a cell
model:

- Each session is a UUID. The server owns the notebook **history** (an in-memory
  ordered list of cells), independent of any live process — so a refresh or
  reconnect just replays it.
- Each user turn spawns a fresh child:
  `claude --print --input-format stream-json --output-format stream-json --include-partial-messages --replay-user-messages --verbose` with `--session-id <uuid>` on the first turn and `--resume <uuid>` after. Context continues across turns via `--resume`; a dead child between turns is normal.
- The normalizer (`src/normalizer.js`) turns events into cells: `system`, `user`,
  `assistant_text` (streamed), `thinking`, `tool_call` (with input + merged
  result), `result`, `error`. Token deltas build cells live; tool results
  (which arrive as later `user` events) are merged back by `tool_use_id`.

The shell side is the proven tmux-backed mechanism from `../server` (sessions
survive refresh/disconnect via tmux).

## Quick start (dev — two processes)

Requirements: **Node ≥ 18**, **tmux**, a C toolchain for `node-pty`
(`python3`, `make`, `g++`), and the **`claude`** CLI on PATH (logged in, or with
`ANTHROPIC_API_KEY` set).

```bash
# terminal 1 — API + WebSocket server (default port 7682)
cd notebook/server
npm install
node src/server.js --no-auth --permission-mode bypassPermissions   # local dev only

# terminal 2 — Vite dev server (proxies /api, /ws, /nbws to :7682)
cd notebook/web
npm install
npm run dev      # open http://localhost:5174
```

If you omit `--no-auth`, set `--username`/`--password` (a random password is
printed on boot if you don't). For real use, run behind TLS and **do not** use
`bypassPermissions`.

## Production (single server)

```bash
cd notebook/web && npm install && npm run build      # emits web/dist
cd ../server && npm install
node src/server.js --username admin --password secret # serves web/dist + API
# open http://localhost:7682
```

The server serves `web/dist` if present (falling back to `server/public`).

## Docker (runs shell + claude on the HOST as your user)

The container only hosts the web server. To make the **shell tab and the claude
child run in your real host environment** (your dotfiles, `PATH`, installed
tools, and your own `claude` config/auth) instead of the container's, the
container SSHes back to the host — the same pattern as the sibling `server/`
project. It's published on `0.0.0.0`, reachable at
`http://<host-ip>:<NOTEBOOK_PORT>`. Put it behind your own TLS/reverse-proxy if
you need encryption.

```bash
cd notebook
cp .env.example .env          # set AUTH_PASS, TOKEN_SECRET, NOTEBOOK_PORT, SSH_USER, CLAUDE_BIN/CWD/ENV
docker compose up -d --build
# open http://<host-ip>:8088   (NOTEBOOK_PORT; find the IP with `hostname -I`)
```

`NOTEBOOK_PORT` sets the published host port — choose one your firewall allows
(e.g. anything in `8080-9090`). Change it in `.env` and re-run `docker compose up -d`.

### One-time SSH-to-host setup

The host must run `sshd`. Generate the container's key (persisted in the
`notebook-home` volume) and authorize it for your host user:

```bash
# 1) generate the key inside the container
docker exec -u notebook notebook sh -c \
  'mkdir -p ~/.ssh && chmod 700 ~/.ssh && \
   [ -f ~/.ssh/id_hostshell ] || ssh-keygen -t ed25519 -N "" -C notebook-container -f ~/.ssh/id_hostshell'

# 2) authorize its public key for your host user (restricted to the docker subnet)
PUB=$(docker exec notebook cat /home/notebook/.ssh/id_hostshell.pub)
printf 'from="172.16.0.0/12" %s\n' "$PUB" >> ~/.ssh/authorized_keys
```

Set in `.env`:

- `SSH_USER` — your host username (whose `authorized_keys` you just edited).
- `CLAUDE_BIN` — absolute path to the host's `claude` (`which claude` on the host;
  its directory is added to `PATH` so a co-located `node`, e.g. nvm, is found).
- `CLAUDE_CWD` — host working directory for new claude sessions.
- `CLAUDE_ENV` — extra env for claude; set `CLAUDE_CONFIG_DIR` here so claude
  reuses your host config + auth (`echo $CLAUDE_CONFIG_DIR` on the host; defaults
  to `~/.claude`). This is where the Claude credentials come from — no
  `ANTHROPIC_*` keys are passed to the container.

To run **without** SSH (a plain in-container shell + claude), leave `SSH_HOST`
empty in `docker-compose.yml`.

```bash
docker compose logs -f       # follow logs
docker compose down          # stop (keeps the volume)
```

## Configuring the Claude launch profile

The `claude` invocation is fully configurable (CLI flag or env var). A new
session inherits these defaults; `cwd`, `model`, `permissionMode`, and `label`
can also be overridden per session via `POST /api/sessions`.

| Flag | Env | Default | Description |
|------|-----|---------|-------------|
| `--claude-command <path>` | `CLAUDE_BIN` | `claude` | The claude binary to launch |
| `--claude-arg <arg...>` | `CLAUDE_EXTRA_ARGS` | – | Extra args appended to every invocation |
| `--claude-model <model>` | `CLAUDE_MODEL` | *(CLI default)* | `--model` passed to claude |
| `--permission-mode <mode>` | `CLAUDE_PERMISSION_MODE` | `acceptEdits` | `default`/`acceptEdits`/`auto`/`bypassPermissions` |
| `--claude-cwd <dir>` | `CLAUDE_CWD` | `--cwd` | Working dir for new claude sessions |
| `--claude-env <K=V...>` | `CLAUDE_ENV` | – | Env vars injected into the child (e.g. `CLAUDE_CONFIG_DIR=…`) |
| `--max-claude-sessions <n>` | `MAX_CLAUDE_SESSIONS` | `0` | Cap concurrent claude sessions (0 = unlimited) |
| `--claude-idle-timeout <min>` | `CLAUDE_IDLE_TIMEOUT` | `0` | Drop an idle claude session after N min (0 = never) |
| `--capture <dir>` | `CLAUDE_CAPTURE_DIR` | – | Dev: tee raw stream-json lines per session (for fixtures) |

Server/shell options (`--port`, `--host`, `--username`, `--password`,
`--token-secret`, `--ssl-key/--ssl-cert`, `--shell`, `--cwd`, `--ssh-*`,
`--max-sessions`, `--timeout`, `--no-auth`, `--log-level`, `--log-io`) match
`../server` — see that project's README.

## Tests

```bash
cd notebook/server && npm test    # normalizer fixture tests (node:test)
```

Fixtures in `server/test/fixtures/*.jsonl` are real captures from the `claude`
binary. To regenerate or add cases, run a session with `--capture <dir>` and
copy the resulting `<uuid>.jsonl`.

## UI

- Assistant replies render as **markdown** (GFM tables/lists) with **syntax-highlighted** code blocks; text streams as plain until the turn finalizes, then upgrades to markdown.
- **Tool calls** are collapsible cells showing the tool name, a one-line argument summary, a live spinner, the full input, and the merged result (with copy buttons). **Thinking** is a collapsible dimmed cell.
- Tabs show a **live status dot** per Claude session (idle/running/error), so you can see a backgrounded session finish.
- The **+ Claude** button opens a dialog to set the session's working directory, model, and permission mode (all optional → server defaults).
- Auto-growing composer (Enter to send, Shift+Enter for newline; **Stop** interrupts a running turn), and a scroll-to-bottom button when you scroll up.

## Notes & deliberate choices

- **`auth.js`, `logger.js`, `shellManager.js`, `tmux.conf` are copied** from
  `../server` rather than shared via a package — intentional, to keep the
  existing untooled project free of a workspace/build dependency.
- **Normalize from stdout, not the on-disk transcript.** Claude's
  `~/.claude/projects/.../<uuid>.jsonl` has a different schema and is sensitive
  to `CLAUDE_CONFIG_DIR`; the stdout stream is the stable source.
- **v1 scope:** tool permissions use a preset `--permission-mode` (no
  interactive approval UI yet — `waiting_input` status is reserved for it).
  Claude cell history is in-memory, so a **server** restart drops it (shell
  tabs still survive via tmux). Still to come: per-tool diff rendering for
  Edit/Write, and interactive permission approval.
