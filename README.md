# remote-shell

A monorepo for **remote-shell**, a browser-based interactive shell whose defining
feature is **session persistence**: refresh, close the tab, or switch devices and
you resume the *exact* same shell — working directory, environment, running
processes, and history all intact — because every session is transparently backed
by **tmux** on the server.

## Projects

| Path | Project | Description |
|------|---------|-------------|
| [`server/`](server/) | **remote-shell** | Node.js server + web (xterm.js) frontend, tmux-backed session persistence. See [`server/README.md`](server/README.md). |
| [`android/`](android/) | **remote-shell-android** | Native Android client (Kotlin + Jetpack Compose, Termux terminal emulator) that speaks the same login API and WebSocket protocol. See [`android/README.md`](android/README.md). |

## Quick start

**Server** (Docker):

```bash
cd server
cp .env.example .env   # set AUTH_USER / AUTH_PASS / TOKEN_SECRET
docker compose up -d
```

Or run it directly:

```bash
cd server
npm install
npm start
```

**Android client:**

```bash
cd android
./gradlew assembleDebug
```

Then point the app at your server's URL and log in with the same credentials.
