# remote-shell

A browser-based interactive shell (like ttyd / webtty) whose **defining feature is
session persistence**: refresh the page, close the tab, or switch devices, then
reopen the same URL and you resume the *exact* same shell — working directory,
environment variables, running processes, and command history all intact.

It does this by transparently backing every session with **tmux**. You never type
a tmux command; the system attaches/detaches for you.

---

## How persistence works

```
Browser (xterm.js) ──WebSocket──► Node ──spawn──► node-pty ──► tmux client ──► persistent shell
                                                       ▲                            ▲
                                          lives only while the WS is open    held by the tmux server
                                                                              (survives WS close & app restart)
```

- A WebSocket connects → the server runs `tmux new-session -A -s <key>`
  (attach if it exists, otherwise create).
- The WebSocket closes (refresh / tab close / network drop) → the server kills only
  the **node-pty**, which *detaches* the tmux client. The tmux session keeps running.
- You reconnect → a new pty re-attaches and tmux repaints the screen. **Nothing was lost.**

Because the tmux server is a process separate from the Node app, sessions even
survive the Node app crashing or restarting (e.g. `nodemon`, a deploy, a panic).

> Each session is namespaced as `rs_<user>_<sessionId>`, so one user can never
> attach to another user's session.

### What survives, what doesn't

| Event | Survives? |
|-------|-----------|
| Page refresh / tab close / browser quit | ✅ |
| Switching to another device (same URL/session id) | ✅ |
| Node app restart or crash | ✅ (tmux server keeps running) |
| Full container / host restart | ❌ (in-memory tmux server dies — by design) |
| Configured idle timeout reached while detached | ❌ (reaped on purpose) |

---

## Quick start (local)

Requirements: **Node ≥ 18** and **tmux** installed, plus a C toolchain for `node-pty`
(`python3`, `make`, `g++`).

```bash
npm install
node src/server.js --username admin --password secret
# open http://localhost:7681
```

If you omit `--password`, a random one is generated and printed on startup.

Open the page, sign in, and you have a shell. Refresh the page — you are right
back where you were.

### Try the persistence

1. In the web terminal run: `cd /tmp && export FOO=bar && top`
2. Refresh the browser (or close and reopen the tab).
3. You are still in `/tmp`, `top` is still running, `echo $FOO` still prints `bar`.

---

## Docker

```bash
cp .env.example .env        # edit AUTH_USER / AUTH_PASS / TOKEN_SECRET / SERVER_NAME
docker compose build
docker compose up -d
```

- App listens on `127.0.0.1:7681` (host) and is proxied by nginx on `:8443`
  (HTTP `:8080` redirects to it). These are off 80/443 to avoid clashing with an
  existing reverse proxy; change them in `docker-compose.yml` if you like.
- The domain is config, not code: set `SERVER_NAME` in `.env` (e.g.
  `SERVER_NAME=shell.example.com`). It is injected into `nginx/default.conf.template`
  via the nginx image's envsubst at startup. Empty/unset = catch-all `_`.
- Put TLS certs in `nginx/certs/fullchain.pem` and `nginx/certs/privkey.pem`.
- To skip nginx and expose the app directly, change the port mapping to
  `"7681:7681"` and remove the `nginx` service.

The `shell-home` volume persists the user's home directory across container
recreation. (tmux sessions themselves still end on a full container restart.)

---

## Logging into the host instead of the container

By default the web terminal is the shell *inside* the container. To make it log
into the **host** instead, run the container in SSH mode: the container-side tmux
launches `ssh <user>@<host>`, so a refresh still resumes the same host shell
(the container tmux holds the connection open while the browser is away).

`docker-compose.yml` enables this out of the box via `host.docker.internal` and
these env vars (override in `.env`):

