#!/usr/bin/env bash
# Binary install: install the self-contained remote-shell binary and run it in
# the background (surviving the shell that started it). No Docker, no clone, no
# Go. Run any of:
#
#   curl -fsSL https://raw.githubusercontent.com/0xshawn/remote-shell/main/install-binary.sh | bash
#   ./install-binary.sh                              # download from GitHub, then install
#   ./install-binary.sh ./remote-shell-linux-amd64   # install a binary you already have
#
# Use the last form when this host can't reach GitHub (private repo / blocked
# network): download the binary somewhere with access, copy it over, then point
# this script at it — no download is attempted.
#
# It serves HTTPS itself (auto self-signed cert) on https://<host>:7443.
# Safe to re-run (idempotent). Overrides:
#   REMOTE_SHELL_VERSION=v1.2.3   REMOTE_SHELL_BIN=/path/to/binary   PORT=7443
set -euo pipefail

REPO_SLUG="0xshawn/remote-shell"
VERSION="${REMOTE_SHELL_VERSION:-latest}"
PORT="${PORT:-7443}"

# --- OS / arch: the release assets are linux amd64/arm64 only. ---
[ "$(uname -s)" = "Linux" ] || { echo "error: binary install supports Linux only (got $(uname -s))" >&2; exit 1; }
case "$(uname -m)" in
	x86_64 | amd64) ARCH=amd64 ;;
	aarch64 | arm64) ARCH=arm64 ;;
	*) echo "error: unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac

# The user the web terminal's shell will run as. If invoked via sudo, that's the
# real user behind sudo, not root (mirrors install.sh).
target_user="${SUDO_USER:-$(id -un)}"
target_home=$(getent passwd "$target_user" | cut -d: -f6 || true)
[ -n "$target_home" ] || target_home="$HOME"

# --- 1. Choose where to install. ---
asset="remote-shell-linux-$ARCH"
if [ "$(id -u)" = 0 ]; then
	bindir="/usr/local/bin"
else
	bindir="$HOME/.local/bin"
fi
bin="$bindir/remote-shell"
mkdir -p "$bindir"

# --- 2. Obtain the binary. A local file (manual download) wins over downloading,
# so this works on hosts that can't reach GitHub. Source order: $1 arg, then
# $REMOTE_SHELL_BIN, then ./remote-shell-linux-<arch> or ./remote-shell in cwd. ---
src=""
for cand in "${1:-}" "${REMOTE_SHELL_BIN:-}" "./$asset" "./remote-shell"; do
	[ -n "$cand" ] && [ -f "$cand" ] && { src="$cand"; break; }
done

if [ -n "$src" ]; then
	echo "installing local binary $src -> $bin"
	install -m 0755 "$src" "$bin"
else
	if [ "$VERSION" = "latest" ]; then
		url="https://github.com/$REPO_SLUG/releases/latest/download/$asset"
	else
		url="https://github.com/$REPO_SLUG/releases/download/$VERSION/$asset"
	fi
	echo "downloading $asset ($VERSION) -> $bin"
	tmp=$(mktemp)
	if ! curl -fSL "$url" -o "$tmp"; then
		rm -f "$tmp"
		echo "error: download failed ($url)" >&2
		echo "  If GitHub is unreachable from this host, download $asset manually from" >&2
		echo "    https://github.com/$REPO_SLUG/releases" >&2
		echo "  copy it to this server, then re-run:  ./install-binary.sh ./$asset" >&2
		exit 1
	fi
	chmod +x "$tmp"
	mv -f "$tmp" "$bin"
fi

# --- 3. Run it in the background so it survives the shell closing. ---
have_systemd() { command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; }

if have_systemd && [ "$(id -u)" = 0 ]; then
	# System service running as the target user (so the shell, home, and persisted
	# secrets/cert under ~/.remote-shell are theirs). systemd sets HOME/USER/SHELL.
	run_home="$target_home"
	cat >/etc/systemd/system/remote-shell.service <<EOF
