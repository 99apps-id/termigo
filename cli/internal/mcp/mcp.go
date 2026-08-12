// Package mcp manages Model Context Protocol (MCP) servers for Termigo.
//
// Servers are configured with the standard MCP shape and launched as local
// child processes speaking JSON-RPC 2.0 over stdio:
//
//	{
//	  "mcpServers": {
//	    "filesystem": {
//	      "command": "npx",
//	      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
//	      "env": {}
//	    }
//	  }
//	}
//
// The registry is read from <workspace>/.termigo/mcp.json and merged with the
// user-level registry in the Termigo home directory.
package mcp

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/99apps-id/termigo/cli/internal/config"
)

// WorkspaceFileName is the project-scoped MCP registry file.
const WorkspaceFileName = ".termigo/mcp.json"

// Server is one configured MCP server.
type Server struct {
	Name    string            `json:"name"`
	Command string            `json:"command"`
	Args    []string          `json:"args,omitempty"`
	Env     map[string]string `json:"env,omitempty"`
	// Scope is "project" or "user".
	Scope string `json:"scope"`
}

// Tool is a tool exposed by an MCP server.
type Tool struct {
	Server      string `json:"server"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
}

// Registry is the merged server list for a workspace.
type Registry struct {
	Servers []Server `json:"servers"`
}

// Load returns the merged project + user MCP registry for a workspace.
func Load(workspace string) (Registry, error) {
	var servers []Server

	project, err := loadFile(filepath.Join(workspace, WorkspaceFileName), "project")
	if err != nil {
		return Registry{}, err
	}
	servers = append(servers, project...)

	userPath, err := userRegistryPath()
	if err != nil {
		return Registry{}, err
	}
	user, err := loadFile(userPath, "user")
	if err != nil {
		return Registry{}, err
	}
	servers = append(servers, user...)

	sort.SliceStable(servers, func(i, j int) bool {
		return strings.ToLower(servers[i].Name) < strings.ToLower(servers[j].Name)
	})
	return Registry{Servers: servers}, nil
}

// loadFile reads one registry file; a missing file is not an error.
func loadFile(path, scope string) ([]Server, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	var raw struct {
		MCPServers map[string]config.MCPServer `json:"mcpServers"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	servers := make([]Server, 0, len(raw.MCPServers))
	for name, server := range raw.MCPServers {
		if server.Command == "" {
			return nil, fmt.Errorf("%s: server %q has no command", path, name)
		}
		servers = append(servers, Server{
			Name:    name,
			Command: server.Command,
			Args:    server.Args,
			Env:     server.Env,
			Scope:   scope,
		})
	}
	return servers, nil
}

// Add writes a server entry to the project registry, creating the file.
func Add(workspace, name string, server config.MCPServer) (Server, error) {
	if workspace == "" {
		return Server{}, errors.New("a workspace is required to add a project MCP server")
	}
	name = strings.TrimSpace(name)
	if name == "" {
		return Server{}, errors.New("server name must not be empty")
	}
	if server.Command == "" {
		return Server{}, errors.New("server command must not be empty")
	}

	path := filepath.Join(workspace, WorkspaceFileName)
	var existing struct {
		MCPServers map[string]config.MCPServer `json:"mcpServers"`
	}
	if data, err := os.ReadFile(path); err == nil {
		if err := json.Unmarshal(data, &existing); err != nil {
			return Server{}, fmt.Errorf("parse %s: %w", path, err)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return Server{}, fmt.Errorf("read %s: %w", path, err)
	}
	if existing.MCPServers == nil {
		existing.MCPServers = map[string]config.MCPServer{}
	}
	existing.MCPServers[name] = server

	data, err := json.MarshalIndent(map[string]map[string]config.MCPServer{"mcpServers": existing.MCPServers}, "", "  ")
	if err != nil {
		return Server{}, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return Server{}, fmt.Errorf("create .termigo folder: %w", err)
	}
	if err := os.WriteFile(path, append(data, '\n'), 0o644); err != nil {
		return Server{}, fmt.Errorf("write %s: %w", path, err)
	}
	return Server{Name: name, Command: server.Command, Args: server.Args, Env: server.Env, Scope: "project"}, nil
}

// Remove deletes a server from the project registry.
func Remove(workspace, name string) error {
	if workspace == "" {
		return errors.New("a workspace is required")
	}
	path := filepath.Join(workspace, WorkspaceFileName)
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("no project MCP registry at %s", path)
	}
	if err != nil {
		return fmt.Errorf("read %s: %w", path, err)
	}
	var raw struct {
		MCPServers map[string]config.MCPServer `json:"mcpServers"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return fmt.Errorf("parse %s: %w", path, err)
	}
	if _, ok := raw.MCPServers[name]; !ok {
		return fmt.Errorf("server %q not found in %s", name, path)
	}
	delete(raw.MCPServers, name)
	payload, err := json.MarshalIndent(map[string]map[string]config.MCPServer{"mcpServers": raw.MCPServers}, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(payload, '\n'), 0o644)
}

func userRegistryPath() (string, error) {
	home, err := config.Home()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, "mcp.json"), nil
}

// FormatRegistry renders a human-readable registry listing.
func FormatRegistry(registry Registry) string {
	var builder strings.Builder
	builder.WriteString("MCP servers\n")
	if len(registry.Servers) == 0 {
		builder.WriteString("  (none configured)\n")
		return builder.String()
	}
	for _, server := range registry.Servers {
		builder.WriteString(fmt.Sprintf("  %-18s %s %s (%s)\n", server.Name, server.Command, strings.Join(server.Args, " "), server.Scope))
	}
	return builder.String()
}
