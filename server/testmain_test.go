package main

import (
	"os"
	"testing"
)

// TestMain sets the package-global logger exactly once for the whole test
// binary, mirroring main() which sets it before any goroutine starts. Setting
// logger per-test raced with server goroutines (spawned by httptest servers)
// that keep reading it after a test returns — e.g. serveConn's deferred
// Debugf on ws close (see the -race report).
func TestMain(m *testing.M) {
	logger = newLogger("error")
	os.Exit(m.Run())
}
