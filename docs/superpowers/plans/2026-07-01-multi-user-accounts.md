# Multi-User Accounts (Admin-Managed) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the single-user auth into an admin-managed multi-user account system (create/list/delete), backed by a bcrypt-hashed user store.

**Architecture:** A new `userStore` (JSON file, bcrypt hashes) becomes the source of truth for credentials. `AUTH_USER`/`AUTH_PASS` seed the admin on first boot; the store is authoritative thereafter. `auth` delegates credential checks to the store. New admin-only endpoints manage users; `/api/me` exposes an `admin` flag so clients show the management UI. The token HMAC logic and the per-user session manager are unchanged.

**Tech Stack:** Go (net/http, golang.org/x/crypto/bcrypt), vanilla JS/HTML/CSS (web), Kotlin + Compose + OkHttp (Android).

## Global Constraints

- Password storage: **bcrypt** hashes (`golang.org/x/crypto/bcrypt`, default cost). Never store plaintext in the store.
- New-password / account-password minimum length = **6** characters (`minPasswordLen`).
- Username format: `^[A-Za-z0-9_.-]{1,32}$`.
- Account creation/list/delete are **admin only**.
- Delete guards: cannot delete yourself; cannot delete the last admin.
- Token HMAC sign/verify and the 30-day "remember" TTL are unchanged.
- `--no-auth` mode: `/api/password` and `/api/users` return 400 / are non-admin; `/api/me` reports `admin:false`.
- This branch (`feat/multi-user-accounts`) is stacked on `feat/remember-token-and-change-password` (PR #11); it refactors code from that branch.
- Code comments in English; concise English commit messages. Match existing style. Do not stage `.claude/`, `.mcp.json`, `CLAUDE.md`.

---

## Server API contract (produced by Tasks 1–3, consumed by Tasks 4–6)

- `GET /api/me` → `{user, authEnabled, admin}` (adds `admin bool`).
- `POST /api/users` (admin) — body `{username, password, admin bool}` → `200 {ok:true}`; `409 {error:"user already exists"}`; `400 {error}` (bad username/password); `403 {error:"admin required"}`; `401`.
- `GET /api/users` (admin) → `200 {users:[{username, admin, created}]}`; `403`; `401`.
- `DELETE /api/users?username=<u>` (admin) → `200 {ok:true}`; `400 {error:"cannot delete yourself"|"cannot delete the last admin"}`; `404 {error:"no such user"}`; `403`; `401`.
- `POST /api/password` (unchanged surface) now changes the **caller's** password in the store; the env-pinned `warning` field is gone.

---

## Task 1: User store (`server/users.go`) + bcrypt dependency

**Files:**
- Create: `server/users.go`
- Create: `server/users_test.go`
- Modify: `server/go.mod`, `server/go.sum` (via `go get`)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type userInfo struct { Username string; Admin bool; Created int64 }`
  - `func newUserStore(path string) *userStore`
  - `func (s *userStore) authenticate(user, pass string) bool`
  - `func (s *userStore) isAdmin(user string) bool`
  - `func (s *userStore) count() int`
  - `func (s *userStore) countAdmins() int`
  - `func (s *userStore) create(user, pass string, admin bool) error`
  - `func (s *userStore) delete(user string) error`
  - `func (s *userStore) setPassword(user, newpass string) error`
  - `func (s *userStore) list() []userInfo`
  - sentinel errors `errUserExists`, `errNoSuchUser`, `errBadUsername`, `errPasswordTooShort`; const `minPasswordLen = 6`.

- [ ] **Step 1: Add the bcrypt dependency**

Run: `cd server && go get golang.org/x/crypto/bcrypt && go mod tidy`
Expected: `go.mod` now requires `golang.org/x/crypto`; `go.sum` updated.

- [ ] **Step 2: Write the failing test**

Create `server/users_test.go`:

```go
package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestUserStoreCreateAuthenticate(t *testing.T) {
	s := newUserStore("")
	if err := s.create("alice", "s3cret", true); err != nil {
		t.Fatalf("create: %v", err)
	}
	if !s.authenticate("alice", "s3cret") {
		t.Fatalf("authenticate with correct password failed")
	}
	if s.authenticate("alice", "wrong") {
		t.Fatalf("authenticate with wrong password succeeded")
	}
	if s.authenticate("bob", "s3cret") {
		t.Fatalf("authenticate for absent user succeeded")
	}
	if !s.isAdmin("alice") {
		t.Fatalf("alice should be admin")
	}
}

func TestUserStoreValidation(t *testing.T) {
	s := newUserStore("")
	if err := s.create("bad name!", "s3cret", false); err != errBadUsername {
		t.Fatalf("bad username err = %v, want errBadUsername", err)
	}
	if err := s.create("bob", "short", false); err != errPasswordTooShort {
		t.Fatalf("short password err = %v, want errPasswordTooShort", err)
	}
	_ = s.create("bob", "s3cret", false)
	if err := s.create("bob", "another", false); err != errUserExists {
		t.Fatalf("duplicate err = %v, want errUserExists", err)
	}
}

func TestUserStoreDeleteAndList(t *testing.T) {
	s := newUserStore("")
	_ = s.create("alice", "s3cret", true)
	_ = s.create("bob", "s3cret", false)
	if s.count() != 2 || s.countAdmins() != 1 {
		t.Fatalf("count=%d admins=%d, want 2/1", s.count(), s.countAdmins())
	}
	if err := s.delete("carol"); err != errNoSuchUser {
		t.Fatalf("delete absent err = %v, want errNoSuchUser", err)
	}
	if err := s.delete("bob"); err != nil {
		t.Fatalf("delete bob: %v", err)
	}
	l := s.list()
	if len(l) != 1 || l[0].Username != "alice" || !l[0].Admin {
		t.Fatalf("list = %+v, want [alice admin]", l)
	}
}

func TestUserStorePersistenceAndHashing(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "users.json")
	s := newUserStore(path)
	_ = s.create("alice", "s3cret", true)

	// Password must NOT appear in plaintext on disk.
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read users.json: %v", err)
	}
	if string(raw) == "" {
		t.Fatalf("users.json empty")
	}
	if containsSubstr(string(raw), "s3cret") {
		t.Fatalf("plaintext password found on disk")
	}

	// Reload from disk: the user and its (hashed) password survive.
	s2 := newUserStore(path)
	if !s2.authenticate("alice", "s3cret") {
		t.Fatalf("reloaded store failed to authenticate")
	}
}

