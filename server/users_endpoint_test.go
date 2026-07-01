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
