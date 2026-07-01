package main

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
)

var logger *leveledLogger

type server struct {
	cfg      *config
	auth     *auth
	mgr      *manager
	upgrader websocket.Upgrader
}

func atoiOr(s string, def int) int {
	if n, err := strconv.Atoi(s); err == nil {
		return n
	}
	return def
}

func u16(v int, def int) uint16 {
	if v <= 0 {
		v = def
	}
	if v < 2 {
		v = 2
	}
	if v > 65535 {
		v = 65535
	}
	return uint16(v)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// noCache makes browsers revalidate static assets on every load so a redeploy is
// picked up immediately instead of serving a stale cached app.js/index.html.
// FileServer still sets Last-Modified, so unchanged files revalidate cheaply (304).
func noCache(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache")
		h.ServeHTTP(w, r)
	})
}

func (s *server) handleLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
		Remember bool   `json:"remember"`
	}
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 64*1024)).Decode(&body)
	if !s.auth.checkCredentials(body.Username, body.Password) {
		logger.Warnf("failed login attempt user=%q", body.Username)
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid credentials"})
		return
	}
	user := body.Username
	if !s.auth.enabled {
		user = "anonymous"
	}
	ttl := tokenTTL
	if body.Remember {
		ttl = rememberTokenTTL
	}
	writeJSON(w, http.StatusOK, map[string]string{"token": s.auth.issueToken(user, ttl)})
}

func (s *server) handleMe(w http.ResponseWriter, r *http.Request) {
	p := s.auth.verifyToken(extractToken(r))
	if p == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"user": p.User, "authEnabled": s.auth.enabled, "admin": s.auth.isAdmin(p.User)})
}

// handlePassword changes the caller's password. Requires a valid token AND the
// correct current password, so a stolen token alone cannot lock out the account.
func (s *server) handlePassword(w http.ResponseWriter, r *http.Request) {
	p := s.auth.verifyToken(extractToken(r))
	if p == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	if !s.auth.enabled {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "auth is disabled"})
		return
	}
	var body struct {
		OldPassword string `json:"oldPassword"`
		NewPassword string `json:"newPassword"`
	}
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 64*1024)).Decode(&body)
	if !s.auth.checkCredentials(p.User, body.OldPassword) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "current password is incorrect"})
		return
	}
	if len(body.NewPassword) < minPasswordLen {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "new password must be at least 6 characters"})
		return
	}
	if err := s.auth.setPassword(p.User, body.NewPassword); err != nil {
		logger.Warnf("password change failed for %s: %v", p.User, err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to change password"})
		return
	}
	logger.Infof("password changed for user=%s", p.User)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// requireAdmin verifies the token and that the caller is an admin. On failure it
// writes 401/403 and returns nil.
func (s *server) requireAdmin(w http.ResponseWriter, r *http.Request) *tokenPayload {
	p := s.auth.verifyToken(extractToken(r))
	if p == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return nil
	}
	if !s.auth.isAdmin(p.User) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "admin required"})
		return nil
	}
	return p
}

// handleUsers lists users (GET) or creates one (POST). Admin only.
func (s *server) handleUsers(w http.ResponseWriter, r *http.Request) {
	if s.requireAdmin(w, r) == nil {
		return
	}
	if r.Method == http.MethodGet {
		writeJSON(w, http.StatusOK, map[string]any{"users": s.auth.store.list()})
		return
	}
	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
		Admin    bool   `json:"admin"`
	}
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 64*1024)).Decode(&body)
	switch err := s.auth.store.create(body.Username, body.Password, body.Admin); err {
	case nil:
		logger.Infof("user created: %s (admin=%v)", body.Username, body.Admin)
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	case errUserExists:
		writeJSON(w, http.StatusConflict, map[string]string{"error": "user already exists"})
	case errBadUsername:
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "username must be 1-32 chars of letters, digits, _ . -"})
	case errPasswordTooShort:
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "password must be at least 6 characters"})
	default:
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to create user"})
	}
}

