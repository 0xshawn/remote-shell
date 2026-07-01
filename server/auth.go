package main

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

const (
	tokenTTL         = 12 * time.Hour
	rememberTokenTTL = 30 * 24 * time.Hour
)

// tokenPayload is the body of our minimal HMAC-signed token (a tiny JWT-like
// format, no external dependency). Field order is fixed so the JSON is stable.
type tokenPayload struct {
	User string `json:"user"`
	Exp  int64  `json:"exp"` // unix millis
}

type auth struct {
	mu       sync.RWMutex // guards password (read in checkCredentials, written in setPassword)
	enabled  bool
	username string
	password string
	secret   []byte
	passFile string // path to persist password changes ("" = cannot persist)
	pinned   bool   // password came from env/flag → runtime changes revert on restart
}

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

func (a *auth) sign(body []byte) string {
	mac := hmac.New(sha256.New, a.secret)
	mac.Write(body)
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// issueToken returns "<base64url(payload)>.<base64url(hmac)>" valid for ttl.
func (a *auth) issueToken(user string, ttl time.Duration) string {
	body, _ := json.Marshal(tokenPayload{User: user, Exp: time.Now().Add(ttl).UnixMilli()})
	b64 := base64.RawURLEncoding.EncodeToString(body)
	return b64 + "." + a.sign(body)
}

// verifyToken returns the payload for a valid, unexpired token, else nil.
// With auth disabled every request is the anonymous user.
func (a *auth) verifyToken(token string) *tokenPayload {
	if !a.enabled {
		return &tokenPayload{User: "anonymous"}
	}
	b64, sig, ok := strings.Cut(token, ".")
	if !ok {
		return nil
	}
	body, err := base64.RawURLEncoding.DecodeString(b64)
	if err != nil {
		return nil
	}
	if !hmac.Equal([]byte(a.sign(body)), []byte(sig)) {
		return nil
	}
	var p tokenPayload
	if json.Unmarshal(body, &p) != nil {
		return nil
	}
	if p.Exp == 0 || time.Now().UnixMilli() > p.Exp {
		return nil
	}
	return &p
}

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

// extractToken reads a Bearer header, falling back to the ?token= query param.
func extractToken(r *http.Request) string {
	if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
		return h[len("Bearer "):]
	}
	return r.URL.Query().Get("token")
}