func containsSubstr(hay, needle string) bool {
	return len(hay) >= len(needle) && (func() bool {
		for i := 0; i+len(needle) <= len(hay); i++ {
			if hay[i:i+len(needle)] == needle {
				return true
			}
		}
		return false
	})()
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd server && go test ./... -run TestUserStore -v`
Expected: build error — `newUserStore`, `userStore`, sentinels, etc. undefined.

- [ ] **Step 4: Implement the user store**

Create `server/users.go`:

```go
package main

import (
	"encoding/json"
	"errors"
	"os"
	"regexp"
	"sort"
	"sync"

	"golang.org/x/crypto/bcrypt"
)

const minPasswordLen = 6

var usernameRe = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,32}$`)

var (
	errUserExists       = errors.New("user already exists")
	errNoSuchUser       = errors.New("no such user")
	errBadUsername      = errors.New("invalid username")
	errPasswordTooShort = errors.New("password too short")
)

// userRecord is one account as persisted in users.json.
type userRecord struct {
	Username     string `json:"username"`
	PasswordHash string `json:"passwordHash"`
	Admin        bool   `json:"admin"`
	Created      int64  `json:"created"` // unix millis
}

// userInfo is the safe, hash-free view returned to admin clients.
type userInfo struct {
	Username string `json:"username"`
	Admin    bool   `json:"admin"`
	Created  int64  `json:"created"`
}

// userStore is the source of truth for credentials, persisted as JSON.
// path == "" keeps it in memory only (tests / no persist dir).
type userStore struct {
	mu    sync.RWMutex
	path  string
	users map[string]*userRecord
}

// newUserStore loads the store from path (if present); a missing or unreadable
// file yields an empty store so a corrupt file never permanently locks everyone
// out (seeding recreates the admin).
func newUserStore(path string) *userStore {
	s := &userStore{path: path, users: map[string]*userRecord{}}
	if path == "" {
		return s
	}
	if b, err := os.ReadFile(path); err == nil {
		var recs []*userRecord
		if json.Unmarshal(b, &recs) == nil {
			for _, r := range recs {
				if r != nil && r.Username != "" {
					s.users[r.Username] = r
				}
			}
		} else {
			logger.Warnf("users.json is corrupt; starting with an empty store")
		}
	}
	return s
}

// save writes the store to disk atomically (temp + rename), 0600. Caller holds
// the write lock. A prior file is backed up to <path>.bak on the first save.
func (s *userStore) save() error {
	if s.path == "" {
		return nil
	}
	recs := make([]*userRecord, 0, len(s.users))
	for _, r := range s.users {
		recs = append(recs, r)
	}
	sort.Slice(recs, func(i, j int) bool { return recs[i].Username < recs[j].Username })
	b, err := json.MarshalIndent(recs, "", "  ")
	if err != nil {
		return err
	}
	if old, err := os.ReadFile(s.path); err == nil {
		_ = os.WriteFile(s.path+".bak", old, 0o600)
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

func (s *userStore) authenticate(user, pass string) bool {
	s.mu.RLock()
	r := s.users[user]
	s.mu.RUnlock()
	if r == nil {
		return false
	}
	return bcrypt.CompareHashAndPassword([]byte(r.PasswordHash), []byte(pass)) == nil
}

func (s *userStore) isAdmin(user string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	r := s.users[user]
	return r != nil && r.Admin
}

func (s *userStore) count() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.users)
}

func (s *userStore) countAdmins() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	n := 0
	for _, r := range s.users {
		if r.Admin {
			n++
		}
	}
	return n
}

func (s *userStore) create(user, pass string, admin bool) error {
	if !usernameRe.MatchString(user) {
		return errBadUsername
	}
	if len(pass) < minPasswordLen {
		return errPasswordTooShort
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(pass), bcrypt.DefaultCost)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.users[user] != nil {
		return errUserExists
	}
	s.users[user] = &userRecord{Username: user, PasswordHash: string(hash), Admin: admin, Created: time.Now().UnixMilli()}
	return s.save()
}

func (s *userStore) delete(user string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.users[user] == nil {
		return errNoSuchUser
	}
	delete(s.users, user)
	return s.save()
}

func (s *userStore) setPassword(user, newpass string) error {
	if len(newpass) < minPasswordLen {
		return errPasswordTooShort
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(newpass), bcrypt.DefaultCost)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	r := s.users[user]
	if r == nil {
		return errNoSuchUser
	}
	r.PasswordHash = string(hash)
	return s.save()
}

func (s *userStore) list() []userInfo {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]userInfo, 0, len(s.users))
	for _, r := range s.users {
		out = append(out, userInfo{Username: r.Username, Admin: r.Admin, Created: r.Created})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Username < out[j].Username })
	return out
}
```

`users.go` imports: `encoding/json`, `errors`, `os`, `regexp`, `sort`, `sync`, `time`, `golang.org/x/crypto/bcrypt`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server && go test ./... -run TestUserStore -v`
Expected: PASS (all four store tests).

- [ ] **Step 6: Commit**

```bash
git add server/users.go server/users_test.go server/go.mod server/go.sum
git commit -m "feat(auth): add bcrypt-backed user store"
```

---

## Task 2: Auth delegates to the store; seed admin; refactor change-password

**Files:**
- Modify: `server/config.go` (`config` struct + `parseConfig`)
- Modify: `server/auth.go` (`auth` struct, `newAuth`, `checkCredentials`, `setPassword`, add `isAdmin`)
- Modify: `server/main.go` (`handlePassword`)
- Modify: `server/password_test.go` (drop pinned test; update harness)
- Test: `server/auth_seed_test.go` (create)

**Interfaces:**
- Consumes: `userStore` (Task 1), `newUserStore`, `minPasswordLen`, `errPasswordTooShort`, `errNoSuchUser`.
- Produces:
  - `config.usersFile string` (replaces `passwordFile`, `passwordPinned`).
  - `auth` fields `enabled bool`, `secret []byte`, `store *userStore`.
  - `func (a *auth) checkCredentials(user, pass string) bool` (unchanged signature).
  - `func (a *auth) setPassword(user, newpass string) error`.
  - `func (a *auth) isAdmin(user string) bool`.
  - `newAuth(cfg *config) *auth` (unchanged signature — builds + seeds the store internally).

- [ ] **Step 1: Write the failing test (seeding)**

Create `server/auth_seed_test.go`:

```go
package main

import (
	"path/filepath"
	"testing"
)

