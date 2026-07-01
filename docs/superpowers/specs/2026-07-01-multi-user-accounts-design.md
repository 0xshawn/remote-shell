# Multi-User Accounts (Admin-Managed) — Design

Date: 2026-07-01

## Problem

The server is single-user: one `AUTH_USER` / `AUTH_PASS` pair compared in
`auth.checkCredentials`. The user wants to **support creating accounts** so more
than one login exists.

**Key constraint (confirmed with user):** in SSH mode every session runs
`ssh SSH_USER@SSH_HOST`, so all accounts land in the *same* host shell / home /
files. Accounts are **app-level logins** (separate tokens, separate session tab
lists — the session manager is already per-user), **not** OS-level users. No
per-account OS isolation is in scope.

## Decisions (confirmed with user)

- **Who can create accounts:** admin only. The bootstrap `AUTH_USER` is admin;
  only an authenticated admin can create/list/delete accounts.
- **Isolation:** app-level accounts sharing the host shell.
- **Management operations:** create + list + delete. Regular users change their
  own password via the existing `POST /api/password`.
- **Clients:** web + Android.
- **Password storage:** bcrypt hashes in a user store (adds
  `golang.org/x/crypto/bcrypt`).

## Architecture

Introduce a **user store** as the single source of truth for credentials.
`AUTH_USER`/`AUTH_PASS` become a first-boot seed for the admin account; after
that the store is authoritative. This also removes the env-pinned change-password
caveat shipped earlier (the store persists changes regardless of `AUTH_PASS`).

The token HMAC sign/verify logic (`issueToken`/`verifyToken`, the 30-day
"remember" TTL) is unchanged. Only credential storage and the admin endpoints
are new. The session manager (`sessionKey(user, sid)`, `list(user)`,
`killSession(user, sid)`) is already per-user and needs no change.

## Components

### 1. User store — `server/users.go` (new)

```go
type userRecord struct {
    Username     string `json:"username"`
    PasswordHash string `json:"passwordHash"` // bcrypt
    Admin        bool   `json:"admin"`
    Created      int64  `json:"created"`      // unix millis
}

type userStore struct {
    mu    sync.RWMutex
    path  string // "" = in-memory only (tests)
    users map[string]*userRecord
}
```

Methods:
- `newUserStore(path string) (*userStore, error)` — loads JSON from `path` if present.
- `authenticate(user, pass string) bool` — bcrypt compare; false if user absent.
- `exists(user string) bool`, `isAdmin(user string) bool`, `count() int`, `countAdmins() int`.
- `create(user, pass string, admin bool) error` — validates username/password, errors if exists.
- `delete(user string) error` — errors if absent (caller enforces self / last-admin guards).
- `setPassword(user, newpass string) error`.
- `list() []userInfo` — `{Username, Admin, Created}`, sorted by username.

Persistence: `save()` writes the full map as JSON to a temp file then renames
over `path` (atomic-ish), mode 0600. Called under the write lock after each
mutation. When `path == ""`, `save()` is a no-op (tests / no persist dir).

Validation:
- Username: non-empty, matches `^[A-Za-z0-9_.-]{1,32}$`.
- Password: length ≥ 6 (reuses the rule from the change-password feature).

Concurrency: all reads/writes go through `mu`. bcrypt work happens outside the
lock where practical (hash the new password before taking the write lock in
`create`/`setPassword`).

### 2. Auth integration — `server/auth.go`, `server/config.go`, `server/main.go`

- `auth` holds a `*userStore` and delegates:
  - `checkCredentials(user, pass)` → `!a.enabled || a.store.authenticate(user, pass)`.
  - `setPassword(user, newpass)` → `a.store.setPassword(user, newpass)`.
- The single `password`/`passFile`/`pinned` fields and the auth-level mutex are
  removed (the store owns credentials and its own lock). `enabled`, `secret`,
  and the token methods stay.
- **Seeding** (in `main()` after config parse, before serving): build the store
  at `$HOME/.remote-shell/users.json`. If it has no users, seed the admin:
  `create(cfg.username, cfg.password, admin=true)` where `cfg.password` is the
  existing resolution (AUTH_PASS, else the persisted `password` file, else
  generated — unchanged). Log the seeded admin username (and the generated
  password if one was generated, as today).
- `handlePassword` (from the prior feature) now calls `setPassword(p.User, new)`
  and drops the env-pinned `warning` branch (store is authoritative). It still
  requires token + correct current password + 6-char minimum.

### 3. Admin endpoints — `server/main.go`

Helper:
```go
// requireAdmin verifies the token and that the user is an admin.
// Writes 401/403 and returns nil on failure.
func (s *server) requireAdmin(w http.ResponseWriter, r *http.Request) *tokenPayload
```

