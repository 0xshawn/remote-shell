# Build context is the REPO ROOT (see docker-compose.yml) so we can COPY both
# the Go server (server/) and the static frontend (web/) into the image.

# ---------- build stage: compile the static Go binary ----------
FROM golang:1.26-bookworm AS build
WORKDIR /src
# Cache module downloads across rebuilds.
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server/ ./
# CGO off -> a fully static binary (creack/pty and gorilla/websocket are pure Go).
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /remote-shell .

# ---------- runtime stage ----------
FROM debian:bookworm-slim
ENV LANG=C.UTF-8
# openssh-client: PTY runs `ssh user@host` to reach the HOST shell (not the
# container's). tini: clean PID 1 / reaps ssh children. ncurses-term: terminfo
# for the local-shell fallback mode.
RUN apt-get update && apt-get install -y --no-install-recommends \
      openssh-client ca-certificates tini ncurses-term \
    && rm -rf /var/lib/apt/lists/*

# Non-root user with a real home (persisted via the shell-home volume; holds the
# SSH key used to reach the host).
RUN useradd -m -u 10001 shell

COPY --from=build /remote-shell /usr/local/bin/remote-shell
COPY web /web
ENV WEB_DIR=/web
# Entrypoint auto-generates the host SSH key on first boot (see entrypoint.sh).
COPY --chmod=0755 server/entrypoint.sh /usr/local/bin/entrypoint.sh

USER shell
ENV HOME=/home/shell
WORKDIR /home/shell

EXPOSE 7681
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["remote-shell", "--port", "7681"]