func TestNewAuthSeedsAdmin(t *testing.T) {
	dir := t.TempDir()
	cfg := &config{
		authEnabled: true,
		username:    "admin",
		password:    "s3cret1",
		tokenSecret: "seed-secret",
		usersFile:   filepath.Join(dir, "users.json"),
	}
	a := newAuth(cfg)
	if !a.checkCredentials("admin", "s3cret1") {
		t.Fatalf("seeded admin should authenticate")
	}
	if !a.isAdmin("admin") {
		t.Fatalf("seeded user should be admin")
	}

	// A restart (new auth over the same file) must NOT reseed / overwrite.
	a2 := newAuth(cfg)
	if a2.store.count() != 1 {
		t.Fatalf("restart reseeded: count=%d, want 1", a2.store.count())
	}
}

func TestAuthSetPasswordViaStore(t *testing.T) {
	dir := t.TempDir()
	cfg := &config{authEnabled: true, username: "admin", password: "s3cret1",
		tokenSecret: "x", usersFile: filepath.Join(dir, "users.json")}
	a := newAuth(cfg)
	if err := a.setPassword("admin", "brandnew"); err != nil {
		t.Fatalf("setPassword: %v", err)
	}
	if a.checkCredentials("admin", "s3cret1") {
		t.Fatalf("old password still works")
	}
	if !a.checkCredentials("admin", "brandnew") {
		t.Fatalf("new password does not work")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && go test ./... -run 'TestNewAuthSeeds|TestAuthSetPassword' -v`
Expected: build error — `config.usersFile`, `auth.store`, `auth.isAdmin` undefined; `newAuth` still uses removed fields.

- [ ] **Step 3: Update `config` (add `usersFile`, drop `passwordFile`/`passwordPinned`)**

In `server/config.go`, in the `config` struct remove the two fields added by the prior feature and add `usersFile`:

```go
	generatedPassword bool
	usersFile         string // path to the persisted user store ("" = in-memory only)
```

In `parseConfig`, replace the `passwordFile`/`passwordPinned` computation with:

```go
	usersFile := ""
	if pdir != "" {
		usersFile = filepath.Join(pdir, "users.json")
	}
```

In the returned `&config{...}` literal, replace the `passwordFile:`/`passwordPinned:` lines with:

```go
		usersFile:         usersFile,
```

- [ ] **Step 4: Rewrite `auth.go` to delegate to the store**

Replace the `auth` struct, `newAuth`, `checkCredentials`, `setPassword` and add `isAdmin`. The `import` block drops `crypto/subtle`, `os`, `sync` (no longer used) and keeps `crypto/hmac`, `crypto/sha256`, `encoding/base64`, `encoding/json`, `net/http`, `strings`, `time`.

```go
type auth struct {
	enabled bool
	secret  []byte
	store   *userStore
}

// newAuth builds the user store, seeding a first admin from cfg.username/password
// when the store is empty, and returns an auth that delegates credential checks
// to the store. The store is authoritative once seeded.
func newAuth(cfg *config) *auth {
	store := newUserStore(cfg.usersFile)
	if cfg.authEnabled && store.count() == 0 {
		if err := store.create(cfg.username, cfg.password, true); err != nil {
			logger.Warnf("seed admin failed: %v", err)
		}
	}
	return &auth{enabled: cfg.authEnabled, secret: []byte(cfg.tokenSecret), store: store}
}
```

Replace `checkCredentials` and `setPassword`, and add `isAdmin`:

```go
// checkCredentials verifies user+password against the store (bcrypt). With auth
// disabled every request is allowed.
func (a *auth) checkCredentials(user, pass string) bool {
	if !a.enabled {
		return true
	}
	return a.store.authenticate(user, pass)
}

// setPassword changes a user's password in the store.
func (a *auth) setPassword(user, newpass string) error {
	return a.store.setPassword(user, newpass)
}

// isAdmin reports whether the user is an admin (false when auth is disabled).
func (a *auth) isAdmin(user string) bool {
	if !a.enabled {
		return false
	}
	return a.store.isAdmin(user)
}
```

(`issueToken`, `verifyToken`, `sign`, `extractToken`, and the const block stay unchanged. Delete the old `password`/`passFile`/`pinned`/`mu` fields and their logic.)

- [ ] **Step 5: Update `handlePassword` (per-user, drop pinned warning)**

In `server/main.go`, replace the body of `handlePassword` from the `setPassword` call onward. The full handler becomes:

```go
// handlePassword changes the caller's password. Requires a valid token AND the
// correct current password, so a stolen token alone cannot lock out the account.
func (s *server) handlePassword(w http.ResponseWriter, r *http.Request) {
	p := s.auth.verifyToken(extractToken(r))
	if p == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	if !s.auth.enabled {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "auth is disabled"})
		return
	}
	var body struct {
		OldPassword string `json:"oldPassword"`
		NewPassword string `json:"newPassword"`
	}
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 64*1024)).Decode(&body)
	if !s.auth.checkCredentials(p.User, body.OldPassword) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "current password is incorrect"})
		return
	}
	if len(body.NewPassword) < minPasswordLen {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "new password must be at least 6 characters"})
		return
	}
	if err := s.auth.setPassword(p.User, body.NewPassword); err != nil {
		logger.Warnf("password change failed for %s: %v", p.User, err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to change password"})
		return
	}
	logger.Infof("password changed for user=%s", p.User)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
```

- [ ] **Step 6: Update `password_test.go` (remove pinned test; fix harness)**

In `server/password_test.go`:
1. Change `pwTestServer` to seed via a temp `usersFile` (drop the old `passFile`/`pinned` params). Replace the whole function with:

```go
func pwTestServer(t *testing.T) (*httptest.Server, *server) {
	t.Helper()
	cfg := &config{authEnabled: true, username: "alice", password: "s3cret", tokenSecret: "pw-secret",
		usersFile: filepath.Join(t.TempDir(), "users.json")}
	srv := &server{cfg: cfg, auth: newAuth(cfg)}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/login", srv.handleLogin)
	mux.HandleFunc("POST /api/password", srv.handlePassword)
	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)
	return ts, srv
}
```

2. In `TestChangePassword`, update the call site and drop the now-removed on-disk assertion. Replace the setup lines:

```go
func TestChangePassword(t *testing.T) {
	ts, _ := pwTestServer(t)
	token := postLogin(t, ts.URL, map[string]any{"username": "alice", "password": "s3cret"})
```

and delete the final "Persisted to file" block (the `os.ReadFile(passFile)` assertion) — persistence is covered by Task 1's store tests. `path/filepath` is still used (by `pwTestServer`); remove the `os` import if nothing else in the file uses it.

3. **Delete** `TestChangePasswordPinnedWarns` entirely (env-pinned warning no longer exists).

4. In `TestChangePasswordNoAuthRejected`, keep it but its `cfg` no longer needs user fields:

```go
func TestChangePasswordNoAuthRejected(t *testing.T) {
	cfg := &config{authEnabled: false, tokenSecret: "x"}
	srv := &server{cfg: cfg, auth: newAuth(cfg)}
	...
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd server && go test ./... -run 'TestNewAuthSeeds|TestAuthSetPassword|TestChangePassword' -v`
Expected: PASS.

Run the whole suite: `cd server && go test ./...`
Expected: PASS (e2e/takeover/sessions use `newAuth(cfg)` unchanged — they now seed a store transparently from their existing `username`/`password` config; `authEnabled:false` cases skip seeding).

- [ ] **Step 8: Commit**

```bash
git add server/auth.go server/config.go server/main.go server/password_test.go server/auth_seed_test.go
git commit -m "refactor(auth): back auth with the user store; seed admin on first boot"
```

---

## Task 3: Admin user endpoints + `/api/me` admin flag

**Files:**
- Modify: `server/main.go` (add `requireAdmin`, `handleUsers`, `handleUserDelete`; extend `handleMe`; register routes)
- Test: `server/users_endpoint_test.go` (create)

**Interfaces:**
- Consumes: `auth.isAdmin`, `auth.store` (`create`/`delete`/`list`/`isAdmin`/`countAdmins`), `verifyToken`, `extractToken`, `errUserExists`, `errBadUsername`, `errPasswordTooShort`, `errNoSuchUser`.
- Produces: routes `POST /api/users`, `GET /api/users`, `DELETE /api/users`; `/api/me` returns `admin`.

- [ ] **Step 1: Write the failing test**

Create `server/users_endpoint_test.go`:

```go
package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
)

func usersTestServer(t *testing.T) *httptest.Server {
	t.Helper()
	cfg := &config{authEnabled: true, username: "admin", password: "s3cret1",
		tokenSecret: "u-secret", usersFile: filepath.Join(t.TempDir(), "users.json")}
	srv := &server{cfg: cfg, auth: newAuth(cfg)}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/login", srv.handleLogin)
	mux.HandleFunc("/api/me", srv.handleMe)
	mux.HandleFunc("POST /api/users", srv.handleUsers)
	mux.HandleFunc("GET /api/users", srv.handleUsers)
	mux.HandleFunc("DELETE /api/users", srv.handleUserDelete)
	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)
	return ts
}

