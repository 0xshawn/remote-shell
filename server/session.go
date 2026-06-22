package main

import (
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"regexp"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/creack/pty"
	"github.com/gorilla/websocket"
)

var errMaxSessions = errors.New("maximum number of sessions reached")

var unsafeKeyChars = regexp.MustCompile(`[^A-Za-z0-9_-]`)

// sanitize keeps ids to a safe, bounded character set (matches the old server).
func sanitize(s string) string {
	s = unsafeKeyChars.ReplaceAllString(s, "")
	if len(s) > 64 {
		s = s[:64]
	}
	return s
}

func sessionKey(user, sid string) string {
	u := sanitize(user)
	if u == "" {
		u = "anonymous"
	}
	return "rs_" + u + "_" + sanitize(sid)
}

// ---------------------------------------------------------------------------
// wire helpers — frames are UTF-8 text with a 1-byte op prefix:
//   '0'<data> = terminal I/O,  '1'<json> = control/event
// ---------------------------------------------------------------------------

func framed(op byte, body []byte) []byte {
	out := make([]byte, len(body)+1)
	out[0] = op
	copy(out[1:], body)
	return out
}

func dataFrame(b []byte) []byte { return framed('0', b) }

func eventFrame(v any) []byte {
	b, _ := json.Marshal(v)
	return framed('1', b)
}

// ---------------------------------------------------------------------------
// conn — one WebSocket subscriber. A single writer goroutine owns all writes
// (gorilla requires it); send() is a non-blocking enqueue.
// ---------------------------------------------------------------------------

type conn struct {
	ws     *websocket.Conn
	out    chan []byte
	closed chan struct{}
	once   sync.Once
}

func newConn(ws *websocket.Conn) *conn {
	c := &conn{ws: ws, out: make(chan []byte, 256), closed: make(chan struct{})}
	go c.writeLoop()
	return c
}

func (c *conn) writeLoop() {
	ping := time.NewTicker(30 * time.Second)
	defer ping.Stop()
	for {
		select {
		case msg := <-c.out:
			_ = c.ws.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := c.ws.WriteMessage(websocket.TextMessage, msg); err != nil {
				c.close()
				return
			}
		case <-ping.C:
			_ = c.ws.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := c.ws.WriteMessage(websocket.PingMessage, nil); err != nil {
				c.close()
				return
			}
		case <-c.closed:
			return
		}
	}
}

// send enqueues msg; if the client can't keep up the connection is dropped (it
// will reconnect and resync from the ring buffer).
func (c *conn) send(msg []byte) {
	select {
	case c.out <- msg:
	case <-c.closed:
	default:
		c.close()
	}
}

func (c *conn) close() {
	c.once.Do(func() {
		close(c.closed)
		_ = c.ws.Close()
	})
}

// ---------------------------------------------------------------------------
// session — one persistent PTY with a ring buffer and at most one subscriber.
// ---------------------------------------------------------------------------

type session struct {
	key string
	mgr *manager

	ptmx *os.File
	cmd  *exec.Cmd

	mu         sync.Mutex
	ring       *ringBuffer
	sub        *conn
	carry      []byte // trailing incomplete UTF-8 bytes held back from the live stream
	cols       uint16
	rows       uint16
	lastActive time.Time
	ended      bool
}

func (m *manager) newSession(key string, cols, rows uint16) (*session, error) {
	name, args := m.cfg.commandFor()
	cmd := exec.Command(name, args...)
	cmd.Env = append(os.Environ(), "TERM=xterm-256color")
	if os.Getenv("LANG") == "" {
		// C.UTF-8 is built into glibc, so wide chars render even on slim images.
		cmd.Env = append(cmd.Env, "LANG=C.UTF-8")
	}
	if m.cfg.sshHost == "" {
		cmd.Dir = m.cfg.cwd // only meaningful for a local shell
	}

	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: cols, Rows: rows})
	if err != nil {
		return nil, err
	}

	s := &session{
		key:        key,
		mgr:        m,
		ptmx:       ptmx,
		cmd:        cmd,
		ring:       newRingBuffer(m.cfg.ringBytes),
		cols:       cols,
		rows:       rows,
		lastActive: time.Now(),
	}
	go s.readLoop()
	return s, nil
}

// readLoop pumps PTY output into the ring buffer (always) and the live
// subscriber (if any). It keeps running while detached — that is the persistence.
func (s *session) readLoop() {
	buf := make([]byte, 32*1024)
	for {
		n, err := s.ptmx.Read(buf)
		if n > 0 {
			s.feed(buf[:n])
		}
		if err != nil {
			break // PTY closed: shell exited or ssh dropped
		}
	}
	s.onExit()
}

func (s *session) feed(chunk []byte) {
	s.mu.Lock()
	data := chunk
	if len(s.carry) > 0 {
		data = append(s.carry, chunk...)
		s.carry = nil
	}
	safe, rest := splitUTF8(data)
	if len(rest) > 0 {
		s.carry = append([]byte(nil), rest...)
	}
	if len(safe) == 0 {
		s.mu.Unlock()
		return
	}
	s.ring.Write(safe)
	s.lastActive = time.Now()
	sub := s.sub
	s.mu.Unlock()

	if sub != nil {
		sub.send(dataFrame(safe))
	}
}

