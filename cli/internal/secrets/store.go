// Package secrets stores the values Termixgo must keep private: provider API
// keys and the Telegram bot token.
//
// The store is a single 0600 JSON file in the state directory, which is the
// same fallback the desktop app uses on Linux. No secret is ever written to
// config.json, a session file or a log.
package secrets

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"github.com/99apps-id/termigo/cli/internal/config"
)

// FileName is the secret file name inside the state directory.
const FileName = "secrets.json"

// Well-known key builders. Exported so no caller hand-writes a key string.
const (
	telegramTokenKey = "telegram:token"
	providerPrefix   = "provider:"
)

// ProviderKey is the store key for one provider's API key.
func ProviderKey(provider string) string { return providerPrefix + provider }

// TelegramTokenKey is the store key for the bot token.
func TelegramTokenKey() string { return telegramTokenKey }

// Store is a concurrency-safe secret map backed by a private file.
type Store struct {
	mu   sync.Mutex
	path string
	data map[string]string
	// pending holds the changes made since the last save, keyed by secret. A
	// nil value is a deletion. Saving merges these onto whatever is on disk at
	// that moment, so a write here never drops a key another process added in
	// between (the service and a terminal are two processes on one file).
	pending map[string]*string
	// protectionErr records a failure to restrict the file's access rules.
	// It is reported rather than fatal: a read-only share can refuse the
	// change, and locking the operator out of their own keys would be worse
	// than telling them about it.
	protectionErr error
}

// ProtectionError reports the last failure to restrict the secret file's
// permissions, or nil when the file is private. `termigo doctor` surfaces it.
func (s *Store) ProtectionError() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.protectionErr
}

// Path returns the secret file location, which callers need to audit it.
func (s *Store) Path() string { return s.path }

// initLocked makes a zero-value store usable, which a white-box test builds.
func (s *Store) initLocked() {
	if s.data == nil {
		s.data = map[string]string{}
	}
	if s.pending == nil {
		s.pending = map[string]*string{}
	}
}

// Load reads the secret file. A missing file yields an empty store.
func Load() (*Store, error) {
	path, err := config.HomePath(FileName)
	if err != nil {
		return nil, err
	}
	store := &Store{path: path, data: map[string]string{}, pending: map[string]*string{}}
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return store, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read secrets: %w", err)
	}
	if err := json.Unmarshal(raw, &store.data); err != nil {
		return nil, fmt.Errorf("parse secrets %s: %w", path, err)
	}
	if store.data == nil {
		store.data = map[string]string{}
	}
	rejectPrototypePollution(store.data)
	// Repair the access rules of a file written by an older build, or under a
	// looser umask. A failure is recorded rather than returned so the
	// operator is warned by doctor instead of being locked out.
	if hardenErr := restrictFile(path); hardenErr != nil {
		store.protectionErr = hardenErr
	}
	return store, nil
}

// Get returns a secret or the empty string.
func (s *Store) Get(key string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.data[key]
}

// Has reports whether a non-empty secret is stored.
func (s *Store) Has(key string) bool { return strings.TrimSpace(s.Get(key)) != "" }

// Set writes a secret and persists the file at 0600.
func (s *Store) Set(key, value string) error {
	s.mu.Lock()
	s.initLocked()
	previous, existed := s.data[key]
	s.data[key] = value
	stored := value
	s.pending[key] = &stored
	s.mu.Unlock()

	if err := s.save(); err != nil {
		s.mu.Lock()
		delete(s.pending, key)
		if existed {
			s.data[key] = previous
		} else {
			delete(s.data, key)
		}
		s.mu.Unlock()
		return err
	}
	return nil
}

// Delete removes a secret. Deleting a missing key is not an error.
//
// A failed write is not rolled back: losing access to a key is the safe side of
// a failed delete, and the pending deletion is retried on the next save that
// succeeds, so the file and memory agree again.
func (s *Store) Delete(key string) error {
	s.mu.Lock()
	s.initLocked()
	if _, ok := s.data[key]; !ok {
		s.mu.Unlock()
		return nil
	}
	delete(s.data, key)
	s.pending[key] = nil
	s.mu.Unlock()
	return s.save()
}

