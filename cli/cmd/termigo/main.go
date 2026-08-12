package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/99apps-id/termigo/cli/internal/agent"
	"github.com/99apps-id/termigo/cli/internal/config"
	"github.com/99apps-id/termigo/cli/internal/doctor"
	"github.com/99apps-id/termigo/cli/internal/initcmd"
	"github.com/99apps-id/termigo/cli/internal/mcp"
	"github.com/99apps-id/termigo/cli/internal/skill"
)

var version = "dev"

func main() {
	if err := run(os.Args[1:], os.Stdout, os.Stderr); err != nil {
		fmt.Fprintln(os.Stderr, "termigo:", err)
		os.Exit(1)
	}
}

func run(args []string, stdout, stderr io.Writer) error {
	if len(args) == 0 || args[0] == "help" || args[0] == "--help" || args[0] == "-h" {
		writeUsage(stdout)
		return nil
	}

	switch args[0] {
	case "version", "--version", "-v":
		_, err := fmt.Fprintf(stdout, "termigo %s (%s/%s)\n", version, runtime.GOOS, runtime.GOARCH)
		return err
	case "doctor":
		return runDoctor(args[1:], stdout)
	case "init":
		return runInit(args[1:], stdout)
	case "agent":
		return runAgent(args[1:], stdout, stderr)
	case "skill":
		return runSkill(args[1:], stdout)
	case "mcp":
		return runMCP(args[1:], stdout)
	case "config":
		return runConfig(args[1:], stdout)
	default:
		return fmt.Errorf("unknown command %q; run 'termigo help'", args[0])
	}
}

// workspaceFromArgs extracts a -w/--workspace flag from args.
func workspaceFromArgs(args []string) (workspace string, rest []string, err error) {
	for index := 0; index < len(args); index++ {
		arg := args[index]
		switch {
		case arg == "-w" || arg == "--workspace":
			if index+1 >= len(args) {
				return "", nil, errors.New("--workspace requires a directory")
			}
			workspace = args[index+1]
			index++
		case strings.HasPrefix(arg, "--workspace="):
			workspace = strings.TrimPrefix(arg, "--workspace=")
		default:
			rest = append(rest, arg)
		}
	}
	return workspace, rest, nil
}

func currentWorkspace(workspace string) string {
	if workspace != "" {
		return workspace
	}
	if cwd, err := os.Getwd(); err == nil {
		return cwd
	}
	return ""
}

func writeUsage(stdout io.Writer) {
	_, _ = fmt.Fprint(stdout, `Termigo CLI - the command-line companion for the Termigo workspace.

Usage:
  termigo <command> [options]

Commands:
  doctor [--json]                  Inspect local development and agent tools
  init [dir]                       Scaffold .termigo/ and TERMIGO.md in a workspace
  agent list                       List agent providers and their availability
  agent run <provider> "task"      Run a task through a local agent provider
  skill list [--json]              List project and user skills
  skill show <name>                Print one skill
  skill create <name> [desc]       Scaffold a project skill
  mcp list [--json]                List configured MCP servers
  mcp tools [server]               Connect to servers and list their tools
  mcp call <server> <tool> [k=v]   Call an MCP tool
  mcp add <name> <command> [args]  Add a project MCP server
  mcp remove <name>                Remove a project MCP server
  mcp ping <server>                Check that an MCP server responds
  config                           Show the user configuration
  config set <key> <value>         Set a config value (e.g. defaultAgent)
  version                          Print CLI version
  help                             Show this help

Common options:
  -w, --workspace <dir>            Use a specific workspace (default: current dir)

Agent providers: codex, claude, gemini, antigravity, ollama (local).
Skills live in .termigo/skills/<name>/SKILL.md; MCP servers in .termigo/mcp.json.
The CLI never stores API keys; provider credentials stay with their own CLIs.
`)
}

