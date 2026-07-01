package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestUserStoreCreateAuthenticate(t *testing.T) {
	s := newUserStore("")
	if err := s.create("alice", "s3cret", true); err != nil {
		t.Fatalf("create: %v", err)
	}
	if !s.authenticate("alice", "s3cret") {
		t.Fatalf("authenticate with correct password failed")
	}
	if s.authenticate("alice", "wrong") {
		t.Fatalf("authenticate with wrong password succeeded")
	}
	if s.authenticate("bob", "s3cret") {
		t.Fatalf("authenticate for absent user succeeded")
	}
	if !s.isAdmin("alice") {
		t.Fatalf("alice should be admin")
	}
}

func TestUserStoreValidation(t *testing.T) {
	s := newUserStore("")
	if err := s.create("bad name!", "s3cret", false); err != errBadUsername {
		t.Fatalf("bad username err = %v, want errBadUsername", err)
	}
	if err := s.create("bob", "short", false); err != errPasswordTooShort {
		t.Fatalf("short password err = %v, want errPasswordTooShort", err)
	}
	_ = s.create("bob", "s3cret", false)
	if err := s.create("bob", "another", false); err != errUserExists {
		t.Fatalf("duplicate err = %v, want errUserExists", err)
	}
}

func TestUserStoreDeleteAndList(t *testing.T) {
	s := newUserStore("")
	_ = s.create("alice", "s3cret", true)
	_ = s.create("bob", "s3cret", false)
	if s.count() != 2 || s.countAdmins() != 1 {
		t.Fatalf("count=%d admins=%d, want 2/1", s.count(), s.countAdmins())
	}
	if err := s.delete("carol"); err != errNoSuchUser {
		t.Fatalf("delete absent err = %v, want errNoSuchUser", err)
	}
	if err := s.delete("bob"); err != nil {
		t.Fatalf("delete bob: %v", err)
	}
	l := s.list()
	if len(l) != 1 || l[0].Username != "alice" || !l[0].Admin {
		t.Fatalf("list = %+v, want [alice admin]", l)
	}
}

func TestUserStorePersistenceAndHashing(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "users.json")
	s := newUserStore(path)
	_ = s.create("alice", "s3cret", true)

	// Password must NOT appear in plaintext on disk.
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read users.json: %v", err)
	}
	if string(raw) == "" {
		t.Fatalf("users.json empty")
	}
	if containsSubstr(string(raw), "s3cret") {
		t.Fatalf("plaintext password found on disk")
	}

	// Reload from disk: the user and its (hashed) password survive.
	s2 := newUserStore(path)
	if !s2.authenticate("alice", "s3cret") {
		t.Fatalf("reloaded store failed to authenticate")
	}
}

func containsSubstr(hay, needle string) bool {
	return len(hay) >= len(needle) && (func() bool {
		for i := 0; i+len(needle) <= len(hay); i++ {
			if hay[i:i+len(needle)] == needle {
				return true
			}
		}
		return false
	})()
}