func doJSON(t *testing.T, method, url, token string, body any) *http.Response {
	t.Helper()
	var rdr *bytes.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rdr = bytes.NewReader(b)
	} else {
		rdr = bytes.NewReader(nil)
	}
	req, _ := http.NewRequest(method, url, rdr)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, url, err)
	}
	return resp
}

func TestUsersEndpointsAdminFlow(t *testing.T) {
	ts := usersTestServer(t)
	adminTok := postLogin(t, ts.URL, map[string]any{"username": "admin", "password": "s3cret1"})

	// /api/me reports admin=true for the admin.
	{
		resp := doJSON(t, "GET", ts.URL+"/api/me", adminTok, nil)
		var m map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&m)
		if m["admin"] != true {
			t.Fatalf("admin /api/me admin=%v, want true", m["admin"])
		}
	}

	// Admin creates a regular user, who can then log in.
	if resp := doJSON(t, "POST", ts.URL+"/api/users", adminTok,
		map[string]any{"username": "bob", "password": "bobpass", "admin": false}); resp.StatusCode != 200 {
		t.Fatalf("create bob status=%d, want 200", resp.StatusCode)
	}
	bobTok := postLogin(t, ts.URL, map[string]any{"username": "bob", "password": "bobpass"})

	// bob is not an admin: /api/me admin=false, and admin endpoints are 403.
	{
		resp := doJSON(t, "GET", ts.URL+"/api/me", bobTok, nil)
		var m map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&m)
		if m["admin"] != false {
			t.Fatalf("bob /api/me admin=%v, want false", m["admin"])
		}
	}
	if resp := doJSON(t, "GET", ts.URL+"/api/users", bobTok, nil); resp.StatusCode != 403 {
		t.Fatalf("bob GET /api/users status=%d, want 403", resp.StatusCode)
	}

	// Duplicate create -> 409.
	if resp := doJSON(t, "POST", ts.URL+"/api/users", adminTok,
		map[string]any{"username": "bob", "password": "bobpass"}); resp.StatusCode != 409 {
		t.Fatalf("dup create status=%d, want 409", resp.StatusCode)
	}

	// List shows both, sorted.
	{
		resp := doJSON(t, "GET", ts.URL+"/api/users", adminTok, nil)
		var m struct {
			Users []userInfo `json:"users"`
		}
		_ = json.NewDecoder(resp.Body).Decode(&m)
		if len(m.Users) != 2 || m.Users[0].Username != "admin" || m.Users[1].Username != "bob" {
			t.Fatalf("list = %+v, want [admin bob]", m.Users)
		}
	}

	// Delete guards: admin cannot delete self (last admin AND self).
	if resp := doJSON(t, "DELETE", ts.URL+"/api/users?username=admin", adminTok, nil); resp.StatusCode != 400 {
		t.Fatalf("delete self status=%d, want 400", resp.StatusCode)
	}
	// Delete bob works.
	if resp := doJSON(t, "DELETE", ts.URL+"/api/users?username=bob", adminTok, nil); resp.StatusCode != 200 {
		t.Fatalf("delete bob status=%d, want 200", resp.StatusCode)
	}
	// Delete absent -> 404.
	if resp := doJSON(t, "DELETE", ts.URL+"/api/users?username=ghost", adminTok, nil); resp.StatusCode != 404 {
		t.Fatalf("delete ghost status=%d, want 404", resp.StatusCode)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && go test ./... -run TestUsersEndpoints -v`
Expected: build error — `handleUsers`, `handleUserDelete` undefined; `/api/me` has no `admin`.

- [ ] **Step 3: Add `requireAdmin`, the handlers, and extend `handleMe`**

In `server/main.go`, extend `handleMe` to include `admin`:

```go
func (s *server) handleMe(w http.ResponseWriter, r *http.Request) {
	p := s.auth.verifyToken(extractToken(r))
	if p == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"user": p.User, "authEnabled": s.auth.enabled, "admin": s.auth.isAdmin(p.User)})
}
```

Add the admin gate and user handlers (place after `handlePassword`):

```go
// requireAdmin verifies the token and that the caller is an admin. On failure it
// writes 401/403 and returns nil.
func (s *server) requireAdmin(w http.ResponseWriter, r *http.Request) *tokenPayload {
	p := s.auth.verifyToken(extractToken(r))
	if p == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return nil
	}
	if !s.auth.isAdmin(p.User) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "admin required"})
		return nil
	}
	return p
}

