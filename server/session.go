package main

import (
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"regexp"
	"sort"
	"strings"
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

// sanitizeTitle bounds a user-supplied tab title: trim, drop control chars,
// cap length. It is only ever rendered via textContent client-side, so this is
// about sanity (and key safety is handled separately by sanitize on the sid).
func sanitizeTitle(s string) string {
	s = strings.TrimSpace(s)
	s = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, s)
	if utf8.RuneCountInString(s) > 32 {
		r := []rune(s)
		s = string(r[:32])
	}
	if s == "" {
		s = "shell"
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
			if msg == nil {
				c.close() // sentinel: a final frame was flushed, tear down now
				return
			}
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

// closeWith enqueues one final message, then closes the connection once that
// message has been flushed (a nil sentinel through the same ordered out channel).
// This guarantees the peer actually receives the frame before the socket drops —
// unlike send()+close(), where close() could win the writeLoop's select and drop
// the queued frame. Used to tell a superseded subscriber why it is going away.
func (c *conn) closeWith(msg []byte) {
	select {
	case c.out <- msg:
	case <-c.closed:
		return
	default:
		c.close() // queue full / slow client: drop it rather than block
		return
	}
	select {
	case c.out <- nil:
	case <-c.closed:
	default:
		c.close()
	}
}

// ---------------------------------------------------------------------------
// session — one persistent PTY with a ring buffer and at most one subscriber.
// ---------------------------------------------------------------------------

type session struct {
	key       string
	user      string
	sid       string
	title     string
	createdAt time.Time
	mgr       *manager

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

func (m *manager) newSession(key, user, sid, title string, cols, rows uint16) (*session, error) {
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
		user:       user,
		sid:        sid,
		title:      sanitizeTitle(title),
		createdAt:  time.Now(),
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

// attach makes c the sole subscriber and replays the scrollback to it. "Last
// attach wins": if another connection (a second device/tab on the same session)
// was subscribed, it is told via a "superseded" event and its socket is then
// closed, so it steps aside instead of auto-reconnecting and ping-ponging with
// this one over the single subscriber slot.
func (s *session) attach(c *conn, cols, rows uint16) {
	s.mu.Lock()
	prev := s.sub
	s.sub = c
	if cols >= 2 && rows >= 2 {
		s.cols, s.rows = cols, rows
		_ = pty.Setsize(s.ptmx, &pty.Winsize{Cols: cols, Rows: rows})
	}
	// Enqueue the snapshot under the lock so it lands before any live data that
	// a concurrent feed() might push to the new subscriber. Strip terminal query
	// sequences first: a stale query replayed from scrollback would make xterm
	// auto-reply into the live shell as garbage (see stripQueries).
	if snap := stripQueries(s.ring.Snapshot()); len(snap) > 0 {
		c.send(dataFrame(snap))
	}
	s.lastActive = time.Now()
	s.mu.Unlock()

	if prev != nil && prev != c {
		prev.closeWith(eventFrame(map[string]any{"event": "superseded"}))
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
// title is only used when creating; existing sessions keep their title.
// The bool reports whether it was newly created.
func (m *manager) getOrCreate(user, sid, title string, cols, rows uint16) (*session, bool, error) {
	key := sessionKey(user, sid)
	m.mu.Lock()
	defer m.mu.Unlock()
	if s, ok := m.sessions[key]; ok {
		return s, false, nil
	}
	if m.cfg.maxSessions > 0 && len(m.sessions) >= m.cfg.maxSessions {
		return nil, false, errMaxSessions
	}
	s, err := m.newSession(key, user, sid, title, cols, rows)
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

// sessionInfo is the per-session metadata returned by GET /api/sessions, so any
// device logged in as the same user can render the full tab list.
type sessionInfo struct {
	ID         string `json:"id"` // the sid
	Title      string `json:"title"`
	CreatedAt  int64  `json:"createdAt"`  // unix millis
	LastActive int64  `json:"lastActive"` // unix millis
	Attached   bool   `json:"attached"`   // a client is currently subscribed
	Cols       int    `json:"cols"`
	Rows       int    `json:"rows"`
}

// list returns the user's sessions, oldest first (stable tab order). Ownership
// is matched on the stored user field, not a key prefix, to avoid one user's id
// being a prefix of another's.
func (m *manager) list(user string) []sessionInfo {
	m.mu.Lock()
	var sessions []*session
	for _, s := range m.sessions {
		if s.user == user {
			sessions = append(sessions, s)
		}
	}
	m.mu.Unlock()

	out := make([]sessionInfo, 0, len(sessions))
	for _, s := range sessions {
		s.mu.Lock()
		out = append(out, sessionInfo{
			ID:         s.sid,
			Title:      s.title,
			CreatedAt:  s.createdAt.UnixMilli(),
			LastActive: s.lastActive.UnixMilli(),
			Attached:   s.sub != nil,
			Cols:       int(s.cols),
			Rows:       int(s.rows),
		})
		s.mu.Unlock()
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt < out[j].CreatedAt })
	return out
}

// killSession terminates one of the user's sessions by sid. Returns false if no
// matching session exists (so the caller can report 404).
func (m *manager) killSession(user, sid string) bool {
	key := sessionKey(user, sid)
	m.mu.Lock()
	s, ok := m.sessions[key]
	m.mu.Unlock()
	if !ok || s.user != user {
		return false
	}
	s.kill()
	return true
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

// ---------------------------------------------------------------------------
// stripQueries removes terminal *query* sequences from replayed scrollback:
// OSC color queries (e.g. "ESC ] 11 ; ? ST", which asks for the background
// color) and CSI device reports (DSR "...n" / DA "...c"). During live output a
// query is answered in real time by the program that emitted it, but the same
// bytes sitting in the ring buffer have no program waiting when a client
// re-attaches — xterm would auto-reply and the reply ("11;rgb:1e1e/1e1e/1e1e",
// "0n", "?1;2c", …) lands on the shell's command line as garbage. The queries
// draw nothing, so dropping them from the replay is visually lossless.
// ---------------------------------------------------------------------------

func stripQueries(b []byte) []byte {
	out := make([]byte, 0, len(b))
	i := 0
	for i < len(b) {
		if b[i] == 0x1b && i+1 < len(b) {
			switch b[i+1] {
			case ']': // OSC ... (BEL | ST)
				end, drop := scanOSC(b, i+2)
				if !drop {
					out = append(out, b[i:end]...)
				}
				i = end
				continue
			case '[': // CSI params... final
				end, final := scanCSI(b, i+2)
				if final != 'n' && final != 'c' { // DSR / DA are report requests
					out = append(out, b[i:end]...)
				}
				i = end
				continue
			}
		}
		out = append(out, b[i])
		i++
	}
	return out
}

// scanOSC returns the index just past an OSC sequence beginning at start (the
// byte after "ESC ]") and whether it is a color query that should be dropped.
// Only the "?" query form of OSC 4/5/10–19 is dropped; the set form (e.g.
// "ESC ] 11 ; rgb:… ST") and unrelated OSCs (titles, hyperlinks) are kept.
func scanOSC(b []byte, start int) (end int, drop bool) {
	ps := -1
	for d := start; d < len(b) && b[d] >= '0' && b[d] <= '9'; d++ {
		if ps < 0 {
			ps = 0
		}
		ps = ps*10 + int(b[d]-'0')
	}
	colorQuery := ps == 4 || ps == 5 || (ps >= 10 && ps <= 19)
	var last byte
	for i := start; i < len(b); i++ {
		switch {
		case b[i] == 0x07: // BEL terminator
			return i + 1, colorQuery && last == '?'
		case b[i] == 0x1b && i+1 < len(b) && b[i+1] == '\\': // ST = ESC \
			return i + 2, colorQuery && last == '?'
		}
		last = b[i]
	}
	return len(b), colorQuery && last == '?' // unterminated (ring boundary)
}

// scanCSI returns the index just past a CSI sequence beginning at start (the
// byte after "ESC [") and its final byte (0 if the sequence is truncated).
func scanCSI(b []byte, start int) (end int, final byte) {
	for i := start; i < len(b); i++ {
		if b[i] >= 0x40 && b[i] <= 0x7e { // final byte
			return i + 1, b[i]
		}
	}
	return len(b), 0
}
