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

// TestSupersedeOnSecondAttach verifies the multi-device takeover: when a second
// connection attaches to the same (user, session), the first one is sent a
// "superseded" event and then closed, so it can step aside instead of
// auto-reconnecting and ping-ponging for the single subscriber slot.
func TestSupersedeOnSecondAttach(t *testing.T) {
	logger = newLogger("error")
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
	mux.HandleFunc("/ws", srv.handleWS)
	ts := httptest.NewServer(mux)
	defer ts.Close()

	wsURL := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws?token=x&session=abc&cols=80&rows=24"

	c1, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial c1: %v", err)
	}
	defer c1.Close()
	if ev := readEvent(t, c1); ev != "session" {
		t.Fatalf("c1 first event = %q, want session", ev)
	}

	// Second device attaches to the same session: c1 must be told it was superseded.
	c2, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial c2: %v", err)
	}
	defer c2.Close()
	if ev := readEvent(t, c2); ev != "session" {
		t.Fatalf("c2 first event = %q, want session", ev)
	}

	if ev := readEvent(t, c1); ev != "superseded" {
		t.Fatalf("c1 next event = %q, want superseded", ev)
	}

	// After the superseded frame the server closes c1's socket.
	_ = c1.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, _, err := c1.ReadMessage(); err == nil {
		t.Fatalf("expected c1 socket to close after superseded")
	}
}

// readEvent reads the next '1'-op control frame and returns its event name.
func readEvent(t *testing.T, c *websocket.Conn) string {
	t.Helper()
	_ = c.SetReadDeadline(time.Now().Add(2 * time.Second))
	for {
		_, data, err := c.ReadMessage()
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		if len(data) == 0 || data[0] != '1' {
			continue // skip terminal I/O frames
		}
		var m struct {
			Event string `json:"event"`
		}
		if json.Unmarshal(data[1:], &m) != nil {
			continue
		}
		return m.Event
	}
}
