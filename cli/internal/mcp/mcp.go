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

// allowedMCPCommands is an allow-list of base executables that can be used to
// run an MCP server. Allowing arbitrary commands from a project-level registry
// file is equivalent to adding a backdoor to every contributor who pulls the
// repo (see CVE-2024-22471 / Cody).
var allowedMCPCommands = map[string]struct{}{
	"npx": {}, "uvx": {}, "bunx": {}, "node": {}, "python": {}, "python3": {}, "go": {},
	"bun": {}, "deno": {}, "npm": {}, "pnpm": {}, "yarn": {}, "java": {},
	"ruby": {}, "rustc": {}, "cargo": {},
}

// inlineCodeArgs are flags that make an otherwise-allowlisted interpreter run
// code supplied on the command line. A project registry is attacker-controlled
// (it ships in the repo), and `python3 -c '...'` would be arbitrary execution
// without even naming a package, which is exactly what the allow-list exists to
// prevent. Only checked for project scope; user scope is the machine owner.
var inlineCodeArgs = map[string]struct{}{
	"-c": {}, "--call": {}, "-e": {}, "--eval": {}, "-p": {}, "--print": {},
	"--exec": {}, "eval": {},
}

func validateMCPArgs(command string, args []string) error {
	base := strings.Trim(strings.TrimSpace(command), `"'`)
	base = filepath.Base(base)
	if ext := filepath.Ext(base); ext != "" {
		if lowered := strings.ToLower(ext); lowered == ".exe" || lowered == ".cmd" || lowered == ".bat" {
			base = strings.TrimSuffix(base, ext)
		}
	}
	switch strings.ToLower(base) {
	case "python", "python3", "node", "bun", "bunx", "deno", "ruby", "npx", "uvx", "npm", "pnpm", "yarn":
	default:
		return nil
	}
	for _, arg := range args {
		name := strings.ToLower(strings.SplitN(strings.TrimSpace(arg), "=", 2)[0])
		if _, bad := inlineCodeArgs[name]; bad {
			return fmt.Errorf("MCP argument %q is not allowed in project scope", arg)
		}
		for _, expanded := range expandShortFlags(name) {
			if _, bad := inlineCodeArgs[expanded]; bad {
				return fmt.Errorf("MCP argument %q is not allowed in project scope", arg)
			}
		}
	}
	return nil
}

// expandShortFlags lists the single-letter flags a bundled token stands for:
// `-we` means `-w -e`. Both spellings run the same code in every interpreter,
// so matching only the literal token leaves the gate open to
// `ruby -we "system('id')"`. Long options (`--eval`) and bare words return
// nothing: they are compared whole by the caller.
func expandShortFlags(arg string) []string {
	if len(arg) < 3 || !strings.HasPrefix(arg, "-") || strings.HasPrefix(arg, "--") {
		return nil
	}
	out := make([]string, 0, len(arg)-1)
	for _, r := range arg[1:] {
		out = append(out, "-"+string(r))
	}
	return out
}

// validateMCPCommand ensures the MCP server executable is allowed.
// User-scoped configuration is explicitly configured by the machine owner.
// Project-scoped configuration from git repositories is checked against the allow-list.
func validateMCPCommand(command, scope string) error {
	cmd := strings.TrimSpace(command)
	if cmd == "" {
		return fmt.Errorf("command is empty")
	}
	if scope == "user" {
		return nil
	}
	fields := strings.Fields(cmd)
	if len(fields) == 0 {
		return fmt.Errorf("command is empty")
	}
	rawBase := fields[0]
	rawBase = strings.Trim(rawBase, `"'`)
	base := filepath.Base(rawBase)
	ext := strings.ToLower(filepath.Ext(base))
	stem := base
	if ext == ".exe" || ext == ".cmd" || ext == ".bat" {
		stem = strings.TrimSuffix(base, ext)
	}

	if _, ok := allowedMCPCommands[stem]; !ok {
		if _, ok := allowedMCPCommands[base]; !ok {
			return fmt.Errorf("MCP command %q is not allowed in project scope", rawBase)
		}
	}
	return nil
}

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
	// InputSchema is the JSON Schema of the tool's arguments, sent to the model
	// so it can call the tool correctly. A server may omit it.
	InputSchema map[string]any `json:"inputSchema,omitempty"`
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

func parseMCPRegistryData(data []byte) (map[string]config.MCPServer, error) {
	trimmed := strings.TrimSpace(strings.TrimPrefix(string(data), "\uFEFF"))
	if trimmed == "" {
		return map[string]config.MCPServer{}, nil
	}
	dec := json.NewDecoder(strings.NewReader(trimmed))
	merged := map[string]config.MCPServer{}
	decodedAny := false
	for dec.More() {
		var raw struct {
			MCPServers map[string]config.MCPServer `json:"mcpServers"`
		}
		if err := dec.Decode(&raw); err != nil {
			return nil, err
		}
		decodedAny = true
		for k, v := range raw.MCPServers {
			merged[k] = v
		}
	}
	if !decodedAny {
		var raw struct {
			MCPServers map[string]config.MCPServer `json:"mcpServers"`
		}
		if err := json.Unmarshal([]byte(trimmed), &raw); err != nil {
			return nil, err
		}
		for k, v := range raw.MCPServers {
			merged[k] = v
		}
	}
	return merged, nil
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
	mcpServers, err := parseMCPRegistryData(data)
	if err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	servers := make([]Server, 0, len(mcpServers))
	for name, server := range mcpServers {
		if server.Command == "" {
			return nil, fmt.Errorf("%s: server %q has no command", path, name)
		}
		if err := validateMCPCommand(server.Command, scope); err != nil {
			return nil, fmt.Errorf("%s: server %q: %w", path, name, err)
		}
		if scope != "user" {
			if err := validateMCPArgs(server.Command, server.Args); err != nil {
				return nil, fmt.Errorf("%s: server %q: %w", path, name, err)
			}
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
	if err := validateMCPCommand(server.Command, "project"); err != nil {
		return Server{}, err
	}
	if err := validateMCPArgs(server.Command, server.Args); err != nil {
		return Server{}, err
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
	if err := writeRegistryFile(path, data); err != nil {
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
	return writeRegistryFile(path, payload)
}

func userRegistryPath() (string, error) {
	home, err := config.Home()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, "mcp.json"), nil
}

// writeRegistryFile persists a marshalled registry atomically: the payload is
// copied with a trailing newline onto a fresh buffer (json.Marshal output must
// never be appended past its length) and written to a temp file that is
// renamed over the target, so a crash cannot leave a torn registry behind.
func writeRegistryFile(path string, payload []byte) error {
	out := make([]byte, len(payload)+1)
	copy(out, payload)
	out[len(payload)] = '\n'
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, out, 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
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