- `POST /api/users` — body `{username, password, admin bool}`. Admin only.
  `200 {ok:true}`; `409 {error:"user exists"}`; `400 {error}` for invalid
  username/password.
- `GET /api/users` — admin only. `200 {users:[{username, admin, created}]}`.
- `DELETE /api/users?username=<u>` — admin only. Guards: cannot delete self
  (`400 {error:"cannot delete yourself"}`); cannot delete the last admin
  (`400 {error:"cannot delete the last admin"}`). `200 {ok:true}`;
  `404 {error:"no such user"}`.
- `/api/me` response gains `admin bool` (from `store.isAdmin(p.User)`), so
  clients know whether to show the management UI.

Routes use Go 1.22 method patterns: `POST /api/users`, `GET /api/users`,
`DELETE /api/users`.

### 4. Web — `web/index.html`, `web/js/app.js`, `web/css/style.css`

- On boot, `/api/me` already runs; capture `admin` from its response.
- Show a `Manage users` item in the `#menu` dropdown **only when admin**.
- `#users-overlay` modal (mirrors the login / change-password overlay pattern):
  - a list of users (username, an `admin` badge, a Delete button each — Delete
    hidden/disabled for the current user),
  - a create form (username, password, an `admin` checkbox, Create button),
  - inline error/success line.
- All requests send `Authorization: Bearer <token>`. After create/delete, reload
  the list.

### 5. Android — `net/AuthClient.kt`, `MainViewModel.kt`, `ui/TerminalScreen.kt`, `MainActivity.kt`

- Extend the boot check to read `admin` from `/api/me` (currently `verifyToken`
  returns only a bool). Add `admin: Boolean` to `UiState`.
- `AuthClient`: `listUsers(server, token)`, `createUser(server, token, username, password, admin)`,
  `deleteUser(server, token, username)`, each returning a small result type
  (`Success` / `Error(message)` from the server `error` string), plus a
  `UserInfo(username, admin, created)` data class and a `meAdmin` parse.
- `MainViewModel`: `loadUsers(onResult)`, `createUser(...)`, `deleteUser(...)`;
  set `admin` in state after boot.
- `TerminalScreen`: a `Manage users` menu item (shown only when `state.admin`) →
  a dialog/screen listing users with create + delete. Wire callbacks through
  `MainActivity` (same pattern as `onChangePassword`).

## Data flow

Login → token (unchanged). Any request → `verifyToken` → user. Admin endpoints →
`requireAdmin` → `store.isAdmin`. Create/delete/list/setPassword → `userStore`
(locked) → `save()` to `users.json`.

## Error handling

- Store load: if `users.json` is corrupt/unreadable, log and start empty (then
  seeding recreates the admin) rather than crash — a corrupt file must not lock
  everyone out permanently. (It is backed up to `users.json.bak` before
  overwrite on the first successful save.)
- Endpoint validation returns specific 4xx with a JSON `error` the clients show.
- Delete guards prevent self-lockout and orphaning (last admin).

## Testing (Go)

- `userStore`: create/authenticate (right vs wrong password), duplicate create
  (409-worthy error), delete, last-admin/self guards at the store or handler
  level, `list` sorted, persistence round-trip (save then `newUserStore` reload),
  bcrypt hash is not the plaintext.
- Endpoints: non-admin gets 403 on `POST/GET/DELETE /api/users`; admin can
  create → new user can log in; delete self / last admin rejected; `/api/me`
  returns `admin` correctly for admin and non-admin.
- Seeding: empty store seeds one admin from `cfg.username`/`cfg.password`; a
  non-empty store is left as-is on restart.
- Existing suites stay green (login, change-password now via the store). The
  prior `TestChangePasswordPinnedWarns` is **removed** — its env-pinned `warning`
  behavior is intentionally gone now that the store is authoritative; other
  change-password tests are updated to construct `auth` with a seeded store
  instead of the removed single-password fields.
- Clients: build-verified (Android `assembleDebug`); browser/on-device manual.

## Migration / deployment note

On the first boot after this ships, the current deployment (which has
`AUTH_PASS` set and a persisted single `password`) seeds one admin =
`{admin, <current password>, admin:true}`; existing logins keep working. From
then on the store is authoritative, so future password changes and new accounts
persist across restarts regardless of `AUTH_PASS`.

## Out of scope

- OS-level per-user isolation (separate host users / homes / SSH identities).
- Roles beyond admin / non-admin.
- Open self-registration or invite codes.
- Rate limiting.

## Dependency

Adds `golang.org/x/crypto` (bcrypt) — pure Go, safe for the `CGO_ENABLED=0`
static build; the Docker build stage's `go mod download` fetches it.
