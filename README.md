# remote-shell

A monorepo for **remote-shell**, a browser-based interactive shell whose defining
feature is **session persistence**: refresh, close the tab, or switch devices and
you resume the *exact* same shell — working directory, environment, running
processes, and history all intact.

The server forks a PTY directly and keeps a per-session in-memory **ring buffer**;
the frontend (xterm.js + WebGL, 50k-line scrollback) owns all scrolling, so it
stays buttery-smooth and a reconnect repaints the screen from the buffer. No tmux.

```
Browser (xterm.js + WebGL) ──WebSocket──► Go gateway ──fork──► PTY ──► bash/zsh (or `ssh host`)
                                              │
                                     per-session ring buffer  → reconnect repaints
```

## Projects

| Path | Project | Description |
|------|---------|-------------|
| [`server/`](server/) | **server** | Go gateway: PTY + ring-buffer session persistence, WebSocket wire protocol, auth. See [`server/README.md`](server/README.md). |
| [`web/`](web/) | **web** | xterm.js + WebGL frontend (no build step; vendored addons). Served by the Go server. |
| [`android/`](android/) | **android** | Native Android client (Kotlin + Jetpack Compose, Termux terminal emulator) that speaks the same login API and WebSocket protocol. See [`android/README.md`](android/README.md). |
| [`deploy/`](deploy/) | **deploy** | Docker Compose, Dockerfile, and the nginx TLS proxy. Driven by [`install.sh`](install.sh). |

## Quick start

**Server + web** (Docker) — one command, no clone needed:

```bash
curl -fsSL https://raw.githubusercontent.com/0xshawn/remote-shell/main/install.sh | bash
# open the printed https://<host>:8443  (self-signed cert → accept the warning)
```

`install.sh` fetches the repo into `~/.remote-shell` (override with
`REMOTE_SHELL_DIR=`) when run outside a checkout, then builds the image, creates
`.env`, auto-detects your host user, generates + persists the secrets, generates
a self-signed TLS cert, and authorizes the container's SSH key on the host —
then prints the login password. It is safe to re-run. From an existing clone,
run `./install.sh` directly.

By default the web terminal logs into the **host** shell over SSH (not the
container). To pin credentials, use real TLS certs, or switch to a plain
container shell, see [`server/README.md`](server/README.md).

**Binary** (no Docker) — download one self-contained binary and run it in the
background; it serves its own HTTPS:

```bash
curl -fsSL https://raw.githubusercontent.com/0xshawn/remote-shell/main/install-binary.sh | bash
# open the printed https://<host>:7443  (self-signed cert → accept the warning)
```

`install-binary.sh` downloads the prebuilt binary for your architecture, runs it
under **systemd** when available (else a `nohup` process that survives the shell
closing), and prints the generated password. The web terminal is the host user's
own shell — no SSH hop. Override with `REMOTE_SHELL_VERSION=` / `PORT=`. See
[`server/README.md`](server/README.md) for management + uninstall.

Run it directly instead (Go ≥ 1.26):

```bash
cd server && go build -o remote-shell . && cd ..
WEB_DIR=web ./server/remote-shell --no-auth
```

**Android client:**

```bash
cd android
./gradlew assembleDebug
```

Then point the app at your server's URL and log in with the same credentials.

## Uninstall

Removes everything `install.sh` created — containers, the volume (secrets + host
SSH key), the image, the authorized key, and the checkout:

```bash
docker compose -f ~/.remote-shell/deploy/docker-compose.yml down -v  # stop containers + drop the volume
docker image rm remote-shell:latest                                  # remove the built image
sed -i '/remote-shell-container/d' ~/.ssh/authorized_keys            # revoke the container's host SSH key
rm -rf ~/.remote-shell                                               # remove the checkout
```

(Adjust the path if you set `REMOTE_SHELL_DIR`; prefix `sudo` if Docker needs it.)

For a **binary install**, remove the service, binary, and persisted state instead:

```bash
sudo systemctl disable --now remote-shell                            # user install: systemctl --user disable --now remote-shell
sudo rm -f /etc/systemd/system/remote-shell.service /usr/local/bin/remote-shell
#   user install: rm -f ~/.config/systemd/user/remote-shell.service ~/.local/bin/remote-shell
rm -rf ~/.remote-shell                                               # secrets + self-signed cert
```