// handleUserDelete removes ?username=<u>. Admin only. Guards against deleting
// yourself or the last remaining admin.
func (s *server) handleUserDelete(w http.ResponseWriter, r *http.Request) {
	p := s.requireAdmin(w, r)
	if p == nil {
		return
	}
	target := r.URL.Query().Get("username")
	if target == p.User {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "cannot delete yourself"})
		return
	}
	if s.auth.store.isAdmin(target) && s.auth.store.countAdmins() <= 1 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "cannot delete the last admin"})
		return
	}
	switch err := s.auth.store.delete(target); err {
	case nil:
		logger.Infof("user deleted: %s", target)
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	case errNoSuchUser:
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such user"})
	default:
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to delete user"})
	}
}

// handleSessions lists the authenticated user's live sessions so any device can
// render the full tab list (multi-device visibility).
func (s *server) handleSessions(w http.ResponseWriter, r *http.Request) {
	p := s.auth.verifyToken(extractToken(r))
	if p == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"sessions": s.mgr.list(p.User)})
}

// handleSessionDelete terminates one of the user's sessions by ?id=<sid>.
func (s *server) handleSessionDelete(w http.ResponseWriter, r *http.Request) {
	p := s.auth.verifyToken(extractToken(r))
	if p == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	sid := sanitize(r.URL.Query().Get("id"))
	if sid == "" || !s.mgr.killSession(p.User, sid) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such session"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *server) handleWS(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	payload := s.auth.verifyToken(q.Get("token"))
	if payload == nil {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	ws, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return // gorilla already wrote the error response
	}

	user := payload.User
	sid := sanitize(q.Get("session"))
	title := q.Get("title")
	cols := u16(atoiOr(q.Get("cols"), 80), 80)
	rows := u16(atoiOr(q.Get("rows"), 24), 24)

	c := newConn(ws)
	if sid == "" {
		c.send(eventFrame(map[string]any{"event": "error", "message": "missing session id"}))
		c.close()
		return
	}

	sess, isNew, err := s.mgr.getOrCreate(user, sid, title, cols, rows)
	if err != nil {
		logger.Warnf("attach failed user=%s: %v", user, err)
		c.send(eventFrame(map[string]any{"event": "error", "message": err.Error()}))
		c.close()
		return
	}

	c.send(eventFrame(map[string]any{"event": "session", "key": sess.key, "isNew": isNew}))
	sess.attach(c, cols, rows)
	logger.Infof("%s %s user=%s size=%dx%d", map[bool]string{true: "created", false: "attached"}[isNew], sess.key, user, cols, rows)

	s.serveConn(sess, c, ws)
}

// serveConn is the read pump: it dispatches client frames until the socket
// closes, then detaches (the session keeps running).
func (s *server) serveConn(sess *session, c *conn, ws *websocket.Conn) {
	defer func() {
		sess.detach(c)
		c.close()
		logger.Debugf("ws closed for %s (session persists)", sess.key)
	}()

	const readTimeout = 70 * time.Second
	ws.SetReadLimit(1 << 20)
	_ = ws.SetReadDeadline(time.Now().Add(readTimeout))
	ws.SetPongHandler(func(string) error {
		return ws.SetReadDeadline(time.Now().Add(readTimeout))
	})

	for {
		mt, data, err := ws.ReadMessage()
		if err != nil {
			return
		}
		if mt != websocket.TextMessage || len(data) == 0 {
			continue
		}
		switch data[0] {
		case '0':
			sess.write(data[1:])
		case '1':
			var cmd struct {
				Cmd  string `json:"cmd"`
				Cols int    `json:"cols"`
				Rows int    `json:"rows"`
			}
			if json.Unmarshal(data[1:], &cmd) != nil {
				continue
			}
			switch cmd.Cmd {
			case "resize":
				sess.resize(u16(cmd.Cols, 80), u16(cmd.Rows, 24))
			case "kill":
				sess.kill()
				return
			}
		}
	}
}

