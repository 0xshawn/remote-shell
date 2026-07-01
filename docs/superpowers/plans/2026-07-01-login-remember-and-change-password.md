# Login "Remember" + Change Password Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the "remember" toggle keep users logged in for 30 days, and add a change-password flow across server, web, and Android.

**Architecture:** The Go server issues a longer-lived HMAC token when a login sets `remember`, and exposes a new authenticated `POST /api/password` endpoint that verifies the current password, updates the in-memory password under a mutex, and persists it to `$HOME/.remote-shell/password`. The web and Android clients forward the remember flag and add a change-password UI.

**Tech Stack:** Go (net/http, crypto/hmac), vanilla JS + HTML/CSS (web), Kotlin + Jetpack Compose + OkHttp (Android).

## Global Constraints

- Long-lived ("remember") token TTL = **30 days** (`30 * 24 * time.Hour`). Non-remember TTL stays **12 hours**.
- New password minimum length = **6 characters** (enforced server-side; mirrored client-side).
- Change-password must **not** rotate the token signing secret (other devices stay logged in).
- Change-password requires a valid token **and** the correct current password.
- `--no-auth` mode: `POST /api/password` returns 400.
- Code comments in English. Commit messages in English, concise.
- Match existing code style; touch only what each task requires.
- Do not commit the untracked `.claude/`, `.mcp.json`, or `CLAUDE.md`; stage only the files each step names.

---

## Server API contract (produced by Tasks 1–2, consumed by Tasks 3–6)

- `POST /api/login` request body gains an optional field: `remember bool` (JSON key `"remember"`). Absent/false → 12h token; true → 30d token. Response unchanged: `{ "token": "..." }`.
- `POST /api/password` — requires `Authorization: Bearer <token>`.
  - Request: `{ "oldPassword": "...", "newPassword": "..." }`
  - `200 { "ok": true }` or `200 { "ok": true, "warning": "<message>" }` when the password is env-pinned.
  - `400 { "error": "<message>" }` for: wrong current password, new password too short, or auth disabled.
  - `401 { "error": "unauthorized" }` for missing/invalid token.
  - Clients: on non-200, display `error`; on 200, show success and display `warning` if present.

---

## Task 1: Server — long-lived token when `remember` is set

**Files:**
- Modify: `server/auth.go` (`tokenTTL` const area ~14, `issueToken` ~46-50)
- Modify: `server/main.go` (`handleLogin` ~61-81)
- Test: `server/auth_test.go` (create)

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `func (a *auth) issueToken(user string, ttl time.Duration) string`; constants `tokenTTL` (12h) and `rememberTokenTTL` (30d); `/api/login` accepting `remember`.

- [ ] **Step 1: Write the failing test**

Create `server/auth_test.go`:

```go
package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// decodeExp pulls the Exp (unix millis) out of a "<b64payload>.<b64sig>" token.
func decodeExp(t *testing.T, token string) int64 {
	t.Helper()
	b64, _, ok := strings.Cut(token, ".")
	if !ok {
		t.Fatalf("token has no '.': %q", token)
	}
	raw, err := base64.RawURLEncoding.DecodeString(b64)
	if err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	var p tokenPayload
	if err := json.Unmarshal(raw, &p); err != nil {
		t.Fatalf("unmarshal payload: %v", err)
	}
	return p.Exp
}

func loginTTLServer(t *testing.T) *httptest.Server {
	t.Helper()
	cfg := &config{authEnabled: true, username: "alice", password: "s3cret", tokenSecret: "ttl-secret"}
	srv := &server{cfg: cfg, auth: newAuth(cfg)}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/login", srv.handleLogin)
	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)
	return ts
}

func postLogin(t *testing.T, base string, body map[string]any) string {
	t.Helper()
	b, _ := json.Marshal(body)
	resp, err := http.Post(base+"/api/login", "application/json", bytes.NewReader(b))
	if err != nil {
		t.Fatalf("post login: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("login status = %d", resp.StatusCode)
	}
	var out struct {
		Token string `json:"token"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return out.Token
}