// Keys lists stored keys, sorted. It is used by the status view and never
// exposes a value.
func (s *Store) Keys() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	keys := make([]string, 0, len(s.data))
	for key := range s.data {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

// save merges the pending changes onto the current on-disk file and writes it
// back, under a cross-process lock.
//
// The merge is the point: the file is shared by every Termixgo process on the
// machine (the serve service and a terminal, say), and a store loaded an hour
// ago does not know about a key another process added since. Writing the whole
// in-memory map would drop that key. Instead only the keys this store changed
// are applied to a fresh read, so no writer can clobber a key it never touched.
func (s *Store) save() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	dir := filepath.Dir(s.path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("create state directory: %w", err)
	}
	// The directory carries the restriction that children inherit, so it is
	// hardened before the file is created inside it.
	if err := restrictDirectory(dir); err != nil {
		return fmt.Errorf("protect state directory: %w", err)
	}

	lock, err := lockSecrets(s.path)
	if err != nil {
		return err
	}
	defer lock.release()

	merged := map[string]string{}
	if raw, readErr := os.ReadFile(s.path); readErr == nil {
		if jsonErr := json.Unmarshal(raw, &merged); jsonErr != nil {
			return fmt.Errorf("parse secrets %s: %w", s.path, jsonErr)
		}
		if merged == nil {
			merged = map[string]string{}
		}
		rejectPrototypePollution(merged)
	} else if !errors.Is(readErr, os.ErrNotExist) {
		return fmt.Errorf("read secrets: %w", readErr)
	}
	for key, value := range s.pending {
		if value == nil {
			delete(merged, key)
			continue
		}
		merged[key] = *value
	}

	encoded, err := json.MarshalIndent(merged, "", "  ")
	if err != nil {
		return fmt.Errorf("encode secrets: %w", err)
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, append(encoded, '\n'), 0o600); err != nil {
		return fmt.Errorf("write secrets: %w", err)
	}
	if err := restrictFile(tmp); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("protect secrets: %w", err)
	}
	if err := os.Rename(tmp, s.path); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("replace secrets: %w", err)
	}
	// Renaming can drop a freshly applied ACL on some filesystems, so the
	// final path is hardened once more before the write is reported as done.
	if err := restrictFile(s.path); err != nil {
		return fmt.Errorf("protect secrets: %w", err)
	}
	s.data = merged
	s.pending = map[string]*string{}
	s.protectionErr = nil
	return nil
}

// secretsLock is an exclusive advisory lock on the secret file's lock file.
//
// The lock is a sibling file rather than the secret file itself: on POSIX an
// advisory lock is held on the inode, and the secret file is replaced by rename
// on every write, so two processes could otherwise lock two different inodes and
// run together. The lock file is never renamed, so every process locks one
// inode.
type secretsLock struct {
	file *os.File
}

func lockSecrets(path string) (*secretsLock, error) {
	file, err := os.OpenFile(path+".lock", os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open secrets lock: %w", err)
	}
	if err := lockFile(file); err != nil {
		_ = file.Close()
		return nil, fmt.Errorf("lock secrets: %w", err)
	}
	return &secretsLock{file: file}, nil
}

func (l *secretsLock) release() {
	_ = unlockFile(l.file)
	_ = l.file.Close()
}

// rejectPrototypePollution removes well-known prototype pollution keys from a
// loaded secrets map. Go does not have a prototype chain, but these keys must
// not be accepted from a JSON file: a corrupted or attacker-written
// secrets.json would otherwise load them into the in-memory store.
func rejectPrototypePollution(data map[string]string) {
	for _, key := range []string{"__proto__", "constructor", "prototype"} {
		delete(data, key)
	}
}

// Redact renders a secret for display: prefix, dots, suffix. It never reveals
// more than four characters of the value.
func Redact(value string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return "(not set)"
	}
	if len(trimmed) <= 8 {
		return strings.Repeat("*", len(trimmed))
	}
	return trimmed[:4] + strings.Repeat("*", 6) + trimmed[len(trimmed)-2:]
}
