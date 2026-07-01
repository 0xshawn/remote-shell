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