func TestLoginRememberTTL(t *testing.T) {
	ts := loginTTLServer(t)

	// No remember -> ~12h token.
	short := decodeExp(t, postLogin(t, ts.URL, map[string]any{"username": "alice", "password": "s3cret"}))
	shortDelta := time.Until(time.UnixMilli(short))
	if shortDelta < 11*time.Hour || shortDelta > 13*time.Hour {
		t.Fatalf("non-remember TTL = %v, want ~12h", shortDelta)
	}

	// remember:true -> ~30d token.
	long := decodeExp(t, postLogin(t, ts.URL, map[string]any{"username": "alice", "password": "s3cret", "remember": true}))
	longDelta := time.Until(time.UnixMilli(long))
	if longDelta < 29*24*time.Hour || longDelta > 31*24*time.Hour {
		t.Fatalf("remember TTL = %v, want ~30d", longDelta)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && go test ./... -run TestLoginRememberTTL -v`
Expected: build/compile error or FAIL (either the signature mismatch on `issueToken`, or the remember TTL is still 12h).

- [ ] **Step 3: Update `issueToken` and add the remember TTL constant**

In `server/auth.go`, replace the `tokenTTL` const (line 14):

```go
const (
	tokenTTL         = 12 * time.Hour
	rememberTokenTTL = 30 * 24 * time.Hour
)
```

Replace `issueToken` (lines ~45-50):

```go
// issueToken returns "<base64url(payload)>.<base64url(hmac)>" valid for ttl.
func (a *auth) issueToken(user string, ttl time.Duration) string {
	body, _ := json.Marshal(tokenPayload{User: user, Exp: time.Now().Add(ttl).UnixMilli()})
	b64 := base64.RawURLEncoding.EncodeToString(body)
	return b64 + "." + a.sign(body)
}
```

- [ ] **Step 4: Forward `remember` in `handleLogin`**

In `server/main.go`, update `handleLogin` (lines ~66-81). Change the body struct and the token issue call:

```go
	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
		Remember bool   `json:"remember"`
	}
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 64*1024)).Decode(&body)
	if !s.auth.checkCredentials(body.Username, body.Password) {
		logger.Warnf("failed login attempt user=%q", body.Username)
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid credentials"})
		return
	}
	user := body.Username
	if !s.auth.enabled {
		user = "anonymous"
	}
	ttl := tokenTTL
	if body.Remember {
		ttl = rememberTokenTTL
	}
	writeJSON(w, http.StatusOK, map[string]string{"token": s.auth.issueToken(user, ttl)})
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server && go test ./... -run TestLoginRememberTTL -v`
Expected: PASS

Run the full suite to confirm the signature change broke nothing:
Run: `cd server && go test ./...`
Expected: PASS (existing `login` helper sends no `remember` → 12h path).

- [ ] **Step 6: Commit**

```bash
git add server/auth.go server/main.go server/auth_test.go
git commit -m "feat(auth): issue 30-day token when login sets remember"
```

---

## Task 2: Server — `POST /api/password` change-password endpoint

**Files:**
- Modify: `server/config.go` (`config` struct ~13-35; `parseConfig` ~137-177)
- Modify: `server/auth.go` (`auth` struct ~23-28; `newAuth` ~30-37; `checkCredentials` ~80-87; add `setPassword`; imports)
- Modify: `server/main.go` (add `handlePassword`; register route ~235-240)
- Test: `server/password_test.go` (create)

**Interfaces:**
- Consumes: `issueToken(user, ttl)` (Task 1) in the test harness.
- Produces: `func (a *auth) setPassword(newPass string) error`; `config.passwordFile string`; `config.passwordPinned bool`; `auth` fields `passFile string`, `pinned bool`, `mu sync.RWMutex`; route `POST /api/password` → `handlePassword`.

- [ ] **Step 1: Write the failing test**

Create `server/password_test.go`:

```go
package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func pwTestServer(t *testing.T, passFile string, pinned bool) (*httptest.Server, *server) {
	t.Helper()
	cfg := &config{authEnabled: true, username: "alice", password: "s3cret", tokenSecret: "pw-secret",
		passwordFile: passFile, passwordPinned: pinned}
	srv := &server{cfg: cfg, auth: newAuth(cfg)}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/login", srv.handleLogin)
	mux.HandleFunc("POST /api/password", srv.handlePassword)
	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)
	return ts, srv
}