// handleUsers lists users (GET) or creates one (POST). Admin only.
func (s *server) handleUsers(w http.ResponseWriter, r *http.Request) {
	if s.requireAdmin(w, r) == nil {
		return
	}
	if r.Method == http.MethodGet {
		writeJSON(w, http.StatusOK, map[string]any{"users": s.auth.store.list()})
		return
	}
	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
		Admin    bool   `json:"admin"`
	}
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 64*1024)).Decode(&body)
	switch err := s.auth.store.create(body.Username, body.Password, body.Admin); err {
	case nil:
		logger.Infof("user created: %s (admin=%v)", body.Username, body.Admin)
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	case errUserExists:
		writeJSON(w, http.StatusConflict, map[string]string{"error": "user already exists"})
	case errBadUsername:
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "username must be 1-32 chars of letters, digits, _ . -"})
	case errPasswordTooShort:
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "password must be at least 6 characters"})
	default:
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to create user"})
	}
}

// handleUserDelete removes ?username=<u>. Admin only. Guards against deleting
// yourself or the last remaining admin.
func (s *server) handleUserDelete(w http.ResponseWriter, r *http.Request) {
	p := s.requireAdmin(w, r)
	if p == nil {
		return
	}
	target := r.URL.Query().Get("username")
	if target == p.User {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "cannot delete yourself"})
		return
	}
	if s.auth.store.isAdmin(target) && s.auth.store.countAdmins() <= 1 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "cannot delete the last admin"})
		return
	}
	switch err := s.auth.store.delete(target); err {
	case nil:
		logger.Infof("user deleted: %s", target)
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	case errNoSuchUser:
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such user"})
	default:
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to delete user"})
	}
}
```

- [ ] **Step 4: Register the routes**

In `server/main.go` `main()`, after the `POST /api/password` line (~281):

```go
	mux.HandleFunc("GET /api/users", srv.handleUsers)
	mux.HandleFunc("POST /api/users", srv.handleUsers)
	mux.HandleFunc("DELETE /api/users", srv.handleUserDelete)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server && go test ./... -run TestUsersEndpoints -v`
Expected: PASS.

Run the whole suite: `cd server && go test ./...`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/main.go server/users_endpoint_test.go
git commit -m "feat(auth): admin endpoints to create/list/delete users; /api/me admin flag"
```

---

## Task 4: Web — admin gating + Manage users UI

**Files:**
- Modify: `web/index.html` (menu item + `#users-overlay`)
- Modify: `web/css/style.css` (overlay styles)
- Modify: `web/js/app.js` (capture `admin` from `/api/me`, gate menu item, list/create/delete)

**Interfaces:**
- Consumes: `GET/POST/DELETE /api/users`, `/api/me` `admin` field (Task 3); module `token`, `$()`, existing `MENU_ACTIONS` (app.js:657), `boot()` (app.js:457), initial load (app.js:947).
- Produces: nothing downstream.

- [ ] **Step 1: Add the menu item and overlay markup**

In `web/index.html`, add to `#menu` (before the `logout` button):

```html
        <button data-act="users" id="menu-users" class="hidden">Manage users</button>
```

Add the overlay after the change-password overlay block:

```html
  <!-- Manage users overlay (admin only) -->
  <div id="users-overlay" class="hidden">
    <div id="users-box">
      <h3>Manage users</h3>
      <p id="users-msg" class="hint hidden"></p>
      <ul id="users-list"></ul>
      <form id="users-create">
        <input id="nu-name" type="text" placeholder="New username" autocapitalize="off" autocorrect="off" spellcheck="false" />
        <input id="nu-pass" type="password" placeholder="Password (min 6)" autocomplete="new-password" />
        <label class="nu-admin"><input id="nu-admin" type="checkbox" /> Admin</label>
        <button type="submit" class="primary">Create</button>
      </form>
      <div class="users-actions"><button type="button" id="users-close">Close</button></div>
    </div>
  </div>
```

- [ ] **Step 2: Add overlay styles**

In `web/css/style.css`, append:

```css
/* ---------- manage-users overlay ---------- */
#users-overlay {
  position: fixed;
  inset: 0;
  z-index: 70;
  background: rgba(0, 0, 0, 0.75);
  display: flex;
  align-items: center;
  justify-content: center;
}
#users-box {
  background: #252526;
  padding: 24px;
  border-radius: 8px;
  width: 360px;
  max-width: 92vw;
  display: flex;
  flex-direction: column;
  gap: 12px;
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
}
#users-box h3 { margin: 0; color: #eee; text-align: center; }
#users-box .hint { margin: 0; font-size: 13px; color: #f48771; text-align: center; }
#users-box .hint.ok { color: #89d185; }
#users-list { list-style: none; margin: 0; padding: 0; max-height: 40vh; overflow-y: auto; }
#users-list li { display: flex; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px solid #333; color: #ddd; }
#users-list .uname { flex: 1; }
#users-list .badge { font-size: 11px; color: #0e639c; border: 1px solid #0e639c; border-radius: 4px; padding: 0 6px; }
#users-list .del { background: transparent; border: 0; color: #f48771; cursor: pointer; }
#users-list .del[disabled] { color: #666; cursor: default; }
#users-create { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
#users-create input[type="text"], #users-create input[type="password"] {
  flex: 1 1 45%;
  padding: 8px;
  border-radius: 4px;
  border: 1px solid #555;
  background: #1e1e1e;
  color: #eee;
  font-size: 16px;
}
#users-create .nu-admin { display: flex; align-items: center; gap: 6px; color: #ccc; font-size: 13px; }
#users-create .primary { padding: 8px 12px; background: #0e639c; border-color: #0e639c; color: #fff; }
.users-actions { display: flex; justify-content: flex-end; }
.users-actions button { padding: 8px 14px; }
body.light #users-box { background: #fff; }
body.light #users-box h3 { color: #222; }
```

