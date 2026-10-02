// Package config manages the user-level Termigo configuration stored under
// the Termigo home directory (defaults to ~/.termigo).
//
// Configuration is deliberately small and local: providers, MCP servers and
// preferences. It never stores API keys; provider keys live in the operating
// system keychain or the provider's own CLI configuration.
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
)

// FileName is the user configuration file name inside the Termigo home.
const FileName = "config.json"

// Config is the user-level Termigo configuration.
type Config struct {
	// Providers lists configured agent providers. Keys are provider ids
	// (codex, claude, gemini, ollama, ...) and values are options.
	Providers map[string]ProviderOptions `json:"providers,omitempty"`
	// MCPServers lists MCP servers, using the standard MCP server shape.
	MCPServers map[string]MCPServer `json:"mcpServers,omitempty"`
	// DefaultAgent is the provider used when none is selected.
	DefaultAgent string `json:"defaultAgent,omitempty"`
	// Workspaces remembers recently opened projects.
	Workspaces []string `json:"workspaces,omitempty"`
	// DefaultModel is the model the interactive chat starts with.
	DefaultModel string `json:"defaultModel,omitempty"`
	// ApprovalMode is "ask" (a mutating tool needs approval) or "all".
	ApprovalMode string `json:"approvalMode,omitempty"`
	// TrustedFolders lists folders where a mutating tool runs without asking.
	TrustedFolders []string `json:"trustedFolders,omitempty"`
	// Language is the preferred reply language.
	Language string `json:"language,omitempty"`
}

// IsTrusted reports whether a folder is on the trusted list.
func (c Config) IsTrusted(folder string) bool {
	cleaned := filepath.Clean(folder)
	for _, entry := range c.TrustedFolders {
		if filepath.Clean(entry) == cleaned {
			return true
		}
	}
	return false
}

// WithTrust adds or removes a folder from the trusted list.
func (c Config) WithTrust(folder string, trusted bool) Config {
	cleaned := filepath.Clean(folder)
	next := make([]string, 0, len(c.TrustedFolders)+1)
	found := false
	for _, entry := range c.TrustedFolders {
		if filepath.Clean(entry) == cleaned {
			found = true
			if !trusted {
				continue
			}
		}
		next = append(next, entry)
	}
	if trusted && !found {
		next = append(next, cleaned)
	}
	c.TrustedFolders = next
	return c
}

// ProviderOptions configures one agent provider.
type ProviderOptions struct {
	// Command overrides the executable path for a provider CLI.
	Command string `json:"command,omitempty"`
	// Model is the default model for providers that accept one.
	Model string `json:"model,omitempty"`
	// Endpoint is used by local providers such as Ollama.
	Endpoint string `json:"endpoint,omitempty"`
}

// MCPServer follows the MCP (Model Context Protocol) server configuration
// shape used by Claude Code, Codex and other MCP-aware clients.
type MCPServer struct {
	Command string            `json:"command"`
	Args    []string          `json:"args,omitempty"`
	Env     map[string]string `json:"env,omitempty"`
}

// EnvHome overrides the state directory, which is what keeps tests and
// throwaway profiles off the real one.
const EnvHome = "TERMIGO_HOME"

// Home returns the Termigo home directory, honouring TERMIGO_HOME.
func Home() (string, error) {
	if override := os.Getenv(EnvHome); override != "" {
		return override, nil
	}
	base, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolve home directory: %w", err)
	}
	return filepath.Join(base, ".termigo"), nil
}

// EnsureHome returns the state directory, creating it with private
// permissions when missing.
func EnsureHome() (string, error) {
	home, err := Home()
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(home, 0o700); err != nil {
		return "", fmt.Errorf("create state directory: %w", err)
	}
	return home, nil
}

// HomePath returns the absolute path of a file inside the state directory.
func HomePath(name string) (string, error) {
	home, err := Home()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, name), nil
}

// Path returns the user config file path.
func Path() (string, error) {
	return HomePath(FileName)
}

// Load reads the user configuration. A missing file returns an empty config
// without an error; malformed JSON is reported.
func Load() (Config, error) {
	path, err := Path()
	if err != nil {
		return Config{}, err
	}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return Config{}, nil
	}
	if err != nil {
		return Config{}, fmt.Errorf("read config %s: %w", path, err)
	}
	var config Config
	if err := json.Unmarshal(data, &config); err != nil {
		return Config{}, fmt.Errorf("parse config %s: %w", path, err)
	}
	return config, nil
}

// Save writes the configuration to disk, creating the home directory.
func Save(config Config) error {
	path, err := Path()
	if err != nil {
		return err
	}
	data, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return fmt.Errorf("encode config: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("create config directory: %w", err)
	}
	// Replace atomically where possible so a failed write never truncates
	// an existing configuration.
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return fmt.Errorf("write config: %w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("replace config: %w", err)
	}
	return nil
}

// Open returns the loaded config and the path it was read from.
func Open() (Config, string, error) {
	config, err := Load()
	if err != nil {
		return Config{}, "", err
	}
	path, err := Path()
	if err != nil {
		return Config{}, "", err
	}
	return config, path, nil
}

// Platform is a small helper used by tests and the doctor command.
func Platform() string {
	return runtime.GOOS
}
