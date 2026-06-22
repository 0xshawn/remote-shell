# ---------- build stage: compile native deps (node-pty) ----------
FROM node:20-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force

# ---------- runtime stage ----------
FROM node:20-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app

# tmux = persistence backend; tini = clean PID 1 / signal handling;
# ncurses-term = provides screen-256color terminfo used inside tmux.
RUN apt-get update && apt-get install -y --no-install-recommends \
      tmux tini ncurses-term ca-certificates openssh-client \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public

# Run as a non-root user with a real home directory.
RUN useradd -m -u 10001 shell
USER shell
ENV HOME=/home/shell
WORKDIR /home/shell

EXPOSE 7681
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/app/src/server.js", "--port", "7681", "--cwd", "/home/shell"]