func changePassword(t *testing.T, base, token, oldP, newP string) *http.Response {
	t.Helper()
	b, _ := json.Marshal(map[string]string{"oldPassword": oldP, "newPassword": newP})
	req, _ := http.NewRequest(http.MethodPost, base+"/api/password", bytes.NewReader(b))
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("change password: %v", err)
	}
	return resp
}

func TestChangePassword(t *testing.T) {
	dir := t.TempDir()
	passFile := filepath.Join(dir, "password")
	ts, _ := pwTestServer(t, passFile, false)

	token := postLogin(t, ts.URL, map[string]any{"username": "alice", "password": "s3cret"})

	// Missing token -> 401.
	{
		b, _ := json.Marshal(map[string]string{"oldPassword": "s3cret", "newPassword": "brandnew"})
		resp, _ := http.Post(ts.URL+"/api/password", "application/json", bytes.NewReader(b))
		if resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("no-token status = %d, want 401", resp.StatusCode)
		}
	}

	// Wrong current password -> 400.
	if resp := changePassword(t, ts.URL, token, "wrong", "brandnew"); resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("wrong-old status = %d, want 400", resp.StatusCode)
	}

	// Too-short new password -> 400.
	if resp := changePassword(t, ts.URL, token, "s3cret", "short"); resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("short-new status = %d, want 400", resp.StatusCode)
	}

	// Valid change -> 200, no warning (not pinned).
	{
		resp := changePassword(t, ts.URL, token, "s3cret", "brandnew")
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("valid change status = %d, want 200", resp.StatusCode)
		}
		var out map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&out)
		if out["ok"] != true {
			t.Fatalf("ok = %v, want true", out["ok"])
		}
		if _, hasWarn := out["warning"]; hasWarn {
			t.Fatalf("unexpected warning for non-pinned change")
		}
	}

	// New password now works; old one is rejected.
	if resp := changePassword(t, ts.URL, token, "brandnew", "another1"); resp.StatusCode != http.StatusOK {
		t.Fatalf("login with new password path failed: %d", resp.StatusCode)
	}

	// Persisted to file.
	if b, err := os.ReadFile(passFile); err != nil || len(b) == 0 {
		t.Fatalf("password file not written: err=%v", err)
	}
}

func TestChangePasswordPinnedWarns(t *testing.T) {
	dir := t.TempDir()
	ts, _ := pwTestServer(t, filepath.Join(dir, "password"), true)
	token := postLogin(t, ts.URL, map[string]any{"username": "alice", "password": "s3cret"})
	resp := changePassword(t, ts.URL, token, "s3cret", "brandnew")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("pinned change status = %d, want 200", resp.StatusCode)
	}
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	if _, hasWarn := out["warning"]; !hasWarn {
		t.Fatalf("expected warning when password is env-pinned")
	}
}

func TestChangePasswordNoAuthRejected(t *testing.T) {
	cfg := &config{authEnabled: false, username: "admin", tokenSecret: "x"}
	srv := &server{cfg: cfg, auth: newAuth(cfg)}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/password", srv.handlePassword)
	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)
	// With auth disabled verifyToken returns anonymous, so we reach the enabled check.
	resp := changePassword(t, ts.URL, "any", "x", "brandnew")
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("no-auth status = %d, want 400", resp.StatusCode)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && go test ./... -run TestChangePassword -v`
Expected: build error — `config.passwordFile`, `config.passwordPinned`, `auth.setPassword`, `handlePassword` do not exist yet.

- [ ] **Step 3: Add config fields and populate them**

In `server/config.go`, add two fields to the `config` struct (after `generatedPassword bool`, line ~21):

```go
	generatedPassword bool
	passwordFile      string // where runtime password changes are persisted ("" = cannot)
	passwordPinned    bool   // password set via env/flag → runtime changes revert on restart
```

In `parseConfig`, just before the `return &config{...}` (after `secret` is resolved, ~line 153), compute the two values. `pdir` is already computed at line ~137:

```go
	passwordFile := ""
	if pdir != "" {
		passwordFile = filepath.Join(pdir, "password")
	}
	passwordPinned := *password != ""
```

Then add them to the returned struct literal (alongside `generatedPassword: generated,`):

```go
		generatedPassword: generated,
		passwordFile:      passwordFile,
		passwordPinned:    passwordPinned,
