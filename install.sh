#!/usr/bin/env bash
# Bootstrap installer: fetch the repo, then run the one-command deploy. Usage:
#
#   curl -fsSL https://raw.githubusercontent.com/0xshawn/remote-shell/main/install.sh | bash
#
# No manual clone needed. Override the location with REMOTE_SHELL_DIR=/path and
# the branch with REMOTE_SHELL_BRANCH=name. Safe to re-run (updates in place).
set -euo pipefail

REPO_SLUG="0xshawn/remote-shell"
BRANCH="${REMOTE_SHELL_BRANCH:-main}"
DIR="${REMOTE_SHELL_DIR:-$HOME/.remote-shell}"

echo "remote-shell installer -> $DIR (branch: $BRANCH)"

if command -v git >/dev/null 2>&1; then
	if [ -d "$DIR/.git" ]; then
		echo "updating existing checkout..."
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

cd "$DIR"
exec ./deploy.sh