func runDoctor(args []string, stdout io.Writer) error {
	jsonOutput := false
	for _, arg := range args {
		switch arg {
		case "--json":
			jsonOutput = true
		case "--help", "-h":
			_, err := fmt.Fprintln(stdout, "Usage: termigo doctor [--json]")
			return err
		default:
			return fmt.Errorf("unknown doctor option %q", arg)
		}
	}

	report := doctor.Inspect()
	if jsonOutput {
		encoder := json.NewEncoder(stdout)
		encoder.SetIndent("", "  ")
		return encoder.Encode(report)
	}

	_, _ = fmt.Fprintf(stdout, "Termigo doctor (%s/%s)\n\n", report.OS, report.Arch)
	for _, tool := range report.Tools {
		state := "missing"
		if tool.Available {
			state = "ready"
		}
		line := fmt.Sprintf("%-14s %s", tool.Name, state)
		if tool.Version != "" {
			line += "  " + tool.Version
		}
		_, _ = fmt.Fprintln(stdout, line)
	}
	_, err := fmt.Fprintln(stdout, "\nThis command only inspects locally installed tools; it never reads credentials.")
	return err
}

func runInit(args []string, stdout io.Writer) error {
	workspace, rest, err := workspaceFromArgs(args)
	if err != nil {
		return err
	}
	if len(rest) > 1 {
		return fmt.Errorf("init accepts at most one directory argument")
	}
	target := workspace
	if len(rest) == 1 {
		if workspace != "" && rest[0] != workspace {
			return errors.New("give the directory either as an argument or via --workspace, not both")
		}
		target = rest[0]
	}
	result, err := initcmd.Run(target)
	if err != nil {
		return err
	}
	_, _ = fmt.Fprintf(stdout, "Initialized %s\n", result.Workspace)
	for _, created := range result.Created {
		_, _ = fmt.Fprintf(stdout, "  created %s\n", created)
	}
	_, _ = fmt.Fprintln(stdout, "\nNext: run 'termigo mcp add <name> <command>' to register an MCP server,")
	_, _ = fmt.Fprintln(stdout, "or add skills under .termigo/skills/<name>/SKILL.md.")
	return nil
}

func runAgent(args []string, stdout, stderr io.Writer) error {
	workspace, rest, err := workspaceFromArgs(args)
	if err != nil {
		return err
	}
	if len(rest) == 0 || rest[0] == "help" || rest[0] == "--help" || rest[0] == "-h" {
		_, _ = fmt.Fprintln(stdout, `Usage:
  termigo agent list
  termigo agent run <provider> [flags] "task"
  termigo agent <provider> [flags] "task"      (shorthand)

Flags:
  --access <read-only|workspace-write>  Sandbox for the run (default: read-only)
  --model <name>                        Override the provider model
  --endpoint <url>                      Override a local endpoint (ollama)
  --timeout <seconds>                   Limit the whole run
  -w, --workspace <dir>                 Workspace directory`)
		return nil
	}

	switch rest[0] {
	case "list", "status":
		return printAgentList(stdout)
	case "run":
		rest = rest[1:]
	}

	providerID := rest[0]
	rest = rest[1:]

	options := agent.RunOptions{Workspace: currentWorkspace(workspace), Access: "read-only"}
	var promptParts []string
	for index := 0; index < len(rest); index++ {
		arg := rest[index]
		switch {
		case arg == "--access":
			if index+1 >= len(rest) {
				return errors.New("--access requires a value")
			}
			index++
			options.Access = rest[index]
		case strings.HasPrefix(arg, "--access="):
			options.Access = strings.TrimPrefix(arg, "--access=")
		case arg == "--model":
			if index+1 >= len(rest) {
				return errors.New("--model requires a value")
			}
			index++
			options.Model = rest[index]
		case strings.HasPrefix(arg, "--model="):
			options.Model = strings.TrimPrefix(arg, "--model=")
		case arg == "--endpoint":
			if index+1 >= len(rest) {
				return errors.New("--endpoint requires a value")
			}
			index++
			options.Endpoint = rest[index]
		case strings.HasPrefix(arg, "--endpoint="):
			options.Endpoint = strings.TrimPrefix(arg, "--endpoint=")
		case arg == "--timeout":
			if index+1 >= len(rest) {
				return errors.New("--timeout requires seconds")
			}
			index++
			seconds, err := strconv.Atoi(rest[index])
			if err != nil {
				return fmt.Errorf("invalid timeout %q", rest[index])
			}
			options.Timeout = time.Duration(seconds) * time.Second
		default:
			promptParts = append(promptParts, arg)
		}
	}
	options.Prompt = strings.Join(promptParts, " ")
	if options.Access != "read-only" && options.Access != "workspace-write" {
		return fmt.Errorf("invalid access mode %q (use read-only or workspace-write)", options.Access)
	}

	userConfig, err := config.Load()
	if err != nil {
		return err
	}
	options = agent.ResolveOptions(options, providerID, userConfig)

	ctx := context.Background()
	var cancel context.CancelFunc
	if options.Timeout > 0 {
		ctx, cancel = context.WithTimeout(ctx, options.Timeout)
		defer cancel()
	}
	_, _ = fmt.Fprintf(stdout, "termigo agent: %s -> %s (access: %s)\n", providerID, options.Workspace, options.Access)
	if err := agent.Run(ctx, providerID, options, stdout, stderr); err != nil {
		return err
	}
	_, _ = fmt.Fprintln(stdout, "\ntermigo agent: done.")
	return nil
}

