package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strings"
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
		if err := store.seedAdmin(cfg.username, cfg.password); err != nil {
			logger.Errorf("seed admin failed: %v", err)
		} else {
			logger.Infof("seeded initial admin user=%s", cfg.username)
		}
	}
	return &auth{enabled: cfg.authEnabled, secret: []byte(cfg.tokenSecret), store: store}
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

// extractToken reads a Bearer header, falling back to the ?token= query param.
func extractToken(r *http.Request) string {
	if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
		return h[len("Bearer "):]
	}
	return r.URL.Query().Get("token")
}