func (s *session) onExit() {
	s.mu.Lock()
	s.ended = true
	sub := s.sub
	s.mu.Unlock()
	if sub != nil {
		sub.send(eventFrame(map[string]any{"event": "ended"}))
	}
	s.mgr.remove(s.key)
}

// attach makes c the sole subscriber and replays the scrollback to it.
// "Last tab wins": any previous subscriber is dropped.
func (s *session) attach(c *conn, cols, rows uint16) {
	s.mu.Lock()
	prev := s.sub
	s.sub = c
	if cols >= 2 && rows >= 2 {
		s.cols, s.rows = cols, rows
		_ = pty.Setsize(s.ptmx, &pty.Winsize{Cols: cols, Rows: rows})
	}
	// Enqueue the snapshot under the lock so it lands before any live data that
	// a concurrent feed() might push to the new subscriber.
	if snap := s.ring.Snapshot(); len(snap) > 0 {
		c.send(dataFrame(snap))
	}
	s.lastActive = time.Now()
	s.mu.Unlock()

	if prev != nil && prev != c {
		prev.close()
	}
}

// detach drops c as the subscriber but leaves the PTY running (persistence).
func (s *session) detach(c *conn) {
	s.mu.Lock()
	if s.sub == c {
		s.sub = nil
	}
	s.lastActive = time.Now()
	s.mu.Unlock()
}

func (s *session) write(p []byte) {
	_, _ = s.ptmx.Write(p) // s.ptmx is immutable after start
}

func (s *session) resize(cols, rows uint16) {
	if cols < 2 || rows < 2 {
		return
	}
	s.mu.Lock()
	s.cols, s.rows = cols, rows
	s.mu.Unlock()
	_ = pty.Setsize(s.ptmx, &pty.Winsize{Cols: cols, Rows: rows})
}

// kill destroys the persistent session entirely.
func (s *session) kill() {
	s.mu.Lock()
	sub := s.sub
	s.sub = nil
	s.ended = true
	s.mu.Unlock()
	if sub != nil {
		sub.send(eventFrame(map[string]any{"event": "ended"}))
	}
	if s.cmd.Process != nil {
		// Kill the whole process group (ssh/shell + children). The child is a
		// session leader (pty sets Setsid), so -pid targets the group.
		_ = syscall.Kill(-s.cmd.Process.Pid, syscall.SIGKILL)
	}
	_ = s.ptmx.Close()
	s.mgr.remove(s.key)
}

// ---------------------------------------------------------------------------
// manager — owns the session map and lifecycle policy.
// ---------------------------------------------------------------------------

type manager struct {
	cfg      *config
	mu       sync.Mutex
	sessions map[string]*session
}

func newManager(cfg *config) *manager {
	return &manager{cfg: cfg, sessions: map[string]*session{}}
}

// getOrCreate returns the session for (user, sid), creating it if absent.
// The bool reports whether it was newly created.
func (m *manager) getOrCreate(user, sid string, cols, rows uint16) (*session, bool, error) {
	key := sessionKey(user, sid)
	m.mu.Lock()
	defer m.mu.Unlock()
	if s, ok := m.sessions[key]; ok {
		return s, false, nil
	}
	if m.cfg.maxSessions > 0 && len(m.sessions) >= m.cfg.maxSessions {
		return nil, false, errMaxSessions
	}
	s, err := m.newSession(key, cols, rows)
	if err != nil {
		return nil, false, err
	}
	m.sessions[key] = s
	return s, true, nil
}

func (m *manager) remove(key string) {
	m.mu.Lock()
	delete(m.sessions, key)
	m.mu.Unlock()
}

// reap kills sessions that have been detached and idle past the timeout.
func (m *manager) reap() {
	if m.cfg.timeoutMin <= 0 {
		return
	}
	cutoff := time.Now().Add(-time.Duration(m.cfg.timeoutMin) * time.Minute)
	m.mu.Lock()
	var idle []*session
	for _, s := range m.sessions {
		s.mu.Lock()
		if s.sub == nil && s.lastActive.Before(cutoff) {
			idle = append(idle, s)
		}
		s.mu.Unlock()
	}
	m.mu.Unlock()
	for _, s := range idle {
		s.kill()
	}
}

// ---------------------------------------------------------------------------
// splitUTF8 returns the largest prefix of b ending on a UTF-8 boundary, holding
// back only a trailing *incomplete* multibyte sequence (at most 3 bytes). This
// keeps every text frame valid UTF-8 so multibyte chars (e.g. CJK) split across
// PTY reads aren't corrupted. Invalid bytes are flushed, never carried.
// ---------------------------------------------------------------------------

func splitUTF8(b []byte) (safe, rest []byte) {
	if len(b) == 0 {
		return b, nil
	}
	for i := len(b) - 1; i >= 0 && i >= len(b)-utf8.UTFMax; i-- {
		c := b[i]
		if c < 0x80 {
			break // ASCII byte: the tail is complete
		}
		if c >= 0xC0 { // start byte of a multibyte sequence
			if len(b)-i < seqLen(c) {
				return b[:i], b[i:] // incomplete tail; hold it back
			}
			break // complete (or invalid-but-finished) sequence
		}
		// continuation byte (0x80..0xBF): keep scanning back for the start
	}
	return b, nil
}

func seqLen(lead byte) int {
	switch {
	case lead >= 0xF0:
		return 4
	case lead >= 0xE0:
		return 3
	case lead >= 0xC0:
		return 2
	default:
		return 1
	}
}