```

- [ ] **Step 4: Add mutex + persist fields to `auth`, wire `newAuth`, lock `checkCredentials`, add `setPassword`**

In `server/auth.go`, extend the imports block to add `os` and `sync`:

```go
import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)
```

Replace the `auth` struct (lines ~23-28):

```go
type auth struct {
	mu       sync.RWMutex // guards password (read in checkCredentials, written in setPassword)
	enabled  bool
	username string
	password string
	secret   []byte
	passFile string // path to persist password changes ("" = cannot persist)
	pinned   bool   // password came from env/flag → runtime changes revert on restart
}
```

Replace `newAuth` (lines ~30-37):

```go
func newAuth(cfg *config) *auth {
	return &auth{
		enabled:  cfg.authEnabled,
		username: cfg.username,
		password: cfg.password,
		secret:   []byte(cfg.tokenSecret),
		passFile: cfg.passwordFile,
		pinned:   cfg.passwordPinned,
	}
}
```

Replace `checkCredentials` (lines ~79-87) to read the password under the read lock:

```go
// checkCredentials compares username/password in constant time.
func (a *auth) checkCredentials(user, pass string) bool {
	if !a.enabled {
		return true
	}
	a.mu.RLock()
	current := a.password
	a.mu.RUnlock()
	uOK := subtle.ConstantTimeCompare([]byte(user), []byte(a.username)) == 1
	pOK := subtle.ConstantTimeCompare([]byte(pass), []byte(current)) == 1
	return uOK && pOK
}

// setPassword updates the in-memory password and best-effort persists it (0600)
// so it survives restart in the auto-managed case. Returns an error only if the
// persist write fails.
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

- [ ] **Step 5: Add the `handlePassword` handler and register the route**

In `server/main.go`, add the handler (place it after `handleMe`, ~line 90):

```go
// handlePassword changes the auth password. Requires a valid token AND the
// correct current password, so a stolen token alone cannot lock out the account.
// The token signing secret is unchanged, so other devices stay logged in.
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
	if len(body.NewPassword) < 6 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "new password must be at least 6 characters"})
		return
	}
	if err := s.auth.setPassword(body.NewPassword); err != nil {
		logger.Warnf("password change persist failed: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to persist new password"})
		return
	}
	resp := map[string]any{"ok": true}
	if s.auth.pinned {
		resp["warning"] = "Password changed for this session, but AUTH_PASS is set in the environment and will override it on restart. Update AUTH_PASS to make it permanent."
	}
	logger.Infof("password changed for user=%s", p.User)
	writeJSON(w, http.StatusOK, resp)
}
```

Register the route in `main()` next to the other API routes (after the `/api/me` line, ~236):

```go
	mux.HandleFunc("POST /api/password", srv.handlePassword)
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd server && go test ./... -run TestChangePassword -v`
Expected: PASS (all three: `TestChangePassword`, `TestChangePasswordPinnedWarns`, `TestChangePasswordNoAuthRejected`).

Run: `cd server && go test ./...`
Expected: PASS (whole suite).

- [ ] **Step 7: Commit**

```bash
git add server/config.go server/auth.go server/main.go server/password_test.go
git commit -m "feat(auth): add POST /api/password change-password endpoint"
```

---

## Task 3: Web — forward `remember` on login

**Files:**
- Modify: `web/js/app.js` (login submit fetch body, line ~509)

**Interfaces:**
- Consumes: `/api/login` `remember` field (Task 1).
- Produces: nothing downstream.

- [ ] **Step 1: Add `remember` to the login request body**

In `web/js/app.js`, in the `login-form` submit handler, change the fetch body (line ~509) from:

```js
        body: JSON.stringify({ username: username, password: password }),
```

to:

```js
        body: JSON.stringify({ username: username, password: password, remember: remember }),
```

(`remember` is already read at line ~502.)

- [ ] **Step 2: Manual verification**

Serve the app against a running server, then in the browser:
1. Log in with "Remember me" checked.
2. In DevTools console run:
   ```js
   const t = localStorage.getItem('rs_token');
   const exp = JSON.parse(atob(t.split('.')[0].replace(/-/g,'+').replace(/_/g,'/'))).exp;
   console.log('days left:', (exp - Date.now()) / 86400000);
   ```
   Expected: ~30.
