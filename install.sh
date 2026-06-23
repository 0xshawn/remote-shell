#!/usr/bin/env bash
# Install + deploy in one script. Run it either way:
#
#   curl -fsSL https://raw.githubusercontent.com/0xshawn/remote-shell/main/install.sh | bash
#   ./install.sh                # from an existing checkout
#
# When run outside a checkout (e.g. piped from curl) it fetches the repo into
# ~/.remote-shell first, then deploys. Safe to re-run (idempotent). Overrides:
#   REMOTE_SHELL_DIR=/path   REMOTE_SHELL_BRANCH=name
set -euo pipefail

REPO_SLUG="0xshawn/remote-shell"
BRANCH="${REMOTE_SHELL_BRANCH:-main}"
DIR="${REMOTE_SHELL_DIR:-$HOME/.remote-shell}"

# The Docker image is built from the repo, so the sources must be on disk. Use
# the checkout this script lives in; if there isn't one (piped from curl), fetch
# it and hand off to the on-disk copy.
find_repo() {
	local src="${BASH_SOURCE[0]:-}" dir
	if [[ "$src" == */* ]]; then
		dir=$(cd "$(dirname "$src")" 2>/dev/null && pwd) || dir=""
		[ -n "$dir" ] && [ -f "$dir/docker-compose.yml" ] && { echo "$dir"; return; }
	fi
	[ -f docker-compose.yml ] && [ -f server/Dockerfile ] && pwd
}

repo=$(find_repo || true)
if [ -z "$repo" ]; then
	echo "fetching remote-shell -> $DIR (branch: $BRANCH)"
	if command -v git >/dev/null 2>&1; then
		if [ -d "$DIR/.git" ]; then
			git -C "$DIR" pull --ff-only || echo "  (skipped update; using the existing checkout)"
		else
			git clone --depth 1 --branch "$BRANCH" "https://github.com/$REPO_SLUG.git" "$DIR"
		fi
	else
		# No git: grab a tarball. Local .env / certs are gitignored and not in the
		# archive, so re-running only refreshes the code, never your config.
		echo "git not found; downloading tarball..."
		mkdir -p "$DIR"
		curl -fsSL "https://github.com/$REPO_SLUG/archive/refs/heads/$BRANCH.tar.gz" \
			| tar -xz -C "$DIR" --strip-components=1
	fi
	exec bash "$DIR/install.sh"
fi
cd "$repo"

# --- Decide how to invoke docker: directly, or via sudo when the current user
# can't reach the docker socket (common when not in the 'docker' group). ---
if docker info >/dev/null 2>&1; then
	DOCKER="docker"
elif sudo docker info >/dev/null 2>&1; then
	DOCKER="sudo docker"
	echo "note: using 'sudo docker' (current user can't reach the docker socket)"
else
	echo "error: docker is not usable here — add your user to the 'docker' group or enable sudo" >&2
	exit 1
fi

# The host user whose shell the container SSHes into, and whose authorized_keys
# we authorize. If the script itself was run via sudo, that's the real user
# behind sudo, not root.
target_user="${SUDO_USER:-$(id -un)}"
target_home=$(getent passwd "$target_user" | cut -d: -f6 || true)
[ -n "$target_home" ] || target_home="$HOME"

# 1. Ensure a .env exists.
if [ ! -f .env ]; then
	cp .env.example .env
	echo "created .env from .env.example"
fi

# 2. Auto-detect the host user for SSH-to-host mode (only if not already set).
if ! grep -qE '^SSH_USER=' .env; then
	echo "SSH_USER=$target_user" >> .env
	echo "set SSH_USER=$target_user in .env"
fi

# 3. Build and start.
echo "building and starting containers..."
$DOCKER compose up -d --build

# 4. Wait for the container to generate its host SSH key (SSH mode only).
echo "waiting for the container SSH key..."
pub=""
for _ in $(seq 1 30); do
	pub=$($DOCKER compose exec -T remote-shell cat /home/shell/.ssh/id_hostshell.pub 2>/dev/null || true)
	[ -n "$pub" ] && break
	sleep 1
done

# 5. Authorize that key on the host (idempotent). Skipped if SSH mode is off.
if [ -n "$pub" ]; then
	auth_keys="$target_home/.ssh/authorized_keys"
	mkdir -p "$target_home/.ssh" && chmod 700 "$target_home/.ssh"
	touch "$auth_keys" && chmod 600 "$auth_keys"
	if grep -qF "$pub" "$auth_keys"; then
		echo "host key already authorized"
	else
		echo "from=\"172.16.0.0/12\" $pub" >> "$auth_keys"
		echo "authorized the container's key on this host"
	fi
	# If we ran as root via sudo, hand the .ssh files back to the user so sshd
	# (StrictModes) still accepts them.
	if [ "$(id -u)" = 0 ] && [ -n "${SUDO_USER:-}" ]; then
		chown -R "$target_user" "$target_home/.ssh"
	fi
else
	echo "no container SSH key found — SSH-to-host mode looks disabled; skipping"
fi

# 6. Surface the login password and URL.
pw=$($DOCKER compose logs remote-shell 2>&1 | grep -F "GENERATED password" | tail -1 | sed 's/.*= //' || true)

# Pick the address to show: a configured domain wins; otherwise best-effort the
# host's PUBLIC IP (Cloudflare trace — works on cloud VMs whose public IP isn't
# bound to a local interface); fall back to the internal IP when offline.
url_host=$(grep -E '^SERVER_NAME=' .env | tail -1 | cut -d= -f2- | tr -d ' ' || true)
host_note=""
if [ -z "$url_host" ] || [ "$url_host" = "_" ]; then
	url_host=$(curl -fsS --max-time 3 https://1.1.1.1/cdn-cgi/trace 2>/dev/null | awk -F= '/^ip=/{print $2}' || true)
	if [ -n "$url_host" ]; then
		host_note="   (public IP — detected; use your domain if you have one)"
	else
		url_host=$(hostname -I 2>/dev/null | awk '{print $1}' || true)
		[ -n "$url_host" ] || url_host="<server-ip>"
		host_note="   (internal address — on a cloud VM use the instance's public IP or a domain)"
	fi
	# Bracket IPv6 literals so the URL stays valid.
	case "$url_host" in *:*) url_host="[$url_host]";; esac
fi

echo
echo "remote-shell is up."
echo "  URL:      https://$url_host:8443$host_note"
echo "            self-signed cert -> accept the browser warning"
echo "  username: $(grep -E '^AUTH_USER=' .env | tail -1 | cut -d= -f2- | grep . || echo admin)"
if [ -n "$pw" ]; then
	echo "  password: $pw   (generated; also in: $DOCKER compose logs remote-shell)"
else
	echo "  password: from AUTH_PASS in .env"
fi
