# remote-shell-android

A native **Android client** for [`remote-shell`](../remote-shell) — the persistent web
shell whose defining feature is **session persistence**: kill the app, switch networks,
reconnect, and you resume the *exact* same shell (working directory, env vars, running
processes, history) because every session is transparently backed by **tmux** on the
server.

This app replaces the browser/xterm.js frontend with a native Kotlin + Jetpack Compose UI
and the battle-tested **Termux terminal emulator** for rendering. The server is unchanged:
the app speaks the same HTTP login API and the same 1-byte-prefixed WebSocket protocol.

```
Android app (Compose + Termux TerminalView)
        │  HTTPS  POST /api/login  ─────────────►  HMAC token
        │  WSS    /ws?token&session&cols&rows ──►  Node server ──► tmux ──► persistent shell
        ▼
  TerminalEmulator  ◄── '0'<output> / '1'<event> ── server
        └─ keystrokes/resize ── '0'<input> / '1'<control> ──► server
```

---

## Feature parity with the web client

| Capability | Web client | This app |
|---|---|---|
| Username/password login → HMAC token | ✅ | ✅ |
| Token persisted; verified on launch (`/api/me`) | ✅ | ✅ |
| Persistent session id (resume the same shell) | ✅ (localStorage) | ✅ (SharedPreferences) |
| Auto-reconnect with backoff; token-expiry → login | ✅ | ✅ |
| Full terminal rendering (colors, scrollback, CJK) | ✅ xterm.js | ✅ Termux emulator |
| Resize follows the viewport | ✅ | ✅ |
| Copy / paste | ✅ buttons | ✅ long-press selection menu |
| Mobile helper keys (Esc/Tab/arrows/Ctrl…) | ✅ | ✅ |
| Sticky Ctrl/Alt/Shift (tap = latch, long-press = lock) | ✅ | ✅ |
| Pinch-to-zoom / font size | ✅ A± buttons | ✅ pinch + A± |
| Disconnect (keep session) / Kill (destroy session) / Logout | ✅ | ✅ |

---

## Build

Requires the Android SDK (compileSdk 34) and JDK 17.

```bash
# from this directory, with the Android SDK installed
echo "sdk.dir=/path/to/Android/Sdk" > local.properties
./gradlew :app:assembleDebug
# APK -> app/build/outputs/apk/debug/app-debug.apk
```

Or just open the folder in **Android Studio** and press Run. `minSdk` is 24 (Android 7.0).

Install on a connected device:

```bash
./gradlew :app:installDebug      # or: adb install -r app/build/outputs/apk/debug/app-debug.apk
```

---

## Usage

1. Launch the app and enter:
   - **Server URL** — the base URL of your remote-shell server, e.g.
     `https://shell.example.com:8443` (TLS) or `http://192.168.1.10:7681` (LAN, no TLS).
   - **Username / Password** — the credentials the server was started with.
2. You get a shell. Tap the terminal to bring up the keyboard.
3. **Quit the app and reopen it** — you land back in the same shell, right where you left off.

Toolbar (overflow menu):
- **Reconnect** — drop and re-establish the socket now.
- **Disconnect** — close the socket but leave the persistent session running on the server.
- **Kill session** — destroy the server-side tmux session (running processes die) and forget
  the local session id; the next launch starts a fresh shell.
- **Logout** — discard the saved token and return to the login screen.

The helper key row sits above the soft keyboard. **Ctrl/Alt/Shift** are sticky: a single tap
*latches* the modifier for the next key; a long-press *locks* it until tapped again.

> Cleartext (`http://`/`ws://`) is allowed so you can reach a non-TLS server on a trusted LAN
> (`android:usesCleartextTraffic="true"`). For anything over the internet, run the server
> behind TLS and use an `https://` URL — a shell over plaintext is dangerous.

### Self-signed certificates

remote-shell often ships a **self-signed** TLS cert (frequently `CN=localhost`, reached by IP),
which Android would otherwise reject with `CertPathValidatorException: Trust anchor ... not
found`. This app **always accepts self-signed certs** and skips hostname verification (the
equivalent of `curl -k`), so it connects without any extra step. The trade-off: it provides no
protection against a man-in-the-middle. This is intentional for a personal-server tool — see
`net/HttpClients.kt`. For real safety, install a CA-signed cert on the server (or switch
`HttpClients` to pin your cert's fingerprint).

---

## Project layout

```
app/                                  the Android client
  src/main/java/com/remoteshell/android/
    MainActivity.kt                   Compose entry point + screen routing
    MainViewModel.kt                  login → terminal state machine
    net/Prefs.kt                      persisted server URL / token / session id
    net/AuthClient.kt                 POST /api/login, GET /api/me  (OkHttp)
    net/ShellWebSocket.kt             /ws wire protocol             (OkHttp)
    term/SessionController.kt         bridges WebSocket ⇄ TerminalSession/TerminalView
    ui/LoginScreen.kt, TerminalScreen.kt, theme/

terminal-emulator/                    vendored from Termux (Apache-2.0), see below
terminal-view/                        vendored from Termux (Apache-2.0)
```

### How the Termux libraries are used

Termux's `terminal-emulator` and `terminal-view` are vendored as local Gradle modules. They
normally drive a *local* pty via JNI; this app never runs a local shell, so:

- the native/JNI subprocess backend was removed (`JNI.java`, `ByteQueue.java`, the original
  process-spawning `TerminalSession`, and the `jni/` C sources are not included);
- `com.termux.terminal.TerminalSession` is reimplemented as a thin **WebSocket-backed**
  session (`terminal-emulator/.../TerminalSession.java`): bytes from the server go into the
  emulator, keystrokes/resizes go out to the server, via a `SessionOutput` sink. `TerminalView`
  renders it completely unmodified.

These two modules derive from [Android Terminal Emulator](https://github.com/jackpal/Android-Terminal-Emulator)
and are distributed by Termux under the **Apache License 2.0** (see each module's
`THIRD_PARTY_LICENSE.md`). The original app code in `app/` is yours to license as you wish.

---

## Notes & limitations

- The first connection to a brand-new session creates it at 80×24 and immediately resizes to
  the device's real grid (tmux repaints); existing sessions resume at their last size.
- There is no light/dark *terminal* theme toggle yet (the app chrome follows the system theme;
  the terminal uses Termux's default dark scheme). Copy/paste uses Termux's native long-press
  selection menu rather than toolbar buttons.