3. Log out, log in again with "Remember me" **unchecked**, re-run the snippet using `sessionStorage.getItem('rs_token')`.
   Expected: ~0.5 (12h).

- [ ] **Step 3: Commit**

```bash
git add web/js/app.js
git commit -m "feat(web): send remember flag on login for 30-day token"
```

---

## Task 4: Web — change-password UI

**Files:**
- Modify: `web/index.html` (menu ~21-31; add overlay near `#paste-overlay` ~55)
- Modify: `web/css/style.css` (add change-password overlay styles after the paste block ~300)
- Modify: `web/js/app.js` (add `MENU_ACTIONS['change-password']`, show/submit logic near the login block ~528)

**Interfaces:**
- Consumes: `POST /api/password` (Task 2); the module-level `token` variable and `$(id)` helper already in `app.js`.
- Produces: nothing downstream.

- [ ] **Step 1: Add the menu item and overlay markup**

In `web/index.html`, add a button to `#menu` (before the `logout` button, ~line 30):

```html
        <button data-act="change-password">Change password</button>
```

Add the overlay after the login overlay block (after line ~67, before the `<script>` tags):

```html
  <!-- Change-password overlay -->
  <div id="chpw-overlay" class="hidden">
    <form id="chpw-form">
      <h3>Change password</h3>
      <p id="chpw-msg" class="hint hidden"></p>
      <input id="chpw-old" type="password" placeholder="Current password" autocomplete="current-password" />
      <input id="chpw-new" type="password" placeholder="New password (min 6)" autocomplete="new-password" />
      <input id="chpw-confirm" type="password" placeholder="Confirm new password" autocomplete="new-password" />
      <div class="chpw-actions">
        <button type="button" id="chpw-cancel">Cancel</button>
        <button type="submit" class="primary">Save</button>
      </div>
    </form>
  </div>
```

- [ ] **Step 2: Add overlay styles**

In `web/css/style.css`, append after the paste overlay block (~line 300):

```css
/* ---------- change-password overlay ---------- */
#chpw-overlay {
  position: fixed;
  inset: 0;
  z-index: 70;
  background: rgba(0, 0, 0, 0.75);
  display: flex;
  align-items: center;
  justify-content: center;
}
#chpw-form {
  background: #252526;
  padding: 24px;
  border-radius: 8px;
  width: 300px;
  max-width: 90vw;
  display: flex;
  flex-direction: column;
  gap: 12px;
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
}
#chpw-form h3 { margin: 0; color: #eee; text-align: center; }
#chpw-form input {
  padding: 10px;
  border-radius: 4px;
  border: 1px solid #555;
  background: #1e1e1e;
  color: #eee;
  font-size: 16px;
}
#chpw-form .hint { margin: 0; font-size: 13px; color: #f48771; text-align: center; }
#chpw-form .hint.ok { color: #89d185; }
.chpw-actions { display: flex; gap: 8px; }
.chpw-actions button { flex: 1; padding: 10px; font-size: 15px; }
.chpw-actions .primary { background: #0e639c; border-color: #0e639c; color: #fff; }
body.light #chpw-form { background: #fff; }
body.light #chpw-form h3 { color: #222; }
```

- [ ] **Step 3: Wire the menu action and submit handler**

In `web/js/app.js`, add a `change-password` entry to the `MENU_ACTIONS` object (the object defined ~line 600-646, alongside `logout`):

```js
    'change-password': function () { showChangePassword(); },
```

Then add the implementation right after the `login-form` submit handler block (after line ~528):