| Env | Default | Meaning |
|-----|---------|---------|
| `SSH_HOST` | `host.docker.internal` | Host to SSH into (empty = use the container's own shell) |
| `SSH_USER` | `youruser` | Host username |
| `SSH_PORT` | `22` | Host SSH port |
| `SSH_KEY` | `/home/shell/.ssh/id_hostshell` | Private key inside the container |

One-time setup (key lives in the `shell-home` volume, so it persists):

```bash
# 1) generate a keypair inside the container
docker exec remote-shell sh -c \
  'mkdir -p ~/.ssh && chmod 700 ~/.ssh && \
   [ -f ~/.ssh/id_hostshell ] || ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_hostshell -C remote-shell-container; \
   cat ~/.ssh/id_hostshell.pub'

# 2) authorize that public key on the host (scoped to the docker subnet)
PUB=$(docker exec remote-shell cat /home/shell/.ssh/id_hostshell.pub)
mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys
echo "from=\"172.16.0.0/12\" $PUB" >> ~/.ssh/authorized_keys
```

The `from="172.16.0.0/12"` prefix restricts this key to connections originating
from Docker networks. Without a key you can instead leave `SSH_KEY` empty and the
host password is prompted in the terminal on each new session (refreshes still
resume without re-auth).

> Security: this gives browser users a full shell **on the host**. Keep it behind
> auth + TLS and trusted networks only.

## CLI options

| Flag | Env | Default | Description |
|------|-----|---------|-------------|
| `-p, --port <n>` | `PORT` | `7681` | Listen port |
| `-H, --host <h>` | `HOST` | `0.0.0.0` | Listen address |
| `-s, --shell <path>` | `SHELL_PATH` | `$SHELL` or `/bin/bash` | Shell to launch |
| `-c, --cwd <dir>` | `WORK_DIR` | home dir | Initial working dir for **new** sessions |
| `-u, --username <name>` | `AUTH_USER` | `admin` | Auth username |
| `-k, --password <pass>` | `AUTH_PASS` | *(random)* | Auth password |
| `--token-secret <s>` | `TOKEN_SECRET` | *(random)* | Secret for signing tokens — set a stable one in prod |
| `--ssl-key <file>` | `SSL_KEY` | – | TLS private key (enables built-in HTTPS) |
| `--ssl-cert <file>` | `SSL_CERT` | – | TLS certificate |
| `--timeout <min>` | `SESSION_TIMEOUT` | `0` | Reap a detached+idle session after N minutes (0 = never) |
| `--max-sessions <n>` | `MAX_SESSIONS` | `0` | Cap concurrent sessions (0 = unlimited) |
| `--no-auth` | – | – | Disable auth (local dev only — never expose) |
| `--log-level <lvl>` | `LOG_LEVEL` | `info` | `error\|warn\|info\|debug` |
| `--log-io` | – | off | Record per-session terminal I/O under `./logs` (privacy sensitive) |

### Built-in HTTPS (without nginx)

```bash
node src/server.js --ssl-key key.pem --ssl-cert cert.pem --port 8443
```

---

## Sessions & multi-user

- The session id comes from `?session=<id>` in the URL; if absent, the client
  generates one, stores it in `localStorage`, and writes it back into the URL.
  So a plain refresh resumes the same shell, and the URL is shareable/bookmarkable.
- Open `/?session=work` and `/?session=play` for two independent persistent shells.
- Auth is a single configured username/password by default. Sessions are isolated
  per authenticated user (`rs_<user>_<id>`), so the model extends to multiple users
  by issuing them different credentials.

---

## Terminal UX

- **Scrollback**: mouse wheel scrolls tmux history (100k lines).
- **Copy**: select with the mouse (auto-copies on desktop), or `Ctrl/Cmd+Shift+C`,
  or the **Copy** button. With mouse mode on, hold **Shift** while dragging to force
  a browser-native selection.
- **Paste**: `Ctrl/Cmd+Shift+V`, the **Paste** button, or your browser's paste.
- **Mobile**: responsive layout, a helper key row (Esc, Tab, Ctrl-C/D/Z, arrows, etc.),
  and font-size controls. Tap the terminal to bring up the virtual keyboard.
- **Toolbar**: font size, light/dark theme, clear, reconnect, disconnect (keeps the
  session), and **Kill** (destroys the persistent session).

---

## Security notes

- Always run behind TLS (nginx or `--ssl-*`) — a shell over plaintext is dangerous.
- Set a stable, strong `TOKEN_SECRET` in production.
- `--no-auth` is for local development only.
- This grants full shell access as the user the app runs as. Run it as an
  unprivileged user (the Docker image already does) and restrict network exposure.

---

## Design choices & trade-offs

- **tmux vs. in-memory PTY保活**: an in-memory session manager avoids the tmux
  dependency but loses every session (and running process) when the Node process
  restarts, and requires hand-rolling scrollback + screen restore. tmux gives true
  process survival and native redraw for free. Your requirement ("transparent, no
  manual tmux") points squarely at this approach.
- **Raw `ws` + 1-byte-prefixed frames** instead of Socket.io: lower latency and
  overhead for a high-throughput terminal stream; `'0'`=data, `'1'`=JSON control.
- **No frontend build step**: xterm.js is served straight from `node_modules`, so
  the project runs with a single `npm install`.

---

## Project layout

```
src/
  server.js         HTTP/WS server, auth gate, wire protocol
  sessionManager.js tmux-backed session lifecycle (attach/detach/reap)
  auth.js           HMAC-signed tokens + credential check
  config.js         CLI/env parsing
  logger.js         tiny leveled logger
  tmux.conf         transparent tmux config (status bar off, big history, persist)
public/
  index.html, css/style.css, js/app.js   xterm.js frontend
Dockerfile, docker-compose.yml, nginx/default.conf.template
```