- [ ] **Step 3: Wire admin detection, menu gating, and CRUD in app.js**

In `web/js/app.js`, add a `change-password`-style entry to `MENU_ACTIONS` (the object at app.js:657):

```js
    users: function () { showUsers(); },
```

Add this block right after the change-password handler block:

```js
  // --------------------------------------------------------------------------
  // Manage users (admin only)
  // --------------------------------------------------------------------------
  let currentUser = localStorage.getItem('rs_user') || '';

  // refreshAdmin reads /api/me and shows the "Manage users" menu item for admins.
  async function refreshAdmin() {
    if (!token) { $('menu-users').classList.add('hidden'); return; }
    try {
      const r = await fetch('/api/me', { headers: { Authorization: 'Bearer ' + token } });
      if (!r.ok) { $('menu-users').classList.add('hidden'); return; }
      const me = await r.json();
      currentUser = me.user || currentUser;
      $('menu-users').classList.toggle('hidden', !me.admin);
    } catch (e) { $('menu-users').classList.add('hidden'); }
  }

  function usersMsg(text, ok) {
    const m = $('users-msg');
    m.textContent = text || '';
    m.className = 'hint' + (ok ? ' ok' : '') + (text ? '' : ' hidden');
  }

  async function loadUsers() {
    const r = await fetch('/api/users', { headers: { Authorization: 'Bearer ' + token } });
    if (!r.ok) { usersMsg('Failed to load users', false); return; }
    const data = await r.json();
    const ul = $('users-list');
    ul.innerHTML = '';
    (data.users || []).forEach(function (u) {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.className = 'uname';
      name.textContent = u.username;
      li.appendChild(name);
      if (u.admin) {
        const b = document.createElement('span');
        b.className = 'badge';
        b.textContent = 'admin';
        li.appendChild(b);
      }
      const del = document.createElement('button');
      del.className = 'del';
      del.textContent = 'Delete';
      if (u.username === currentUser) { del.disabled = true; del.title = 'You cannot delete yourself'; }
      del.onclick = function () { deleteUser(u.username); };
      li.appendChild(del);
      ul.appendChild(li);
    });
  }

  function showUsers() {
    usersMsg('', false);
    $('nu-name').value = '';
    $('nu-pass').value = '';
    $('nu-admin').checked = false;
    $('users-overlay').classList.remove('hidden');
    loadUsers();
  }
  function hideUsers() { $('users-overlay').classList.add('hidden'); }
  $('users-close').onclick = hideUsers;

  async function deleteUser(username) {
    try {
      const r = await fetch('/api/users?username=' + encodeURIComponent(username), {
        method: 'DELETE',
        headers: { Authorization: 'Bearer ' + token },
      });
      const data = await r.json().catch(function () { return {}; });
      if (!r.ok) { usersMsg(data.error || ('HTTP ' + r.status), false); return; }
      usersMsg('Deleted ' + username, true);
      loadUsers();
    } catch (e) { usersMsg('Request failed: ' + e.message, false); }
  }

  $('users-create').addEventListener('submit', async function (e) {
    e.preventDefault();
    const username = $('nu-name').value.trim();
    const password = $('nu-pass').value;
    const admin = $('nu-admin').checked;
    if (password.length < 6) { usersMsg('Password must be at least 6 characters', false); return; }
    try {
      const r = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ username: username, password: password, admin: admin }),
      });
      const data = await r.json().catch(function () { return {}; });
      if (!r.ok) { usersMsg(data.error || ('HTTP ' + r.status), false); return; }
      usersMsg('Created ' + username, true);
      $('nu-name').value = ''; $('nu-pass').value = ''; $('nu-admin').checked = false;
      loadUsers();
    } catch (e) { usersMsg('Request failed: ' + e.message, false); }
  });
```

Then call `refreshAdmin()` at the two points a session becomes active:
1. In the login-form submit success path, right after `boot();` (app.js:523):

```js
      boot();
      refreshAdmin();
```

2. At initial load (app.js:947), inside the `if (ok)` branch:

```js
    verifyToken().then(function (ok) { if (ok) { boot(); refreshAdmin(); } else showLogin(); });
```

- [ ] **Step 4: Manual verification**

No browser in this environment; run `node --check web/js/app.js` (syntax) and cross-check IDs. Then note browser verification (log in as admin → "Manage users" appears → create bob → bob appears → bob logs in with no "Manage users" → delete bob; self-delete disabled) is deferred to the human.

Run: `node --check web/js/app.js`
Expected: no output (valid).

- [ ] **Step 5: Commit**

```bash
git add web/index.html web/css/style.css web/js/app.js
git commit -m "feat(web): admin-only manage-users UI"
```

---

## Task 5: Android — `/api/me` admin parse + AuthClient user methods + ViewModel

**Files:**
- Modify: `android/app/src/main/java/com/remoteshell/android/net/AuthClient.kt`
- Modify: `android/app/src/main/java/com/remoteshell/android/MainViewModel.kt`

**Interfaces:**
- Consumes: `GET/POST/DELETE /api/users`, `/api/me` `admin` (Task 3).
- Produces:
  - `data class UserInfo(val username: String, val admin: Boolean, val created: Long)`
  - `fun AuthClient.fetchAdmin(serverUrl, token): Boolean` (false on any failure)
  - `fun AuthClient.listUsers(serverUrl, token): Result<List<UserInfo>>` (kotlin.Result)
  - `fun AuthClient.createUser(serverUrl, token, username, password, admin): String?` (null=ok, else error message)
  - `fun AuthClient.deleteUser(serverUrl, token, username): String?` (null=ok, else error message)
  - `UiState.admin: Boolean`; `MainViewModel.loadUsers(onResult)`, `.createUser(...)`, `.deleteUser(...)`; `currentUsername`.

- [ ] **Step 1: Add the data class and user methods to AuthClient**

In `AuthClient.kt`, add the import `import org.json.JSONArray` (top, with the other imports) and, after the `ChangePasswordResult` block, add:

```kotlin
/** One account as returned by GET /api/users. */
data class UserInfo(val username: String, val admin: Boolean, val created: Long)
```

Add these methods inside the `AuthClient` class (after `changePassword`, before the `companion object`):