[Unit]
Description=remote-shell (browser terminal)
Documentation=https://github.com/$REPO_SLUG
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$target_user
Environment=PORT=$PORT
Environment=SSL_AUTO=1
ExecStart=$bin
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF
	systemctl daemon-reload
	systemctl enable --now remote-shell
	run_msg="systemd (system) — systemctl status remote-shell ; journalctl -u remote-shell -f"
elif have_systemd; then
	# Per-user service. enable-linger keeps it running after logout and across reboot.
	run_home="$HOME"
	unitdir="$HOME/.config/systemd/user"
	mkdir -p "$unitdir"
	cat >"$unitdir/remote-shell.service" <<EOF
[Unit]
Description=remote-shell (browser terminal)
Documentation=https://github.com/$REPO_SLUG
After=network-online.target

[Service]
Type=simple
Environment=PORT=$PORT
Environment=SSL_AUTO=1
ExecStart=$bin
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
EOF
	loginctl enable-linger "$(id -un)" 2>/dev/null ||
		echo "note: could not enable linger; the service may stop on logout (try: sudo loginctl enable-linger $(id -un))"
	systemctl --user daemon-reload
	systemctl --user enable --now remote-shell
	run_msg="systemd (user) — systemctl --user status remote-shell ; journalctl --user -u remote-shell -f"
else
	# No systemd: nohup detaches from the shell (survives close/logout), but does
	# NOT restart on reboot. systemd is preferred when available.
	run_home="$HOME"
	rundir="$run_home/.remote-shell"
	mkdir -p "$rundir"
	pidf="$rundir/remote-shell.pid"
	logf="$rundir/server.log"
	if [ -f "$pidf" ] && kill -0 "$(cat "$pidf" 2>/dev/null)" 2>/dev/null; then
		kill "$(cat "$pidf")" 2>/dev/null || true
		sleep 1
	fi
	PORT="$PORT" SSL_AUTO=1 nohup "$bin" >"$logf" 2>&1 </dev/null &
	echo $! >"$pidf"
	disown 2>/dev/null || true
	run_msg="background pid $(cat "$pidf") (no systemd; will NOT restart on reboot) — log: $logf, stop: kill \$(cat $pidf)"
fi

# --- 4. Wait until it answers, then surface the password (generated on first
# boot) + URL. The health probe also catches a wrong-arch binary or a port clash. ---
pwfile="$run_home/.remote-shell/password"
pw=""
up=""
for _ in $(seq 1 30); do
	curl -fsk --max-time 2 "https://localhost:$PORT/healthz" >/dev/null 2>&1 && up=1
	[ -s "$pwfile" ] && pw=$(cat "$pwfile")
	[ -n "$up" ] && break
	sleep 0.5
done
[ -n "$up" ] || echo "warning: server did not answer on https://localhost:$PORT yet — check it with: $run_msg"

# Best-effort public IP (Cloudflare trace works on cloud VMs whose public IP
# isn't bound to a local interface); fall back to the internal IP when offline.
url_host=$(curl -fsS --max-time 3 https://1.1.1.1/cdn-cgi/trace 2>/dev/null | awk -F= '/^ip=/{print $2}' || true)
if [ -n "$url_host" ]; then
	host_note="   (public IP — detected; use your domain if you have one)"
else
	url_host=$(hostname -I 2>/dev/null | awk '{print $1}' || true)
	[ -n "$url_host" ] || url_host="<server-ip>"
	host_note="   (internal address — on a cloud VM use the instance's public IP or a domain)"
fi
case "$url_host" in *:*) url_host="[$url_host]" ;; esac

echo
echo "remote-shell is up (binary mode)."
echo "  binary:   $bin"
echo "  run:      $run_msg"
echo "  URL:      https://$url_host:$PORT$host_note"
echo "            self-signed cert -> accept the browser warning"
echo "  username: admin"
if [ -n "$pw" ]; then
	echo "  password: $pw   (generated; stored in $pwfile)"
else
	echo "  password: pin AUTH_PASS, or read it from $pwfile"
fi
