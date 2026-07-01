package main

import (
	"encoding/json"
	"errors"
	"os"
	"regexp"
	"sort"
	"sync"
	"time"

	"golang.org/x/crypto/bcrypt"
)

const minPasswordLen = 6

var usernameRe = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,32}$`)

var (
	errUserExists       = errors.New("user already exists")
	errNoSuchUser       = errors.New("no such user")
	errBadUsername      = errors.New("invalid username")
	errPasswordTooShort = errors.New("password too short")
)

// userRecord is one account as persisted in users.json.
type userRecord struct {
	Username     string `json:"username"`
	PasswordHash string `json:"passwordHash"`
	Admin        bool   `json:"admin"`
	Created      int64  `json:"created"` // unix millis
}

// userInfo is the safe, hash-free view returned to admin clients.
type userInfo struct {
	Username string `json:"username"`
	Admin    bool   `json:"admin"`
	Created  int64  `json:"created"`
}

// userStore is the source of truth for credentials, persisted as JSON.
// path == "" keeps it in memory only (tests / no persist dir).
type userStore struct {
	mu    sync.RWMutex
	path  string
	users map[string]*userRecord
}

// newUserStore loads the store from path (if present); a missing or unreadable
// file yields an empty store so a corrupt file never permanently locks everyone
// out (seeding recreates the admin).
func newUserStore(path string) *userStore {
	s := &userStore{path: path, users: map[string]*userRecord{}}
	if path == "" {
		return s
	}
	if b, err := os.ReadFile(path); err == nil {
		var recs []*userRecord
		if json.Unmarshal(b, &recs) == nil {
			for _, r := range recs {
				if r != nil && r.Username != "" {
					s.users[r.Username] = r
				}
			}
		} else {
			logger.Warnf("users.json is corrupt; starting with an empty store")
		}
	}
	return s
}

// save writes the store to disk atomically (temp + rename), 0600. Caller holds
// the write lock. A prior file is backed up to <path>.bak on the first save.
func (s *userStore) save() error {
	if s.path == "" {
		return nil
	}
	recs := make([]*userRecord, 0, len(s.users))
	for _, r := range s.users {
		recs = append(recs, r)
	}
	sort.Slice(recs, func(i, j int) bool { return recs[i].Username < recs[j].Username })
	b, err := json.MarshalIndent(recs, "", "  ")
	if err != nil {
		return err
	}
	if old, err := os.ReadFile(s.path); err == nil {
		_ = os.WriteFile(s.path+".bak", old, 0o600)
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

func (s *userStore) authenticate(user, pass string) bool {
	s.mu.RLock()
	r := s.users[user]
	s.mu.RUnlock()
	if r == nil {
		return false
	}
	return bcrypt.CompareHashAndPassword([]byte(r.PasswordHash), []byte(pass)) == nil
}

func (s *userStore) isAdmin(user string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	r := s.users[user]
	return r != nil && r.Admin
}

func (s *userStore) count() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.users)
}

func (s *userStore) countAdmins() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	n := 0
	for _, r := range s.users {
		if r.Admin {
			n++
		}
	}
	return n
}

func (s *userStore) create(user, pass string, admin bool) error {
	if !usernameRe.MatchString(user) {
		return errBadUsername
	}
	if len(pass) < minPasswordLen {
		return errPasswordTooShort
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(pass), bcrypt.DefaultCost)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.users[user] != nil {
		return errUserExists
	}
	s.users[user] = &userRecord{Username: user, PasswordHash: string(hash), Admin: admin, Created: time.Now().UnixMilli()}
	return s.save()
}

func (s *userStore) delete(user string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.users[user] == nil {
		return errNoSuchUser
	}
	delete(s.users, user)
	return s.save()
}

func (s *userStore) setPassword(user, newpass string) error {
	if len(newpass) < minPasswordLen {
		return errPasswordTooShort
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(newpass), bcrypt.DefaultCost)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	r := s.users[user]
	if r == nil {
		return errNoSuchUser
	}
	r.PasswordHash = string(hash)
	return s.save()
}

func (s *userStore) list() []userInfo {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]userInfo, 0, len(s.users))
	for _, r := range s.users {
		out = append(out, userInfo{Username: r.Username, Admin: r.Admin, Created: r.Created})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Username < out[j].Username })
	return out
}