```kotlin
    /** GET /api/me -> admin flag. Returns false on any error (non-admin/expired/network). */
    fun fetchAdmin(serverUrl: String, token: String): Boolean {
        val base = serverUrl.trim().trimEnd('/')
        if (base.isEmpty() || token.isEmpty()) return false
        val req = Request.Builder().url("$base/api/me").header("Authorization", "Bearer $token").get().build()
        return try {
            http.newCall(req).execute().use { res ->
                if (!res.isSuccessful) false
                else JSONObject(res.body?.string() ?: "{}").optBoolean("admin", false)
            }
        } catch (e: Exception) { false }
    }

    /** GET /api/users. */
    fun listUsers(serverUrl: String, token: String): Result<List<UserInfo>> {
        val base = serverUrl.trim().trimEnd('/')
        if (base.isEmpty() || token.isEmpty()) return Result.failure(Exception("Not signed in"))
        val req = Request.Builder().url("$base/api/users").header("Authorization", "Bearer $token").get().build()
        return try {
            http.newCall(req).execute().use { res ->
                val json = JSONObject(res.body?.string() ?: "{}")
                if (!res.isSuccessful) return Result.failure(Exception(json.optString("error").ifEmpty { "HTTP ${res.code}" }))
                val arr: JSONArray = json.optJSONArray("users") ?: JSONArray()
                val out = ArrayList<UserInfo>(arr.length())
                for (i in 0 until arr.length()) {
                    val o = arr.getJSONObject(i)
                    out.add(UserInfo(o.optString("username"), o.optBoolean("admin"), o.optLong("created")))
                }
                Result.success(out)
            }
        } catch (e: Exception) { Result.failure(e) }
    }

    /** POST /api/users. Returns null on success, else a human-readable error. */
    fun createUser(serverUrl: String, token: String, username: String, password: String, admin: Boolean): String? {
        val base = serverUrl.trim().trimEnd('/')
        if (base.isEmpty() || token.isEmpty()) return "Not signed in"
        val body = JSONObject().put("username", username).put("password", password).put("admin", admin)
            .toString().toRequestBody(JSON)
        val req = Request.Builder().url("$base/api/users").header("Authorization", "Bearer $token").post(body).build()
        return try {
            http.newCall(req).execute().use { res ->
                if (res.isSuccessful) null
                else JSONObject(res.body?.string() ?: "{}").optString("error").ifEmpty { "HTTP ${res.code}" }
            }
        } catch (e: Exception) { e.message ?: "Network error" }
    }

    /** DELETE /api/users?username=. Returns null on success, else a human-readable error. */
    fun deleteUser(serverUrl: String, token: String, username: String): String? {
        val base = serverUrl.trim().trimEnd('/')
        if (base.isEmpty() || token.isEmpty()) return "Not signed in"
        val url = "$base/api/users?username=" + java.net.URLEncoder.encode(username, "UTF-8")
        val req = Request.Builder().url(url).header("Authorization", "Bearer $token").delete().build()
        return try {
            http.newCall(req).execute().use { res ->
                if (res.isSuccessful) null
                else JSONObject(res.body?.string() ?: "{}").optString("error").ifEmpty { "HTTP ${res.code}" }
            }
        } catch (e: Exception) { e.message ?: "Network error" }
    }
```

- [ ] **Step 2: Add `admin` to UiState and the ViewModel methods**

In `MainViewModel.kt`, add `import com.remoteshell.android.net.UserInfo` (with the other net imports). Add `val admin: Boolean = false` to `UiState` (after `darkTheme`).

In `enterTerminal()`, after the `_state.update { ... }` block (before `c.connect()`), fetch the admin flag:

```kotlin
        viewModelScope.launch {
            val isAdmin = withContext(Dispatchers.IO) { auth.fetchAdmin(prefs.serverUrl, prefs.token) }
            _state.update { it.copy(admin = isAdmin) }
        }
        c.connect()
```

Reset `admin` to false where the app returns to login — in `onNeedLogin()`, `killSession()`, and `logout()` add `admin = false` to their `_state.update { it.copy(...) }` calls.

Add the manage-users methods (after `changePassword`):

```kotlin
    /** Load the user list (admin only). [onResult] runs on the main thread. */
    fun loadUsers(onResult: (Result<List<UserInfo>>) -> Unit) {
        viewModelScope.launch {
            val r = withContext(Dispatchers.IO) { auth.listUsers(prefs.serverUrl, prefs.token) }
            onResult(r)
        }
    }

    /** Create a user (admin only). [onResult] gets null on success, else an error message. */
    fun createUser(username: String, password: String, admin: Boolean, onResult: (String?) -> Unit) {
        viewModelScope.launch {
            val err = withContext(Dispatchers.IO) { auth.createUser(prefs.serverUrl, prefs.token, username, password, admin) }
            onResult(err)
        }
    }

    /** Delete a user (admin only). [onResult] gets null on success, else an error message. */
    fun deleteUser(username: String, onResult: (String?) -> Unit) {
        viewModelScope.launch {
            val err = withContext(Dispatchers.IO) { auth.deleteUser(prefs.serverUrl, prefs.token, username) }
            onResult(err)
        }
    }
```

- [ ] **Step 3: Build to verify it compiles**

Run: `cd android && ANDROID_HOME=~/Android/Sdk ./gradlew :app:assembleDebug --offline`
Expected: BUILD SUCCESSFUL.

- [ ] **Step 4: Commit**

```bash
git add android/app/src/main/java/com/remoteshell/android/net/AuthClient.kt android/app/src/main/java/com/remoteshell/android/MainViewModel.kt
git commit -m "feat(android): user-admin API client + admin flag in state"
```

---

## Task 6: Android — Manage users dialog

**Files:**
- Modify: `android/app/src/main/java/com/remoteshell/android/ui/TerminalScreen.kt`
- Modify: `android/app/src/main/java/com/remoteshell/android/MainActivity.kt`

**Interfaces:**
- Consumes: `UiState.admin`, `UiState.username`; `MainViewModel.loadUsers/createUser/deleteUser`; `UserInfo` (Task 5).
- Produces: a `Manage users` menu item + dialog; `onManageUsers` wiring.

- [ ] **Step 1: Thread three callbacks + admin flag into the top bar**

In `TerminalScreen.kt`, add imports (with the existing ones):

```kotlin
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import com.remoteshell.android.net.UserInfo
```

Add three params to `TerminalScreen(...)` (after `onChangePassword`):

```kotlin
    onChangePassword: (old: String, new: String, onResult: (ChangePasswordResult) -> Unit) -> Unit,
    onLoadUsers: (onResult: (Result<List<UserInfo>>) -> Unit) -> Unit,
    onCreateUser: (username: String, password: String, admin: Boolean, onResult: (String?) -> Unit) -> Unit,
    onDeleteUser: (username: String, onResult: (String?) -> Unit) -> Unit,
```