func printAgentList(stdout io.Writer) error {
	statuses := agent.Detect()
	encoder := json.NewEncoder(stdout)
	encoder.SetIndent("", "  ")
	return encoder.Encode(statuses)
}

func runSkill(args []string, stdout io.Writer) error {
	workspace, rest, err := workspaceFromArgs(args)
	if err != nil {
		return err
	}
	workspace = currentWorkspace(workspace)
	if len(rest) == 0 || rest[0] == "help" || rest[0] == "--help" || rest[0] == "-h" {
		_, _ = fmt.Fprintln(stdout, `Usage:
  termigo skill list [--json]
  termigo skill show <name>
  termigo skill create <name> [description]
  -w, --workspace <dir>   Workspace directory`)
		return nil
	}

	switch rest[0] {
	case "list":
		jsonOutput := false
		for _, arg := range rest[1:] {
			if arg == "--json" {
				jsonOutput = true
			}
		}
		skills, err := skill.Discover(workspace)
		if err != nil {
			return err
		}
		if jsonOutput {
			encoder := json.NewEncoder(stdout)
			encoder.SetIndent("", "  ")
			return encoder.Encode(skills)
		}
		_, _ = fmt.Fprintf(stdout, "Skills for %s\n", workspace)
		if len(skills) == 0 {
			_, _ = fmt.Fprintln(stdout, "  (none - create one with 'termigo skill create <name>')")
			return nil
		}
		for _, found := range skills {
			_, _ = fmt.Fprintf(stdout, "  %-20s [%s] %s\n", found.Name, found.Scope, found.Description)
		}
		return nil

	case "show":
		if len(rest) < 2 {
			return errors.New("usage: termigo skill show <name>")
		}
		found, err := skill.Load(workspace, rest[1])
		if err != nil {
			return err
		}
		_, _ = fmt.Fprintf(stdout, "# %s (%s)\n\n%s\n\n%s\n", found.Name, found.Scope, found.Description, found.Body)
		if len(found.Files) > 0 {
			_, _ = fmt.Fprintf(stdout, "\nFiles: %s\n", strings.Join(found.Files, ", "))
		}
		return nil

	case "create":
		if len(rest) < 2 {
			return errors.New("usage: termigo skill create <name> [description]")
		}
		description := "A Termigo skill."
		if len(rest) > 2 {
			description = strings.Join(rest[2:], " ")
		}
		created, err := skill.Create(workspace, rest[1], description)
		if err != nil {
			return err
		}
		_, _ = fmt.Fprintf(stdout, "Created skill %q at %s\n", created.Name, created.Path)
		return nil

	default:
		return fmt.Errorf("unknown skill command %q", rest[0])
	}
}

