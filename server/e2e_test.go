package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// TestMultiDeviceTakeoverE2E drives the whole multi-device login lifecycle through
// the real HTTP + WebSocket stack with auth enabled: log in for a token, open a
// session as "device A", confirm it appears in the sessions API, attach a second
// "device B" to the SAME session, and verify the handoff is a clean one-shot
// takeover in each direction rather than the endless reconnect fight it used to be:
//
//	A attaches             -> A is live
//	B attaches             -> A is superseded and dropped, B is live
//	A reattaches (reclaim)  -> B is superseded and dropped, A is live
func TestMultiDeviceTakeoverE2E(t *testing.T) {
	logger = newLogger("error")
	cfg := &config{
		shell:       "/bin/cat", // echoes its input back on the PTY; stays alive
		cwd:         "/",
		authEnabled: true,
		username:    "alice",
		password:    "s3cret",
		tokenSecret: "e2e-secret",
		ringBytes:   4096,
	}
	srv := &server{
		cfg: cfg, auth: newAuth(cfg), mgr: newManager(cfg),
		upgrader: websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }},
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/login", srv.handleLogin)
	mux.HandleFunc("/api/me", srv.handleMe)
	mux.HandleFunc("GET /api/sessions", srv.handleSessions)
	mux.HandleFunc("DELETE /api/sessions", srv.handleSessionDelete)
	mux.HandleFunc("/ws", srv.handleWS)
	ts := httptest.NewServer(mux)
	defer ts.Close()

	// Real login: wrong creds are rejected, right creds yield a token.
	if _, err := login(t, ts.URL, "alice", "wrong"); err == nil {
		t.Fatalf("login with wrong password should fail")
	}
	token, err := login(t, ts.URL, "alice", "s3cret")
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	if u := me(t, ts.URL, token); u != "alice" {
		t.Fatalf("/api/me user = %q, want alice", u)
	}

	// Device A opens a session; it becomes visible (and attached) via the API.
	a := dialWS(t, ts.URL, token, "work")
	defer a.Close()
	if ev := readEvent(t, a); ev != "session" {
		t.Fatalf("A first event = %q, want session", ev)
	}
	waitAttached(t, ts.URL, token, "work")

	// Device B attaches to the SAME session: A is superseded and dropped.
	b := dialWS(t, ts.URL, token, "work")
	defer b.Close()
	if ev := readEvent(t, b); ev != "session" {
		t.Fatalf("B first event = %q, want session", ev)
	}
	if ev := readEvent(t, a); ev != "superseded" {
		t.Fatalf("A next event = %q, want superseded", ev)
	}
	expectClosed(t, a)

	// B now holds the session end-to-end: its input is echoed back to it.
	mustWrite(t, b, "0ping-from-b\n")
	expectData(t, b, "ping-from-b")

	// Reclaim: A reattaches and the takeover flips — B is superseded and dropped.
	a2 := dialWS(t, ts.URL, token, "work")
	defer a2.Close()
	if ev := readEvent(t, a2); ev != "session" {
		t.Fatalf("A2 first event = %q, want session", ev)
	}
	if ev := readEvent(t, b); ev != "superseded" {
		t.Fatalf("B next event = %q, want superseded", ev)
	}
	expectClosed(t, b)

	// A is live again.
	mustWrite(t, a2, "0ping-from-a\n")
	expectData(t, a2, "ping-from-a")
}

func login(t *testing.T, base, user, pass string) (string, error) {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"username": user, "password": pass})
	resp, err := http.Post(base+"/api/login", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("post login: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("login status %d", resp.StatusCode)
	}
	var out struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("decode token: %v", err)
	}
	return out.Token, nil
}

func me(t *testing.T, base, token string) string {
	t.Helper()
	req, _ := http.NewRequest(http.MethodGet, base+"/api/me", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("me: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("me status = %d", resp.StatusCode)
	}
	var out struct {
		User string `json:"user"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return out.User
}

func dialWS(t *testing.T, base, token, session string) *websocket.Conn {
	t.Helper()
	wsURL := "ws" + strings.TrimPrefix(base, "http") + "/ws?token=" + url.QueryEscape(token) +
		"&session=" + session + "&cols=80&rows=24"
	c, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial %s: %v", session, err)
	}
	return c
}

// waitAttached polls the authenticated sessions API until the session shows up
// with a live subscriber (attach() runs just after the 'session' event is sent,
// so a single read could observe it a hair early).
func waitAttached(t *testing.T, base, token, id string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		for _, s := range listSessions(t, base, token) {
			if s.ID == id && s.Attached {
				return
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("session %q never showed up as attached", id)
}

func listSessions(t *testing.T, base, token string) []sessionInfo {
	t.Helper()
	req, _ := http.NewRequest(http.MethodGet, base+"/api/sessions", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("list sessions: %v", err)
	}
	defer resp.Body.Close()
	var out struct {
		Sessions []sessionInfo `json:"sessions"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("decode sessions: %v", err)
	}
	return out.Sessions
}

func mustWrite(t *testing.T, c *websocket.Conn, frame string) {
	t.Helper()
	if err := c.WriteMessage(websocket.TextMessage, []byte(frame)); err != nil {
		t.Fatalf("write %q: %v", frame, err)
	}
}

// expectData reads '0'-op terminal frames until their concatenation contains want.
func expectData(t *testing.T, c *websocket.Conn, want string) {
	t.Helper()
	_ = c.SetReadDeadline(time.Now().Add(2 * time.Second))
	var acc strings.Builder
	for {
		_, data, err := c.ReadMessage()
		if err != nil {
			t.Fatalf("want data %q, got error after %q: %v", want, acc.String(), err)
		}
		if len(data) == 0 || data[0] != '0' {
			continue
		}
		acc.Write(data[1:])
		if strings.Contains(acc.String(), want) {
			return
		}
	}
}

func expectClosed(t *testing.T, c *websocket.Conn) {
	t.Helper()
	_ = c.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, _, err := c.ReadMessage(); err == nil {
		t.Fatalf("expected the server to close this socket after takeover")
	}
}