Pass them into the `TerminalTopBar(...)` call:

```kotlin
            TerminalTopBar(
                state, onReconnect, onDisconnect, onKill, onLogout,
                onChangeFont, onClearScreen, onToggleTheme, onChangePassword,
                onLoadUsers, onCreateUser, onDeleteUser,
            ) { controller.showKeyboard() }
```

Add the matching params to `TerminalTopBar(...)` (after `onChangePassword`, before `onShowKeyboard`):

```kotlin
    onChangePassword: (old: String, new: String, onResult: (ChangePasswordResult) -> Unit) -> Unit,
    onLoadUsers: (onResult: (Result<List<UserInfo>>) -> Unit) -> Unit,
    onCreateUser: (username: String, password: String, admin: Boolean, onResult: (String?) -> Unit) -> Unit,
    onDeleteUser: (username: String, onResult: (String?) -> Unit) -> Unit,
    onShowKeyboard: () -> Unit,
```

- [ ] **Step 2: Add the menu item + dialog state**

In `TerminalTopBar`, next to `var showChangePw`, add:

```kotlin
    var showUsers by remember { mutableStateOf(false) }
```

In the `DropdownMenu`, after the `Change password` item, add (admin only):

```kotlin
                if (state.admin) {
                    DropdownMenuItem(
                        text = { Text("Manage users") },
                        onClick = { menu = false; showUsers = true },
                    )
                }
```

After the `if (showChangePw) { ChangePasswordDialog(...) }` block, add:

```kotlin
    if (showUsers) {
        ManageUsersDialog(
            currentUser = state.username,
            onDismiss = { showUsers = false },
            onLoad = onLoadUsers,
            onCreate = onCreateUser,
            onDelete = onDeleteUser,
        )
    }
```

- [ ] **Step 3: Add the `ManageUsersDialog` composable**

At the end of `TerminalScreen.kt`, add:

```kotlin
@Composable
private fun ManageUsersDialog(
    currentUser: String,
    onDismiss: () -> Unit,
    onLoad: (onResult: (Result<List<UserInfo>>) -> Unit) -> Unit,
    onCreate: (username: String, password: String, admin: Boolean, onResult: (String?) -> Unit) -> Unit,
    onDelete: (username: String, onResult: (String?) -> Unit) -> Unit,
) {
    var users by remember { mutableStateOf<List<UserInfo>>(emptyList()) }
    var newName by remember { mutableStateOf("") }
    var newPass by remember { mutableStateOf("") }
    var newAdmin by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }

    fun reload() {
        onLoad { r ->
            r.onSuccess { users = it }.onFailure { message = it.message ?: "Failed to load users" }
        }
    }
    LaunchedEffect(Unit) { reload() }

    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text("Manage users") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                LazyColumn(modifier = Modifier.fillMaxWidth().heightIn(max = 220.dp)) {
                    items(users, key = { it.username }) { u ->
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                u.username + if (u.admin) "  (admin)" else "",
                                modifier = Modifier.weight(1f),
                            )
                            if (u.username != currentUser) {
                                TextButton(enabled = !busy, onClick = {
                                    busy = true; message = null
                                    onDelete(u.username) { err ->
                                        busy = false
                                        if (err != null) message = err else reload()
                                    }
                                }) { Text("Delete") }
                            }
                        }
                    }
                }
                OutlinedTextField(
                    value = newName, onValueChange = { newName = it },
                    label = { Text("New username") }, singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = newPass, onValueChange = { newPass = it },
                    label = { Text("Password (min 6)") }, singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                    modifier = Modifier.fillMaxWidth(),
                )
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(checked = newAdmin, onCheckedChange = { newAdmin = it })
                    Text("Admin")
                }
                message?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            }
        },
        confirmButton = {
            TextButton(
                enabled = !busy,
                onClick = {
                    if (newPass.length < 6) { message = "Password must be at least 6 characters"; return@TextButton }
                    busy = true; message = null
                    onCreate(newName.trim(), newPass, newAdmin) { err ->
                        busy = false
                        if (err != null) { message = err } else {
                            newName = ""; newPass = ""; newAdmin = false; reload()
                        }
                    }
                },
            ) { Text("Create") }
        },
        dismissButton = { TextButton(enabled = !busy, onClick = onDismiss) { Text("Close") } },
    )
}
```

Add the remaining imports these use (with the existing imports at the top of `TerminalScreen.kt`):

```kotlin
import androidx.compose.foundation.layout.heightIn
import androidx.compose.material3.Checkbox
import androidx.compose.runtime.LaunchedEffect
```

- [ ] **Step 4: Wire the callbacks in MainActivity**

In `MainActivity.kt`, add to the `TerminalScreen(...)` call (after `onChangePassword = vm::changePassword,`):

```kotlin
                    onChangePassword = vm::changePassword,
                    onLoadUsers = vm::loadUsers,
                    onCreateUser = vm::createUser,
                    onDeleteUser = vm::deleteUser,
```

- [ ] **Step 5: Build to verify it compiles**

Run: `cd android && ANDROID_HOME=~/Android/Sdk ./gradlew :app:assembleDebug --offline`
Expected: BUILD SUCCESSFUL.

- [ ] **Step 6: Manual verification**

No emulator here; note deferred to human: log in as admin → menu shows "Manage users" → dialog lists users, create bob → appears, delete bob → gone, self-delete not offered; log in as bob (non-admin) → no "Manage users" item.

- [ ] **Step 7: Commit**

```bash
git add android/app/src/main/java/com/remoteshell/android/ui/TerminalScreen.kt android/app/src/main/java/com/remoteshell/android/MainActivity.kt
git commit -m "feat(android): admin-only manage-users dialog"
```

---

## Final verification

- [ ] `cd server && go test ./...` → PASS
- [ ] `cd server && go test -race -count=2 ./...` → PASS (store mutex + seeding under race)
- [ ] `cd android && ANDROID_HOME=~/Android/Sdk ./gradlew :app:assembleDebug --offline` → BUILD SUCCESSFUL
- [ ] `node --check web/js/app.js` → valid
- [ ] Web + Android manual checks (Tasks 4/6) deferred to human against a running server

## Task dependency order

1 → 2 → 3 → (4, 5) → 6. Tasks 4 and 5 both depend on Task 3; Task 6 depends on Task 5.
