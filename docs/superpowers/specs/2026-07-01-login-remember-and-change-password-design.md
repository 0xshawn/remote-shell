# Login "Remember" + Change Password — Design

Date: 2026-07-01

## Problem

Two user-reported issues with authentication:

1. **"Remember" still re-prompts for the password.** Even after enabling the
   save/remember toggle, users are periodically asked for the password again.
   Root cause: the server issues a fixed 12-hour token (`auth.go`,
   `tokenTTL = 12 * time.Hour`). "Remember" only persists the token (web) or
   the token + password (Android); once the token expires (every 12h), the
   client bounces back to the login screen.

2. **No way to change the password.** The password is static configuration
   (`--password` / `AUTH_PASS`, or auto-generated and persisted to
   `$HOME/.remote-shell/password`). There is no runtime endpoint to change it.

Scope: both clients (Web + Android) and the Go server.

## Decisions (confirmed with user)

- Issue 1 fix: **issue a long-lived token when "remember" is checked** (no new
  plaintext-password storage). Non-remember logins keep the 12h token.
- Long-lived token TTL: **30 days**.
- Change-password: keep other devices logged in (do **not** rotate the token
  signing secret).
- New-password minimum length: **6 characters**.

## Part 1 — Remember → long-lived token

### Server (`server/auth.go`, `server/main.go`)

- Add constant `rememberTokenTTL = 30 * 24 * time.Hour`; keep `tokenTTL = 12h`.
- Change `issueToken(user string)` → `issueToken(user string, ttl time.Duration)`.
  Only caller is `handleLogin` (also `auth.go` internal). Tests hit the HTTP
  endpoint, not `issueToken` directly, so the signature change is contained.
- `handleLogin`: extend the request body with `Remember bool` and pick the TTL:
  ```go
  var body struct {
      Username string `json:"username"`
      Password string `json:"password"`
      Remember bool   `json:"remember"`
  }
  ttl := tokenTTL
  if body.Remember {
      ttl = rememberTokenTTL
  }
  ... issueToken(user, ttl)
  ```
  The existing e2e `login` helper sends `{username, password}` with no
  `remember` field → decodes to `false` → 12h token → **no test breakage**.

### Web (`web/js/app.js`)

- In the login submit handler, add `remember: remember` to the `/api/login`
  request body. The `remember` value and `rs_remember` persistence already
  exist; this just forwards it to the server.

### Android (`net/AuthClient.kt`, `MainViewModel.kt`)

- `AuthClient.login(serverUrl, username, password, remember)` — add `remember`
  and include it in the JSON body.
- `MainViewModel.login(...)` already receives `save` (the "Remember
  credentials" switch); pass `save` as `remember` to `auth.login(...)`.

### Effect

With "remember" on, the token lives 30 days, eliminating the twice-daily
re-prompt. After 30 days the token expires and the user re-logs in (on Android
the password is already prefilled from `Prefs`, so it is one tap).

## Part 2 — Change password

### Server

New authenticated endpoint `POST /api/password`:

- Request body: `{ "oldPassword": "...", "newPassword": "..." }`.
- Requires a valid Bearer token **and** `oldPassword` must match the current
  password (constant-time). This prevents a stolen token from changing the
  password / locking out the account.
- Reject when `!auth.enabled` (`--no-auth` mode) → 400.
- Validate `newPassword`: non-empty, length ≥ 6 → 400 on failure.
- On success: update in-memory password and persist to
  `$HOME/.remote-shell/password` (0600).
- Response: `{ "ok": true }`, plus an optional `"warning": "<msg>"` when the
  change will not survive a restart (see precedence note).

Concurrency: `checkCredentials` reads `a.password` while a change writes it.
Add a `sync.RWMutex` to `auth`; guard the password field (RLock in
`checkCredentials`, Lock in the new `setPassword`). `username` and `secret` are
immutable and need no lock.

`auth` gains the persist target:

```go
type auth struct {
    mu       sync.RWMutex
    enabled  bool
    username string
    password string
    secret   []byte
    passFile string // path to persist password changes ("" = cannot persist)
    pinned   bool   // password set explicitly via env/flag → reverts on restart
}
```

Config (`server/config.go`) gains two fields, populated in `parseConfig`:

- `passwordFile string` — `filepath.Join(pdir, "password")` when `pdir != ""`,
  else `""`.
- `passwordPinned bool` — `*password != ""` (explicit env/flag value).

`newAuth` copies them into the `auth` struct. Adding fields to the `config`
struct literal used in `e2e_test.go` is safe (unset fields = zero value).

`setPassword`:

```go
func (a *auth) setPassword(newPass string) error {
    a.mu.Lock()
    a.password = newPass
    a.mu.Unlock()
    if a.passFile == "" {
        return nil
    }
    return os.WriteFile(a.passFile, []byte(newPass+"\n"), 0o600)
}
```

Register the route in `main.go`: `mux.HandleFunc("POST /api/password", srv.handlePassword)`.

**Precedence note (surfaced to the user, not silently ignored):** if the
password was set via `AUTH_PASS`/`--password`, `parseConfig` reads that env/flag
on every boot, so a runtime change reverts on restart. When `auth.pinned` is
true, the endpoint still applies the change (this session) and still writes the
file (fallback if the env var is later removed), and returns a `warning` telling
the user to update `AUTH_PASS` to make it permanent. In the default deploy
(`AUTH_PASS` empty → auto-generated, persisted), the change is durable with no
warning.

### Web (`web/index.html`, `web/js/app.js`, `web/css/style.css`)

- Add a `Change password` button to the `#menu` dropdown.
- Add a small overlay (reuse the `.hidden` + overlay pattern used by
  `#login` / `#paste-overlay`) with three password inputs: current, new,
  confirm, plus Save / Cancel.
- On submit: client-side check that new == confirm and length ≥ 6, then
  `POST /api/password` with the Bearer token. Show inline error, success, or
  the server `warning`. Close on success.

### Android (`ui/TerminalScreen.kt`, `MainViewModel.kt`, `net/AuthClient.kt`)

- `AuthClient.changePassword(serverUrl, token, oldPassword, newPassword)` →
  `POST /api/password`; return a result type carrying success / invalid current
  password / validation error / server warning.
- `MainViewModel.changePassword(old, new, onResult)` calls it on the IO
  dispatcher. **On success, if `saveCredentials` is on, update
  `prefs.password = new`** so the next token-expiry re-login prefills the new
  password (not the stale old one).
- `TerminalScreen`: add a `Change password` `DropdownMenuItem` that opens an
  `AlertDialog` with three fields (current, new, confirm) and does the
  new/confirm match + length ≥ 6 check before calling the ViewModel. Show
  error / warning inline in the dialog.

## Testing

- Server: unit/e2e test that
  - login with `remember:true` yields a token whose payload `exp` is ~30 days
    out; without it, ~12h.
  - `POST /api/password` with wrong `oldPassword` → 401; with a valid token +
    correct old + valid new → 200, and a subsequent login with the new password
    succeeds while the old one fails.
  - `POST /api/password` with new password < 6 chars → 400.
  - `--no-auth` mode → 400.
- Existing e2e tests must stay green (login helper unchanged → 12h path).
- Manual: web + Android change-password happy path and error/warning display.

## Out of scope

- Rotating the token signing secret (would log out all devices — explicitly
  not wanted).
- Rate-limiting the change-password / login endpoints.
- Username change.
