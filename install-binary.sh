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
# The release also ships a self-extracting bundle named
# remote-shell-installer-linux-<arch>.sh: this exact script with the binary
# appended. Download that one file and run it — it carves out the binary and
# installs it with no network and no separate files:
#   bash remote-shell-installer-linux-amd64.sh
#
# It serves HTTPS itself (auto self-signed cert) on https://<host>:8443.
# Safe to re-run (idempotent). Overrides:
#   REMOTE_SHELL_VERSION=v1.2.3   REMOTE_SHELL_BIN=/path/to/binary   PORT=8443
set -euo pipefail

REPO_SLUG="0xshawn/remote-shell"
VERSION="${REMOTE_SHELL_VERSION:-latest}"
PORT="${PORT:-8443}"

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

# --- 0. Uninstall: tear down whichever install type is present (best-effort,
# usually only one applies) and exit. Handled before binary resolution so the
# "uninstall" arg is never mistaken for a local binary path. ---
if [ "${1:-}" = "uninstall" ]; then
	# Run a privileged command, via sudo when not root and sudo exists.
	priv() {
		if [ "$(id -u)" = 0 ]; then "$@"
		elif command -v sudo >/dev/null 2>&1; then sudo "$@"
		else return 1; fi
	}

	echo "uninstalling remote-shell..."

	# System service (needs root).
	if [ "$(id -u)" = 0 ] || command -v sudo >/dev/null 2>&1; then
		priv systemctl disable --now remote-shell 2>/dev/null || true
		priv rm -f /etc/systemd/system/remote-shell.service 2>/dev/null || true
		priv systemctl daemon-reload 2>/dev/null || true
		echo "  stopped/removed system service (if present)"
	else
		echo "  note: re-run with sudo to remove a system service / /usr/local/bin binary"
	fi

	# User service.
	systemctl --user disable --now remote-shell 2>/dev/null || true
	rm -f "$HOME/.config/systemd/user/remote-shell.service" 2>/dev/null || true
	systemctl --user daemon-reload 2>/dev/null || true
	echo "  stopped/removed user service (if present)"

	# nohup background process.
	pidf="$HOME/.remote-shell/remote-shell.pid"
	if [ -f "$pidf" ] && kill -0 "$(cat "$pidf" 2>/dev/null)" 2>/dev/null; then
		kill "$(cat "$pidf")" 2>/dev/null || true
		echo "  killed background process (pid $(cat "$pidf"))"
	fi

	# Binaries (both possible locations).
	priv rm -f /usr/local/bin/remote-shell 2>/dev/null || true
	rm -f "$HOME/.local/bin/remote-shell" 2>/dev/null || true
	echo "  removed binary from /usr/local/bin and ~/.local/bin (if present)"

	# State dir (secrets, token secret, self-signed cert).
	rm -rf "$HOME/.remote-shell" 2>/dev/null || true
	echo "  removed state dir $HOME/.remote-shell (if present)"

	echo "uninstall complete."
	exit 0
fi

# --- 1. Choose where to install. ---
asset="remote-shell-linux-$ARCH"
if [ "$(id -u)" = 0 ]; then
	bindir="/usr/local/bin"
else
	bindir="$HOME/.local/bin"
fi
bin="$bindir/remote-shell"
mkdir -p "$bindir"

# --- 2. Obtain the binary, in priority order:
#   (a) a payload appended to THIS file — the release ships a self-extracting
#       installer (this script + the binary), so one .sh is the whole package;
#   (b) a local file you point at: $1, $REMOTE_SHELL_BIN, or
#       ./remote-shell-linux-<arch> / ./remote-shell in the current directory;
#   (c) otherwise, download it from GitHub.
# (a) and (b) need no network access. ---
src=""
extracted=""

# (a) Self-extracting payload. The marker line only exists when a binary was
# appended at release time; the grep pattern below never matches its own source
# line, so the plain checked-in script falls through to (b)/(c).
payload_line=$(grep -an '^__RS_PAYLOAD__$' "$0" 2>/dev/null | head -1 | cut -d: -f1 || true)
if [ -n "$payload_line" ]; then
	src=$(mktemp)
	extracted="$src"
	tail -n +"$((payload_line + 1))" "$0" >"$src"
	echo "extracted the embedded binary from this self-installer"
fi

# (b) Local file.
if [ -z "$src" ]; then
	for cand in "${1:-}" "${REMOTE_SHELL_BIN:-}" "./$asset" "./remote-shell"; do
		[ -n "$cand" ] && [ -f "$cand" ] && { src="$cand"; break; }
	done
fi

if [ -n "$src" ]; then
	echo "installing binary -> $bin"
	install -m 0755 "$src" "$bin"
	[ -n "$extracted" ] && rm -f "$extracted"
else
	# (c) Download from GitHub.
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
		echo "  If GitHub is unreachable from this host, grab the self-extracting installer" >&2
		echo "  remote-shell-installer-linux-$ARCH.sh (or $asset) from:" >&2
		echo "    https://github.com/$REPO_SLUG/releases" >&2
		echo "  copy it over, then run the installer, or:  ./install-binary.sh ./$asset" >&2
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
# Second public-IP attempt: icanhazip returns the bare IP; $() strips the newline.
[ -n "$url_host" ] || url_host=$(curl -fsS --max-time 3 https://icanhazip.com 2>/dev/null || true)
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

# Stop here: a self-extracting bundle appends its binary payload below this line
# (after the __RS_PAYLOAD__ marker), and execution must never reach those bytes.
exit 0
