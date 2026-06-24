package main

import (
	"crypto/rand"
	"encoding/hex"
	"flag"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

type config struct {
	port              int
	host              string
	shell             string
	cwd               string
	authEnabled       bool
	username          string
	password          string
	generatedPassword bool
	tokenSecret       string
	sslKey            string
	sslCert           string
	sslAuto           bool
	sshHost           string
	sshUser           string
	sshPort           int
	sshKey            string
	timeoutMin        int
	maxSessions       int
	ringBytes         int
	webDir            string
	logLevel          string
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envOrInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func envTruthy(key string) bool {
	switch strings.ToLower(os.Getenv(key)) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}

func randHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// persistDir returns $HOME/.remote-shell, creating it (0700) on demand. It lives
// on the persisted shell-home volume, so values written there survive container
// recreation. Returns "" when there is no usable home, which makes callers fall
// back to ephemeral generation.
func persistDir(home string) string {
	if home == "" || home == "/" {
		return ""
	}
	dir := filepath.Join(home, ".remote-shell")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return ""
	}
	return dir
}

// loadOrCreate returns the value stored in dir/name, or generates one with gen(),
// persists it (0600), and returns that. When dir is "" or any I/O fails it just
// returns gen() without persisting, so auto-managed secrets stay stable across
// restarts without ever blocking startup.
func loadOrCreate(dir, name string, gen func() string) string {
	if dir == "" {
		return gen()
	}
	path := filepath.Join(dir, name)
	if b, err := os.ReadFile(path); err == nil {
		if v := strings.TrimSpace(string(b)); v != "" {
			return v
		}
	}
	v := gen()
	_ = os.WriteFile(path, []byte(v+"\n"), 0o600)
	return v
}

// parseConfig mirrors the flags/env of the archived Node server (config.js),
// plus --ring-bytes and --web-dir which replace tmux-specific options.
func parseConfig() *config {
	home, _ := os.UserHomeDir()
	if home == "" {
		home = "/"
	}

	fs := flag.NewFlagSet("remote-shell", flag.ExitOnError)
	port := fs.Int("port", envOrInt("PORT", 7681), "HTTP(S) listen port")
	host := fs.String("host", envOr("HOST", "0.0.0.0"), "listen address")
	shell := fs.String("shell", envOr("SHELL_PATH", envOr("SHELL", "/bin/bash")), "shell to launch (local mode)")
	cwd := fs.String("cwd", envOr("WORK_DIR", home), "initial working directory for NEW local sessions")
	username := fs.String("username", envOr("AUTH_USER", "admin"), "auth username")
	password := fs.String("password", envOr("AUTH_PASS", ""), "auth password (auto-generated if empty)")
	tokenSecret := fs.String("token-secret", envOr("TOKEN_SECRET", ""), "secret used to sign session tokens")
	sslKey := fs.String("ssl-key", envOr("SSL_KEY", ""), "TLS private key (enables built-in HTTPS)")
	sslCert := fs.String("ssl-cert", envOr("SSL_CERT", ""), "TLS certificate (enables built-in HTTPS)")
	sslAuto := fs.Bool("ssl-auto", envTruthy("SSL_AUTO"), "auto-generate+persist a self-signed cert and serve HTTPS (when no --ssl-cert/--ssl-key)")
	sshHost := fs.String("ssh-host", envOr("SSH_HOST", ""), "SSH into this host instead of a local shell")
	sshUser := fs.String("ssh-user", envOr("SSH_USER", ""), "SSH username (required with --ssh-host)")
	sshPort := fs.Int("ssh-port", envOrInt("SSH_PORT", 22), "SSH port")
	sshKey := fs.String("ssh-key", envOr("SSH_KEY", ""), "SSH private key path (omit for password/agent auth)")
	timeout := fs.Int("timeout", envOrInt("SESSION_TIMEOUT", 20160), "reap a detached+idle session after N minutes (default 20160 = 14 days; 0 = never)")
	maxSessions := fs.Int("max-sessions", envOrInt("MAX_SESSIONS", 0), "cap concurrent sessions (0 = unlimited)")
	ringBytes := fs.Int("ring-bytes", envOrInt("RING_BYTES", 2*1024*1024), "per-session scrollback buffer size in bytes")
	webDir := fs.String("web-dir", envOr("WEB_DIR", "./web"), "directory of static frontend assets")
	logLevel := fs.String("log-level", envOr("LOG_LEVEL", "info"), "log level: error|warn|info|debug")
	noAuth := fs.Bool("no-auth", false, "disable authentication (DANGEROUS, local dev only)")
	_ = fs.Parse(os.Args[1:])

	authEnabled := !*noAuth

	// Auto-managed secrets are persisted here so a zero-config deploy gets stable
	// credentials/tokens without any manual setup. Explicit env/flag values always
	// win and are never written.
	pdir := persistDir(home)

	pass := *password
	generated := false
	if authEnabled && pass == "" {
		// Jupyter-style: print a generated password on boot when none is set.
		// Persisted so it stays the same across restarts (still printed each boot).
		pass = loadOrCreate(pdir, "password", func() string { return randHex(9) })
		generated = true
	}

	secret := *tokenSecret
	if secret == "" {
		// A random secret invalidates existing tokens on every restart; persist a
		// generated one so logins survive restarts with no manual TOKEN_SECRET.
		secret = loadOrCreate(pdir, "token_secret", func() string { return randHex(32) })
	}

	return &config{
		port:              *port,
		host:              *host,
		shell:             *shell,
		cwd:               *cwd,
		authEnabled:       authEnabled,
		username:          *username,
		password:          pass,
		generatedPassword: generated,
		tokenSecret:       secret,
		sslKey:            *sslKey,
		sslCert:           *sslCert,
		sslAuto:           *sslAuto,
		sshHost:           *sshHost,
		sshUser:           *sshUser,
		sshPort:           *sshPort,
		sshKey:            *sshKey,
		timeoutMin:        *timeout,
		maxSessions:       *maxSessions,
		ringBytes:         *ringBytes,
		webDir:            *webDir,
		logLevel:          *logLevel,
	}
}

// commandFor returns the program + args the PTY should run: either a local
// shell, or an SSH login to the host (so the web terminal is the host user's
// shell, not the container's). Mirrors sessionManager.js:command().
func (c *config) commandFor() (string, []string) {
	if c.sshHost == "" {
		return c.shell, nil
	}
	args := []string{
		"-tt",
		"-o", "StrictHostKeyChecking=accept-new",
		"-o", "ServerAliveInterval=30",
		"-o", "ServerAliveCountMax=3",
	}
	if c.sshPort != 0 && c.sshPort != 22 {
		args = append(args, "-p", strconv.Itoa(c.sshPort))
	}
	if c.sshKey != "" {
		args = append(args, "-i", c.sshKey)
	}
	return "ssh", append(args, c.sshUser+"@"+c.sshHost)
}