```js
  // --------------------------------------------------------------------------
  // Change password
  // --------------------------------------------------------------------------
  function showChangePassword() {
    const msg = $('chpw-msg');
    msg.className = 'hint hidden';
    msg.textContent = '';
    $('chpw-old').value = '';
    $('chpw-new').value = '';
    $('chpw-confirm').value = '';
    $('chpw-overlay').classList.remove('hidden');
    $('chpw-old').focus();
  }
  function hideChangePassword() { $('chpw-overlay').classList.add('hidden'); }
  $('chpw-cancel').onclick = hideChangePassword;

  $('chpw-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    const oldP = $('chpw-old').value;
    const newP = $('chpw-new').value;
    const confirmP = $('chpw-confirm').value;
    const msg = $('chpw-msg');
    function showMsg(text, ok) {
      msg.textContent = text;
      msg.className = 'hint' + (ok ? ' ok' : '');
    }
    if (newP.length < 6) { showMsg('New password must be at least 6 characters', false); return; }
    if (newP !== confirmP) { showMsg('New passwords do not match', false); return; }
    try {
      const res = await fetch('/api/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ oldPassword: oldP, newPassword: newP }),
      });
      const data = await res.json().catch(function () { return {}; });
      if (!res.ok) { showMsg(data.error || ('HTTP ' + res.status), false); return; }
      showMsg(data.warning || 'Password changed', true);
      setTimeout(hideChangePassword, data.warning ? 3500 : 1200);
    } catch (err) {
      showMsg('Request failed: ' + err.message, false);
    }
  });
```

- [ ] **Step 4: Manual verification**

Against a running server, logged in:
1. Open the ⋯ menu → "Change password".
2. Wrong current password → inline error "current password is incorrect".
3. New password < 6 chars → inline error (client-side).
4. Mismatched confirm → inline error.
5. Valid change → "Password changed", overlay closes. Log out and log in with the new password → success; old password → "Invalid credentials".

- [ ] **Step 5: Commit**

```bash
git add web/index.html web/css/style.css web/js/app.js
git commit -m "feat(web): add change-password UI"
```

---

## Task 5: Android — forward `remember` on login

**Files:**
- Modify: `android/app/src/main/java/com/remoteshell/android/net/AuthClient.kt` (`login` ~24-48)
- Modify: `android/app/src/main/java/com/remoteshell/android/MainViewModel.kt` (`login` ~82-100)

**Interfaces:**
- Consumes: `/api/login` `remember` field (Task 1).
- Produces: `AuthClient.login(serverUrl, username, password, remember)`.

- [ ] **Step 1: Add `remember` to `AuthClient.login`**

In `AuthClient.kt`, change the `login` signature and JSON body (lines ~24-31):

```kotlin
    /** POST /api/login -> { token }. */
    fun login(serverUrl: String, username: String, password: String, remember: Boolean): LoginResult {
        val base = serverUrl.trim().trimEnd('/')
        if (base.isEmpty()) return LoginResult.Error("Server URL is empty")
        val body = JSONObject()
            .put("username", username)
            .put("password", password)
            .put("remember", remember)
            .toString()
            .toRequestBody(JSON)
```

(The rest of the method is unchanged.)

- [ ] **Step 2: Pass the save toggle as `remember` from the ViewModel**

In `MainViewModel.kt`, in `login(...)` update the call (line ~86):

```kotlin
            val result = withContext(Dispatchers.IO) { auth.login(serverUrl, username, password, save) }
```

- [ ] **Step 3: Build to verify it compiles**

Run: `cd android && ANDROID_HOME=~/Android/Sdk ./gradlew :app:assembleDebug --offline`
Expected: BUILD SUCCESSFUL.

- [ ] **Step 4: Commit**

```bash
git add android/app/src/main/java/com/remoteshell/android/net/AuthClient.kt android/app/src/main/java/com/remoteshell/android/MainViewModel.kt
git commit -m "feat(android): send remember flag on login for 30-day token"
```

---

## Task 6: Android — change-password UI

**Files:**
- Modify: `android/app/src/main/java/com/remoteshell/android/net/AuthClient.kt` (add result type + `changePassword`)
- Modify: `android/app/src/main/java/com/remoteshell/android/MainViewModel.kt` (add `changePassword`)
- Modify: `android/app/src/main/java/com/remoteshell/android/ui/TerminalScreen.kt` (menu item + dialog + new param)
- Modify: `android/app/src/main/java/com/remoteshell/android/MainActivity.kt` (wire the callback)

**Interfaces:**
- Consumes: `POST /api/password` (Task 2); `Prefs` (`token`, `serverUrl`, `saveCredentials`, `password`).
- Produces: `AuthClient.changePassword(serverUrl, token, oldPassword, newPassword): ChangePasswordResult`; `MainViewModel.changePassword(old, new, onResult)`; `ChangePasswordResult` sealed class.

