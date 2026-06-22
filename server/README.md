# remote-shell server (Go)

A browser-based interactive shell whose defining feature is **session
persistence**: refresh the page, close the tab, or switch devices, then reopen
the same URL and you resume the *exact* same shell — working directory,
environment, running processes, and history intact.

It does this **without tmux**. The server forks a PTY directly (`creack/pty`) and
keeps a per-session in-memory **ring buffer** of the terminal output. The browser
(xterm.js + WebGL, 50k-line scrollback) owns all scrolling; on reconnect the
server replays the ring buffer so the screen repaints instantly.

```
Browser (xterm.js + WebGL) ──WebSocket──► Go gateway ──fork──► PTY ──► bash/zsh (or `ssh host`)
        owns 50k scrollback                    │
                                       per-session ring buffer
                                       (survives WS close → reconnect repaints)
```

## How persistence works

- A WebSocket connects → the server gets (or creates) the session for
  `(user, sessionId)` and replays its ring buffer to the new client.
- The PTY's output is *always* written to the ring buffer, and to the live
  client when one is attached.
- The WebSocket closes (refresh / tab close / network drop) → the server only
  **detaches** the client. The PTY keeps running and keeps filling the ring
  buffer. **Nothing is lost.**
- You reconnect → the buffer is dumped to the new client and live output resumes.

"Last tab wins": opening the same session in a second tab takes over the PTY and
drops the first tab.

### What survives, what doesn't

| Event | Survives? |
|-------|-----------|
| Page refresh / tab close / browser quit | ✅ |
| Switching to another device (same session id) | ✅ |
| App **restart** or crash | ❌ (sessions live in process memory — by design) |
| Configured idle timeout reached while detached | ❌ (reaped on purpose) |

In SSH mode (below) the shell itself lives on the host over an SSH connection the
container holds open, so a browser refresh resumes the host shell; a container
restart drops the SSH connection and ends it.

## Quick start (local)

Requirements: **Go ≥ 1.26**. From the repo root (so it can find `web/`):

```bash
cd server && go build -o remote-shell . && cd ..
WEB_DIR=web ./server/remote-shell --no-auth          # local container/host shell
# open http://localhost:7681
```

With auth:

```bash
WEB_DIR=web ./server/remote-shell --username admin --password secret
```

If you omit `--password`, a random one is generated and printed on startup.

### Try the persistence

1. In the web terminal: `cd /tmp && export FOO=bar && top`
2. Refresh the browser.
3. You are still in `top`; `echo $FOO` prints `bar`; cwd is still `/tmp`.

## Docker (from the repo root)

The compose file lives at the repo root and builds the server + bakes in `web/`:

```bash
cp .env.example .env        # edit AUTH_USER / AUTH_PASS / TOKEN_SECRET / SSH_USER
docker compose build
docker compose up -d
```

- App listens on `127.0.0.1:7681`; nginx proxies it on `:8443` (HTTP `:8080`
  redirects). Put TLS certs in `server/nginx/certs/` as `fullchain.pem` /
  `privkey.pem`. To skip nginx, map `"7681:7681"` and drop the `nginx` service.
- `SERVER_NAME` in `.env` sets the nginx domain (empty = catch-all `_`).
- The `shell-home` volume persists the container user's home (and the SSH key).

## Logging into the host instead of the container

By default the web terminal is the shell **inside** the container. To make it the
**host** shell, run in SSH mode: the container's PTY launches `ssh <user>@<host>`,
so a refresh still resumes the same host shell. `docker-compose.yml` enables this
out of the box via `host.docker.internal`:

| Env | Default | Meaning |
|-----|---------|---------|
| `SSH_HOST` | `host.docker.internal` | Host to SSH into (empty = container's own shell) |
| `SSH_USER` | `youruser` | Host username |
| `SSH_PORT` | `22` | Host SSH port |
| `SSH_KEY` | `/home/shell/.ssh/id_hostshell` | Private key inside the container |

One-time key setup (key lives in the `shell-home` volume, so it persists):

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

> Security: this gives browser users a full shell **on the host**. Keep it behind
> auth + TLS and trusted networks only.

## CLI options

| Flag | Env | Default | Description |
|------|-----|---------|-------------|
| `--port` | `PORT` | `7681` | Listen port |
| `--host` | `HOST` | `0.0.0.0` | Listen address |
| `--shell` | `SHELL_PATH` | `$SHELL` or `/bin/bash` | Shell to launch (local mode) |
| `--cwd` | `WORK_DIR` | home | Initial dir for **new** local sessions |
| `--username` | `AUTH_USER` | `admin` | Auth username |
| `--password` | `AUTH_PASS` | *(random)* | Auth password |
| `--token-secret` | `TOKEN_SECRET` | *(random)* | Secret for signing tokens — set a stable one in prod |
| `--ssl-key` / `--ssl-cert` | `SSL_KEY` / `SSL_CERT` | – | Enable built-in HTTPS |
| `--ssh-host/user/port/key` | `SSH_*` | – | SSH into the host instead of a local shell |
| `--timeout` | `SESSION_TIMEOUT` | `0` | Reap a detached+idle session after N minutes (0 = never) |
| `--max-sessions` | `MAX_SESSIONS` | `0` | Cap concurrent sessions (0 = unlimited) |
| `--ring-bytes` | `RING_BYTES` | `2097152` | Per-session scrollback buffer (bytes) |
| `--web-dir` | `WEB_DIR` | `./web` | Static frontend directory |
| `--no-auth` | – | – | Disable auth (local dev only) |
| `--log-level` | `LOG_LEVEL` | `info` | `error\|warn\|info\|debug` |

## Wire protocol

The web client and the Android client share one protocol:

- `POST /api/login` `{username,password}` → `{token}` (401 on bad creds)
- `GET /api/me` (Bearer header or `?token=`) → `{user, authEnabled}`
- `GET /ws?token=&session=&cols=&rows=` — WebSocket, **UTF-8 text frames** with a
  1-byte op prefix:
  - client→server: `'0'<data>` input, `'1'<json>` control `{cmd:'resize',cols,rows}` / `{cmd:'kill'}`
  - server→client: `'0'<data>` output, `'1'<json>` event `{event:'session',key,isNew}` / `{event:'error',message}` / `{event:'ended'}`

Tokens are HMAC-SHA256 signed (`<base64url(payload)>.<base64url(sig)>`, 12 h TTL),
so no session store is needed.

## Project layout

```
main.go         HTTP/WS server, routes, auth gate, wire protocol
config.go       CLI/env config
auth.go         HMAC-signed tokens + credential check
session.go      SessionManager + Session (PTY, ring buffer, subscriber, reaper)
ringbuffer.go   fixed-size circular byte buffer
logger.go       tiny leveled logger
Dockerfile, nginx/   container build + optional TLS proxy
```

The frontend lives in the sibling [`web/`](../web/) directory.
