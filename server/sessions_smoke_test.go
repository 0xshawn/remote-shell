package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestSessionsAPISmoke(t *testing.T) {
	cfg := &config{
		shell:       "/bin/cat", // stays alive on a PTY without exiting
		cwd:         "/",
		authEnabled: false,
		tokenSecret: "test",
		ringBytes:   4096,
	}
	srv := &server{
		cfg: cfg, auth: newAuth(cfg), mgr: newManager(cfg),
		upgrader: websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }},
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/sessions", srv.handleSessions)
	mux.HandleFunc("DELETE /api/sessions", srv.handleSessionDelete)
	mux.HandleFunc("/ws", srv.handleWS)
	ts := httptest.NewServer(mux)
	defer ts.Close()

	if got := getSessions(t, ts.URL); len(got) != 0 {
		t.Fatalf("expected 0 sessions initially, got %d", len(got))
	}

	wsURL := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws?token=x&session=abc&title=My+Shell&cols=80&rows=24"
	c, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer c.Close()
	_ = c.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, _, err := c.ReadMessage(); err != nil { // the 'session' event
		t.Fatalf("read session event: %v", err)
	}

	got := getSessions(t, ts.URL)
	if len(got) != 1 || got[0].ID != "abc" || got[0].Title != "My Shell" || !got[0].Attached {
		t.Fatalf("unexpected sessions: %+v", got)
	}

	req, _ := http.NewRequest(http.MethodDelete, ts.URL+"/api/sessions?id=abc", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("delete: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("delete status = %d", resp.StatusCode)
	}

	time.Sleep(150 * time.Millisecond) // let kill() propagate through remove()
	if got := getSessions(t, ts.URL); len(got) != 0 {
		t.Fatalf("expected 0 sessions after delete, got %d", len(got))
	}
}

func getSessions(t *testing.T, base string) []sessionInfo {
	t.Helper()
	resp, err := http.Get(base + "/api/sessions")
	if err != nil {
		t.Fatalf("get sessions: %v", err)
	}
	defer resp.Body.Close()
	var out struct {
		Sessions []sessionInfo `json:"sessions"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return out.Sessions
}
