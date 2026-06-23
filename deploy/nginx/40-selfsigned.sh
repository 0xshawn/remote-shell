#!/bin/sh
# nginx init hook (runs from /docker-entrypoint.d before nginx starts). Generates
# a self-signed TLS cert on first boot if none is present, so the proxy serves
# HTTPS out of the box. Drop real fullchain.pem/privkey.pem into the certs dir to
# replace it — this script never overwrites existing certs.
set -e

cert_dir=/etc/nginx/certs
crt="$cert_dir/fullchain.pem"
key="$cert_dir/privkey.pem"

[ -f "$crt" ] && [ -f "$key" ] && exit 0

command -v openssl >/dev/null 2>&1 || apk add --no-cache openssl >/dev/null

cn="${SERVER_NAME:-localhost}"
[ "$cn" = "_" ] && cn=localhost

mkdir -p "$cert_dir"
openssl req -x509 -newkey rsa:2048 -nodes \
	-keyout "$key" -out "$crt" -days 3650 \
	-subj "/CN=$cn" >/dev/null 2>&1

echo "self-signed cert generated for CN=$cn (drop real certs in $cert_dir to replace)"