func runMCP(args []string, stdout io.Writer) error {
	workspace, rest, err := workspaceFromArgs(args)
	if err != nil {
		return err
	}
	workspace = currentWorkspace(workspace)
	if len(rest) == 0 || rest[0] == "help" || rest[0] == "--help" || rest[0] == "-h" {
		_, _ = fmt.Fprintln(stdout, `Usage:
  termigo mcp list [--json]
  termigo mcp tools [server] [--json]
  termigo mcp call <server> <tool> [key=value ...]
  termigo mcp add <name> <command> [args ...]
  termigo mcp remove <name>
  termigo mcp ping <server>
  -w, --workspace <dir>   Workspace directory`)
		return nil
	}

	switch rest[0] {
	case "list":
		jsonOutput := false
		for _, arg := range rest[1:] {
			if arg == "--json" {
				jsonOutput = true
			}
		}
		registry, err := mcp.Load(workspace)
		if err != nil {
			return err
		}
		if jsonOutput {
			encoder := json.NewEncoder(stdout)
			encoder.SetIndent("", "  ")
			return encoder.Encode(registry)
		}
		_, err = fmt.Fprintln(stdout, strings.TrimSuffix(mcp.FormatRegistry(registry), "\n"))
		return err

	case "tools":
		jsonOutput := false
		filter := ""
		for _, arg := range rest[1:] {
			switch {
			case arg == "--json":
				jsonOutput = true
			case strings.HasPrefix(arg, "-"):
				return fmt.Errorf("unknown mcp tools option %q", arg)
			case filter == "":
				filter = arg
			}
		}
		return listMCPServers(ctxForCLI(), workspace, filter, jsonOutput, stdout)

	case "ping":
		if len(rest) < 2 {
			return errors.New("usage: termigo mcp ping <server>")
		}
		return pingMCPServer(ctxForCLI(), workspace, rest[1], stdout)

	case "call":
		if len(rest) < 3 {
			return errors.New("usage: termigo mcp call <server> <tool> [key=value ...]")
		}
		return callMCPTool(ctxForCLI(), workspace, rest[1], rest[2], rest[3:], stdout)

	case "add":
		if len(rest) < 3 {
			return errors.New("usage: termigo mcp add <name> <command> [args ...]")
		}
		server := config.MCPServer{Command: rest[2], Args: rest[3:]}
		added, err := mcp.Add(workspace, rest[1], server)
		if err != nil {
			return err
		}
		_, _ = fmt.Fprintf(stdout, "Added MCP server %q -> %s %s\n", added.Name, added.Command, strings.Join(added.Args, " "))
		return nil

	case "remove", "rm":
		if len(rest) < 2 {
			return errors.New("usage: termigo mcp remove <name>")
		}
		if err := mcp.Remove(workspace, rest[1]); err != nil {
			return err
		}
		_, _ = fmt.Fprintf(stdout, "Removed MCP server %q\n", rest[1])
		return nil

	default:
		return fmt.Errorf("unknown mcp command %q", rest[0])
	}
}

func ctxForCLI() context.Context {
	return context.Background()
}

func listMCPServers(ctx context.Context, workspace, filter string, jsonOutput bool, stdout io.Writer) error {
	registry, err := mcp.Load(workspace)
	if err != nil {
		return err
	}
	results := make([]map[string]any, 0)
	for _, server := range registry.Servers {
		if filter != "" && server.Name != filter {
			continue
		}
		tools, err := serverTools(ctx, server)
		if err != nil {
			return fmt.Errorf("%s: %w", server.Name, err)
		}
		results = append(results, map[string]any{
			"server": server.Name,
			"scope":  server.Scope,
			"tools":  tools,
		})
	}
	if jsonOutput {
		encoder := json.NewEncoder(stdout)
		encoder.SetIndent("", "  ")
		return encoder.Encode(results)
	}
	for _, result := range results {
		_, _ = fmt.Fprintf(stdout, "%s\n", result["server"])
		for _, tool := range result["tools"].([]mcp.Tool) {
			_, _ = fmt.Fprintf(stdout, "  %s\n", tool.Name)
		}
	}
	return nil
}