func main() {
	// Dispatch the uninstall subcommand before flag parsing, which would
	// otherwise treat "uninstall" as a positional arg and ignore it.
	if len(os.Args) > 1 && os.Args[1] == "uninstall" {
		runUninstall(os.Args[2:])
		return
	}

	cfg := parseConfig()
	logger = newLogger(cfg.logLevel)

	if cfg.sshHost != "" && cfg.sshUser == "" {
		logger.Errorf("--ssh-host requires --ssh-user (or SSH_USER)")
		os.Exit(1)
	}

	srv := &server{
		cfg:  cfg,
		auth: newAuth(cfg),
		mgr:  newManager(cfg),
		upgrader: websocket.Upgrader{
			// Auth is enforced by the token check above, so any origin may connect.
			CheckOrigin: func(*http.Request) bool { return true },
		},
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	})
	mux.HandleFunc("/api/login", srv.handleLogin)
	mux.HandleFunc("/api/me", srv.handleMe)
	mux.HandleFunc("POST /api/password", srv.handlePassword)
	mux.HandleFunc("GET /api/users", srv.handleUsers)
	mux.HandleFunc("POST /api/users", srv.handleUsers)
	mux.HandleFunc("DELETE /api/users", srv.handleUserDelete)
	mux.HandleFunc("GET /api/sessions", srv.handleSessions)
	mux.HandleFunc("DELETE /api/sessions", srv.handleSessionDelete)
	mux.HandleFunc("/ws", srv.handleWS)
	mux.Handle("/", noCache(webHandler(cfg)))

	// Idle-session reaper.
	if cfg.timeoutMin > 0 {
		go func() {
			t := time.NewTicker(time.Minute)
			defer t.Stop()
			for range t.C {
				srv.mgr.reap()
			}
		}()
	}

	// Auto self-signed HTTPS: when requested without an explicit cert/key, generate
	// and persist a pair so the bare binary serves HTTPS with no nginx in front.
	if cfg.sslAuto && (cfg.sslCert == "" || cfg.sslKey == "") {
		home, _ := os.UserHomeDir()
		dir := persistDir(home)
		if dir == "" {
			dir = os.TempDir()
		}
		cert, key, err := ensureSelfSigned(dir)
		if err != nil {
			logger.Errorf("auto TLS: %v", err)
			os.Exit(1)
		}
		cfg.sslCert, cfg.sslKey = cert, key
		logger.Infof("auto TLS: self-signed cert at %s", dir)
	}

	httpSrv := &http.Server{Addr: cfg.host + ":" + strconv.Itoa(cfg.port), Handler: mux}
	useTLS := cfg.sslKey != "" && cfg.sslCert != ""

	go func() {
		proto := "http"
		if useTLS {
			proto = "https"
		}
		logger.Infof("remote-shell listening on %s://%s:%d", proto, cfg.host, cfg.port)
		if cfg.sshHost != "" {
			logger.Infof("backend=ssh target=%s@%s:%d", cfg.sshUser, cfg.sshHost, cfg.sshPort)
		} else {
			logger.Infof("backend=local shell=%s cwd=%s", cfg.shell, cfg.cwd)
		}
		if cfg.authEnabled {
			logger.Infof("auth: username=%s", cfg.username)
			if cfg.generatedPassword {
				logger.Infof("auth: GENERATED password = %s", cfg.password)
			}
		} else {
			logger.Warnf("auth DISABLED (--no-auth) — never expose this to an untrusted network")
		}

		var err error
		if useTLS {
			err = httpSrv.ListenAndServeTLS(cfg.sslCert, cfg.sslKey)
		} else {
			err = httpSrv.ListenAndServe()
		}
		if err != nil && err != http.ErrServerClosed {
			logger.Errorf("server error: %v", err)
			os.Exit(1)
		}
	}()

	// Graceful shutdown: stop accepting; in-container PTYs die with the process.
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	sig := <-stop
	logger.Infof("received %v, shutting down", sig)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_ = httpSrv.Shutdown(ctx)
}