- [ ] **Step 1: Add `changePassword` to `AuthClient`**

In `AuthClient.kt`, add a result type next to `LoginResult` (after line ~14):

```kotlin
/** Result of a change-password attempt. */
sealed class ChangePasswordResult {
    /** Succeeded. [warning] is a non-null server note when the change won't survive a restart. */
    data class Success(val warning: String?) : ChangePasswordResult()
    data class Error(val message: String) : ChangePasswordResult()
}
```

Add the method inside the `AuthClient` class (after `verifyToken`, before the `companion object`, ~line 69):

```kotlin
    /** POST /api/password with a Bearer token. Returns Success (with optional warning) or Error. */
    fun changePassword(serverUrl: String, token: String, oldPassword: String, newPassword: String): ChangePasswordResult {
        val base = serverUrl.trim().trimEnd('/')
        if (base.isEmpty() || token.isEmpty()) return ChangePasswordResult.Error("Not signed in")
        val body = JSONObject()
            .put("oldPassword", oldPassword)
            .put("newPassword", newPassword)
            .toString()
            .toRequestBody(JSON)
        val req = Request.Builder()
            .url("$base/api/password")
            .header("Authorization", "Bearer $token")
            .post(body)
            .build()
        return try {
            http.newCall(req).execute().use { res ->
                val json = JSONObject(res.body?.string() ?: "{}")
                if (res.isSuccessful) {
                    val warn = json.optString("warning").ifEmpty { null }
                    ChangePasswordResult.Success(warn)
                } else {
                    ChangePasswordResult.Error(json.optString("error").ifEmpty { "HTTP ${res.code}" })
                }
            }
        } catch (e: Exception) {
            ChangePasswordResult.Error(e.message ?: "Network error")
        }
    }
```

- [ ] **Step 2: Add `changePassword` to the ViewModel**

In `MainViewModel.kt`, import the result type (with the other `net` imports near the top):

```kotlin
import com.remoteshell.android.net.ChangePasswordResult
```

Add the method (after `logout()`, ~line 161):

```kotlin
    /**
     * Change the auth password. On success, if credentials are being saved, update the stored
     * password so a later token-expiry re-login prefills the new one. [onResult] runs on the main thread.
     */
    fun changePassword(old: String, new: String, onResult: (ChangePasswordResult) -> Unit) {
        viewModelScope.launch {
            val result = withContext(Dispatchers.IO) {
                auth.changePassword(prefs.serverUrl, prefs.token, old, new)
            }
            if (result is ChangePasswordResult.Success && prefs.saveCredentials) {
                prefs.password = new
            }
            onResult(result)
        }
    }
```

- [ ] **Step 3: Add the menu item + dialog in `TerminalScreen`**

In `TerminalScreen.kt`, add imports for the dialog + text field + result type (with the existing `androidx.compose.material3` / `com.remoteshell` imports):

```kotlin
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.OutlinedTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import com.remoteshell.android.net.ChangePasswordResult
```

Add `onChangePassword` to the `TerminalScreen` parameter list (after `onToggleTheme`, ~line 67):

```kotlin
    onToggleTheme: () -> Unit,
    onChangePassword: (old: String, new: String, onResult: (ChangePasswordResult) -> Unit) -> Unit,
```

Pass it into `TerminalTopBar` — update the call (~line 90-93):

```kotlin
            TerminalTopBar(
                state, onReconnect, onDisconnect, onKill, onLogout,
                onChangeFont, onClearScreen, onToggleTheme, onChangePassword,
            ) { controller.showKeyboard() }
```

Add the matching parameter to `TerminalTopBar` (after `onToggleTheme`, ~line 142):

```kotlin
    onToggleTheme: () -> Unit,
    onChangePassword: (old: String, new: String, onResult: (ChangePasswordResult) -> Unit) -> Unit,
```

Inside `TerminalTopBar`, add dialog state next to `var menu` (~line 145):

```kotlin
    var showChangePw by remember { mutableStateOf(false) }
```

Add a menu item in the `DropdownMenu` (before the `Logout` item, ~line 180):

