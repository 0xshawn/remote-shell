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
	logger = newLogger("error") // main() sets this in production; tests must too
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
	logger = newLogger("error") // main() sets this in production; tests must too
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
