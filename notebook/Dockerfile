# notebook — single image that builds the React web app and runs the Node
# server (which serves the built app + drives the `claude` CLI). HTTP only;
# put it behind your own TLS/proxy if you need encryption.
#
# Build context = this directory (notebook/), so both web/ and server/ are visible.

# ---------- stage 1: build the web app (Vite) ----------
FROM node:20-bookworm-slim AS webbuild
WORKDIR /web
COPY web/package.json web/package-lock.json* ./
RUN npm install
COPY web/ ./
RUN npm run build         # -> /web/dist

# ---------- stage 2: server deps (compile node-pty) ----------
FROM node:20-bookworm-slim AS serverdeps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY server/package.json server/package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force

# ---------- stage 3: runtime ----------
FROM node:20-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app

# tmux = shell-tab backend; tini = clean PID 1; ncurses-term = screen-256color
# terminfo; git/ripgrep/openssh = commonly needed by the claude CLI and shells.
RUN apt-get update && apt-get install -y --no-install-recommends \
      tmux tini ncurses-term ca-certificates git ripgrep openssh-client \
    && rm -rf /var/lib/apt/lists/*

# The Claude Code CLI, installed globally so it is on PATH as `claude`.
RUN npm install -g @anthropic-ai/claude-code@2.1.185 && npm cache clean --force

COPY --from=serverdeps /app/node_modules ./node_modules
COPY server/package.json ./
COPY server/src ./src
COPY server/public ./public
# resolveWebRoot() looks for ../../web/dist relative to /app/src -> /web/dist
COPY --from=webbuild /web/dist /web/dist

# Non-root user with a real, writable home (CLAUDE_CONFIG_DIR + work dir live here).
RUN useradd -m -u 10001 notebook \
    && mkdir -p /home/notebook/work /home/notebook/.claude \
    && chown -R notebook:notebook /home/notebook
USER notebook
ENV HOME=/home/notebook
WORKDIR /home/notebook

# Need a .ssh dir for the container->host key (SSH-to-host deployment).
RUN mkdir -p /home/notebook/.ssh && chmod 700 /home/notebook/.ssh

EXPOSE 7682
ENTRYPOINT ["/usr/bin/tini", "--"]
# --cwd is the container-side working dir (used by the shell tmux client). The
# claude working dir is governed by CLAUDE_CWD (falls back to --cwd) so the SSH
# deployment can point it at a host path without rebuilding.
CMD ["node", "/app/src/server.js", \
     "--port", "7682", \
     "--cwd", "/home/notebook/work"]
