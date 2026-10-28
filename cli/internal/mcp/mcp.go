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
	// In project scope, reject any command containing paths, drive letters, or
	// embedded whitespace so a repository cannot point `command` at `./node.exe`
	// or `../evil/npx` inside the workspace. The command is later executed
	// verbatim by exec.Command, so a bare executable name is the only safe form.
	if strings.ContainsAny(cmd, " \t\r\n/\\:") {
		return fmt.Errorf("MCP command %q must be a bare executable name in project scope", cmd)
	}
	// The suffix is stripped case-sensitively, matching the desktop app, so
	// both readers make the same decision about a given registry file.
	stem := cmd
	for _, ext := range []string{".exe", ".cmd", ".bat"} {
		if strings.HasSuffix(stem, ext) {
			stem = stem[:len(stem)-len(ext)]
			break
		}
	}
	if _, ok := allowedMCPCommands[stem]; !ok {
		if _, ok := allowedMCPCommands[cmd]; !ok {
			return fmt.Errorf("MCP command %q is not allowed in project scope", cmd)
		}
	}
	return nil
}

// dangerousMCPEnvKeys lists environment variables that can hijack the MCP
// server process. A project registry ships inside the repository, so it must
// not be able to repoint the interpreter loader or the runtime search path.
var dangerousMCPEnvKeys = map[string]struct{}{
	"PATH": {}, "PATHEXT": {}, "NODE_OPTIONS": {}, "NODE_PATH": {},
	"PYTHONSTARTUP": {}, "PYTHONPATH": {}, "PYTHONHOME": {},
	"RUBYOPT": {}, "RUBYLIB": {}, "PERL5OPT": {}, "PERL5LIB": {},
	"JAVA_TOOL_OPTIONS": {}, "JDK_JAVA_OPTIONS": {}, "_JAVA_OPTIONS": {},
	"CARGO_BUILD_RUSTC_WRAPPER": {}, "RUSTC_WRAPPER": {},
	"BASH_ENV": {}, "ENV": {}, "NPM_CONFIG_SCRIPT_SHELL": {},
}

// validateMCPEnv rejects environment overrides that can subvert the MCP server
// process. User-scoped configuration belongs to the machine owner and is left
// untouched; project-scoped configuration is attacker-controlled.
func validateMCPEnv(env map[string]string, scope string) error {
	if scope == "user" {
		return nil
	}
	for key := range env {
		upper := strings.ToUpper(strings.TrimSpace(key))
		_, dangerous := dangerousMCPEnvKeys[upper]
		if strings.HasPrefix(upper, "LD_") || strings.HasPrefix(upper, "DYLD_") {
			dangerous = true
		}
		if dangerous {
			return fmt.Errorf("MCP env variable %q is not allowed in project scope", key)
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
	// DisabledTools lists tools the desktop app disabled in settings.
	// The CLI filters them from the offered toolset and rejects direct
	// calls, mirroring the desktop enforcement.
	DisabledTools []string `json:"disabledTools,omitempty"`
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
//
// A server name present in both scopes resolves to the project entry: the
// closer config is the more specific one. This matches the desktop app's
// merge rule, and without it the same server would be offered twice - once
// per scope - producing two identically named tools in the agent's toolset.
func Load(workspace string) (Registry, error) {
	project, err := loadFile(filepath.Join(workspace, WorkspaceFileName), "project")
	if err != nil {
		return Registry{}, err
	}

	userPath, err := userRegistryPath()
	if err != nil {
		return Registry{}, err
	}
	user, err := loadFile(userPath, "user")
	if err != nil {
		return Registry{}, err
	}

	// User entries first, project entries second, so a project entry of the
	// same name replaces the user one.
	byName := make(map[string]Server, len(project)+len(user))
	for _, server := range user {
		byName[server.Name] = server
	}
	for _, server := range project {
		byName[server.Name] = server
	}

	servers := make([]Server, 0, len(byName))
	for _, server := range byName {
		servers = append(servers, server)
	}
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
		// A malformed registry is a broken file, not a broken install. The
		// desktop app warns and continues, so a corrupt registry must not
		// strip the agent of every MCP tool it had configured.
		fmt.Fprintf(os.Stderr, "termigo: ignoring malformed MCP registry at %s: %v\n", path, err)
		return nil, nil
	}
	servers := make([]Server, 0, len(mcpServers))
	for name, server := range mcpServers {
		if server.Command == "" {
			fmt.Fprintf(os.Stderr, "termigo: ignoring MCP server %q in %s: command is empty\n", name, path)
			continue
		}
		if err := validateMCPCommand(server.Command, scope); err != nil {
			fmt.Fprintf(os.Stderr, "termigo: ignoring MCP server %q in %s: %v\n", name, path, err)
			continue
		}
		if err := validateMCPEnv(server.Env, scope); err != nil {
			fmt.Fprintf(os.Stderr, "termigo: ignoring MCP server %q in %s: %v\n", name, path, err)
			continue
		}
		if scope != "user" {
			if err := validateMCPArgs(server.Command, server.Args); err != nil {
				fmt.Fprintf(os.Stderr, "termigo: ignoring MCP server %q in %s: %v\n", name, path, err)
				continue
			}
		}
		servers = append(servers, Server{
			Name:          name,
			Command:       server.Command,
			Args:          server.Args,
			Env:           server.Env,
			Scope:         scope,
			DisabledTools: server.DisabledTools,
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
	if err := validateMCPEnv(server.Env, "project"); err != nil {
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