func serverTools(ctx context.Context, server mcp.Server) ([]mcp.Tool, error) {
	client, err := mcp.Connect(ctx, server)
	if err != nil {
		return nil, err
	}
	defer client.Close()
	tools, err := client.ListTools(ctx)
	if err != nil {
		return nil, err
	}
	for index := range tools {
		tools[index].Server = server.Name
	}
	return tools, nil
}

func pingMCPServer(ctx context.Context, workspace, name string, stdout io.Writer) error {
	registry, err := mcp.Load(workspace)
	if err != nil {
		return err
	}
	server, err := findServer(registry, name)
	if err != nil {
		return err
	}
	client, err := mcp.Connect(ctx, server)
	if err != nil {
		return err
	}
	defer client.Close()
	if err := client.Ping(ctx); err != nil {
		return fmt.Errorf("%s did not respond: %w", name, err)
	}
	_, err = fmt.Fprintf(stdout, "%s is responding.\n", name)
	return err
}

func callMCPTool(ctx context.Context, workspace, serverName, toolName string, pairs []string, stdout io.Writer) error {
	registry, err := mcp.Load(workspace)
	if err != nil {
		return err
	}
	server, err := findServer(registry, serverName)
	if err != nil {
		return err
	}
	arguments := map[string]any{}
	for _, pair := range pairs {
		key, value, ok := strings.Cut(pair, "=")
		if !ok {
			return fmt.Errorf("tool arguments must be key=value, got %q", pair)
		}
		arguments[key] = value
	}
	client, err := mcp.Connect(ctx, server)
	if err != nil {
		return err
	}
	defer client.Close()
	call, err := client.CallTool(ctx, toolName, arguments)
	if err != nil {
		return err
	}
	if call.IsError {
		_, _ = fmt.Fprintln(stdout, call.Text)
		return fmt.Errorf("%s returned an error result", toolName)
	}
	_, err = fmt.Fprintln(stdout, call.Text)
	return err
}

func findServer(registry mcp.Registry, name string) (mcp.Server, error) {
	for _, server := range registry.Servers {
		if server.Name == name {
			return server, nil
		}
	}
	return mcp.Server{}, fmt.Errorf("MCP server %q not found (see 'termigo mcp list')", name)
}

func runConfig(args []string, stdout io.Writer) error {
	userConfig, path, err := config.Open()
	if err != nil {
		return err
	}
	if len(args) == 0 || args[0] == "show" {
		_, _ = fmt.Fprintf(stdout, "Config file: %s\n", path)
		encoder := json.NewEncoder(stdout)
		encoder.SetIndent("", "  ")
		return encoder.Encode(userConfig)
	}

	switch args[0] {
	case "set":
		if len(args) < 3 {
			return errors.New("usage: termigo config set <key> <value>")
		}
		key, value := args[1], args[2]
		switch key {
		case "defaultAgent":
			if _, err := agent.Find(value); err != nil {
				return err
			}
			userConfig.DefaultAgent = value
		default:
			return fmt.Errorf("unknown config key %q (supported: defaultAgent)", key)
		}
		if err := config.Save(userConfig); err != nil {
			return err
		}
		_, _ = fmt.Fprintf(stdout, "Set %s = %s in %s\n", key, value, path)
		return nil

	case "provider":
		if len(args) < 4 {
			return errors.New("usage: termigo config provider <id> <key> <value> (keys: command, model, endpoint)")
		}
		id, key, value := args[1], args[2], args[3]
		if _, err := agent.Find(id); err != nil {
			return err
		}
		if userConfig.Providers == nil {
			userConfig.Providers = map[string]config.ProviderOptions{}
		}
		options := userConfig.Providers[id]
		switch key {
		case "command":
			options.Command = value
		case "model":
			options.Model = value
		case "endpoint":
			options.Endpoint = value
		default:
			return fmt.Errorf("unknown provider key %q (supported: command, model, endpoint)", key)
		}
		userConfig.Providers[id] = options
		if err := config.Save(userConfig); err != nil {
			return err
		}
		_, _ = fmt.Fprintf(stdout, "Set provider %s %s = %s in %s\n", id, key, value, path)
		return nil

	default:
		return fmt.Errorf("unknown config command %q", args[0])
	}
}