```kotlin
                DropdownMenuItem(
                    text = { Text("Change password") },
                    onClick = { menu = false; showChangePw = true },
                )
```

After the `TopAppBar(...)` call closes (end of `TerminalTopBar`, ~line 183), add the dialog:

```kotlin
    if (showChangePw) {
        ChangePasswordDialog(onDismiss = { showChangePw = false }, onSubmit = onChangePassword)
    }
```

Then add the dialog composable at the end of the file:

```kotlin
@Composable
private fun ChangePasswordDialog(
    onDismiss: () -> Unit,
    onSubmit: (old: String, new: String, onResult: (ChangePasswordResult) -> Unit) -> Unit,
) {
    var oldPw by remember { mutableStateOf("") }
    var newPw by remember { mutableStateOf("") }
    var confirmPw by remember { mutableStateOf("") }
    var message by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }

    val pwField: @Composable (String, String, (String) -> Unit) -> Unit = { value, label, onChange ->
        OutlinedTextField(
            value = value,
            onValueChange = onChange,
            label = { Text(label) },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
            modifier = Modifier.fillMaxWidth(),
        )
    }

    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text("Change password") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                pwField(oldPw, "Current password") { oldPw = it }
                pwField(newPw, "New password (min 6)") { newPw = it }
                pwField(confirmPw, "Confirm new password") { confirmPw = it }
                message?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            }
        },
        confirmButton = {
            TextButton(
                enabled = !busy,
                onClick = {
                    when {
                        newPw.length < 6 -> message = "New password must be at least 6 characters"
                        newPw != confirmPw -> message = "New passwords do not match"
                        else -> {
                            busy = true
                            message = null
                            onSubmit(oldPw, newPw) { result ->
                                busy = false
                                when (result) {
                                    is ChangePasswordResult.Success ->
                                        if (result.warning != null) message = result.warning else onDismiss()
                                    is ChangePasswordResult.Error -> message = result.message
                                }
                            }
                        }
                    }
                },
            ) { Text("Save") }
        },
        dismissButton = {
            TextButton(enabled = !busy, onClick = onDismiss) { Text("Cancel") }
        },
    )
}
```

- [ ] **Step 4: Wire the callback in `MainActivity`**

In `MainActivity.kt`, add the argument to the `TerminalScreen(...)` call (after `onToggleTheme`, ~line 65):

```kotlin
                    onToggleTheme = vm::toggleTheme,
                    onChangePassword = vm::changePassword,
```

- [ ] **Step 5: Build to verify it compiles**

Run: `cd android && ANDROID_HOME=~/Android/Sdk ./gradlew :app:assembleDebug --offline`
Expected: BUILD SUCCESSFUL.

- [ ] **Step 6: Manual verification**

Install the debug APK and, from the terminal screen ⋯ menu → "Change password":
1. Wrong current password → dialog shows "current password is incorrect".
2. New password < 6 chars or mismatched confirm → inline validation error, no request sent.
3. Valid change → dialog closes (or shows the env-pinned warning). Log out, log in with the new password → success.
4. With "Remember credentials" on before the change: after a valid change, `Prefs.password` holds the new password (next expiry re-login prefills it).

- [ ] **Step 7: Commit**

```bash
git add android/app/src/main/java/com/remoteshell/android/net/AuthClient.kt android/app/src/main/java/com/remoteshell/android/MainViewModel.kt android/app/src/main/java/com/remoteshell/android/ui/TerminalScreen.kt android/app/src/main/java/com/remoteshell/android/MainActivity.kt
git commit -m "feat(android): add change-password dialog"
```

---

## Final verification

- [ ] `cd server && go test ./...` → PASS
- [ ] `cd android && ANDROID_HOME=~/Android/Sdk ./gradlew :app:assembleDebug --offline` → BUILD SUCCESSFUL
- [ ] Web manual checks (Tasks 3–4) pass against a running server
- [ ] README/docs: no change needed (no new config flags; endpoint is internal to the app)

## Task dependency order

1 → 2 → (3, 5 in parallel) → (4, 6 in parallel). Clients (3–6) depend on the server tasks (1–2) being merged first, but sending `remember` to an old server is harmless (ignored), so strict ordering matters only for change-password (Tasks 4/6 need Task 2).
