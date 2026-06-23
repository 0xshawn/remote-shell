#!/bin/sh
# Container entrypoint. In SSH mode (SSH_HOST set), auto-generate the key used to
# reach the host shell on first boot so the operator never has to run
# `docker exec ... ssh-keygen` by hand. The key lives on the persisted
# shell-home volume, so it is created once and reused after that.
set -e

if [ -n "$SSH_HOST" ]; then
	key="${SSH_KEY:-$HOME/.ssh/id_hostshell}"
	if [ ! -f "$key" ]; then
		mkdir -p "$(dirname "$key")"
		chmod 700 "$(dirname "$key")"
		ssh-keygen -t ed25519 -N "" -f "$key" -C remote-shell-container
	fi
fi

exec "$@"
