package main

import (
	"path/filepath"
	"testing"
)

func TestNewAuthSeedsAdmin(t *testing.T) {
	dir := t.TempDir()
	cfg := &config{
		authEnabled: true,
		username:    "admin",
		password:    "s3cret1",
		tokenSecret: "seed-secret",
		usersFile:   filepath.Join(dir, "users.json"),
	}
	a := newAuth(cfg)
	if !a.checkCredentials("admin", "s3cret1") {
		t.Fatalf("seeded admin should authenticate")
	}
	if !a.isAdmin("admin") {
		t.Fatalf("seeded user should be admin")
	}

	// A restart (new auth over the same file) must NOT reseed / overwrite.
	a2 := newAuth(cfg)
	if a2.store.count() != 1 {
		t.Fatalf("restart reseeded: count=%d, want 1", a2.store.count())
	}
}

func TestAuthSetPasswordViaStore(t *testing.T) {
	dir := t.TempDir()
	cfg := &config{authEnabled: true, username: "admin", password: "s3cret1",
		tokenSecret: "x", usersFile: filepath.Join(dir, "users.json")}
	a := newAuth(cfg)
	if err := a.setPassword("admin", "brandnew"); err != nil {
		t.Fatalf("setPassword: %v", err)
	}
	if a.checkCredentials("admin", "s3cret1") {
		t.Fatalf("old password still works")
	}
	if !a.checkCredentials("admin", "brandnew") {
		t.Fatalf("new password does not work")
	}
}
