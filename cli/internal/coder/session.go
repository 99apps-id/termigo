package coder

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/99apps-id/termigo/cli/internal/config"
	"github.com/99apps-id/termigo/cli/internal/provider"
)

// Session is a persisted conversation. One JSON file per session lives under
// the state directory, so `termigo chat --continue` can resume the last one for
// a workspace and nothing but the operator's own files leaves the machine.
type Session struct {
	ID        string             `json:"id"`
	Workspace string             `json:"workspace"`
	Model     string             `json:"model,omitempty"`
	Title     string             `json:"title,omitempty"`
	CreatedAt time.Time          `json:"createdAt"`
	UpdatedAt time.Time          `json:"updatedAt"`
	Messages  []provider.Message `json:"messages"`
}

// sessionsDir returns the directory that holds the session files, creating it
// with private permissions.
func sessionsDir() (string, error) {
	home, err := config.EnsureHome()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(home, "sessions")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	return dir, nil
}

// NewSession starts an empty session for a workspace and model.
func NewSession(workspace, model string) *Session {
	now := time.Now()
	return &Session{
		ID:        newSessionID(now),
		Workspace: workspace,
		Model:     strings.TrimSpace(model),
		CreatedAt: now,
		UpdatedAt: now,
	}
}

// newSessionID is a sortable timestamp with millisecond precision plus the pid,
// which is readable and unique without pulling in a uuid dependency. Two
// sessions started in the same second must not collide, so the fraction is
// included.
func newSessionID(now time.Time) string {
	return fmt.Sprintf("%s-%06d-%d", now.UTC().Format("20060102T150405"), now.Nanosecond()/1000, os.Getpid())
}

// Save writes the session to disk, refreshing UpdatedAt.
func (s *Session) Save() error {
	if s == nil {
		return errors.New("nil session")
	}
	dir, err := sessionsDir()
	if err != nil {
		return err
	}
	if s.ID == "" {
		s.ID = newSessionID(time.Now())
	}
	s.UpdatedAt = time.Now()
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, s.ID+".json"), data, 0o600)
}

// LoadSession reads one session by id.
func LoadSession(id string) (*Session, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		return nil, errors.New("a session id is required")
	}
	dir, err := sessionsDir()
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(filepath.Join(dir, id+".json"))
	if err != nil {
		return nil, err
	}
	var session Session
	if err := json.Unmarshal(data, &session); err != nil {
		return nil, err
	}
	return &session, nil
}

// LatestSession returns the most recently updated session for a workspace, or
// (nil, nil) when the workspace has none.
func LatestSession(workspace string) (*Session, error) {
	sessions, err := ListSessions(workspace)
	if err != nil {
		return nil, err
	}
	if len(sessions) == 0 {
		return nil, nil
	}
	return sessions[0], nil
}

// ListSessions returns a workspace's sessions, newest first. An empty workspace
// lists every session.
func ListSessions(workspace string) ([]*Session, error) {
	dir, err := sessionsDir()
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	wanted := ""
	if strings.TrimSpace(workspace) != "" {
		wanted = filepath.Clean(workspace)
	}
	out := make([]*Session, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(dir, entry.Name()))
		if err != nil {
			continue
		}
		var session Session
		if json.Unmarshal(data, &session) != nil {
			continue
		}
		if wanted != "" && filepath.Clean(session.Workspace) != wanted {
			continue
		}
		out = append(out, &session)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].UpdatedAt.After(out[j].UpdatedAt) })
	return out, nil
}
