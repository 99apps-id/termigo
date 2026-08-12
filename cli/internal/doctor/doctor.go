// Package doctor reports the local tools that Termigo can integrate with.
package doctor

import (
	"os/exec"
	"runtime"
	"strings"
)

// Report is safe to print or serialize. It deliberately contains no keys,
// account identifiers, environment variables, or workspace paths.
type Report struct {
	OS    string `json:"os"`
	Arch  string `json:"arch"`
	Tools []Tool `json:"tools"`
}

// Tool describes one executable that can be used by Termigo.
type Tool struct {
	Name      string `json:"name"`
	Command   string `json:"command"`
	Available bool   `json:"available"`
	Version   string `json:"version,omitempty"`
}

type target struct {
	name            string
	command         string
	versionArgument string
}

var targets = []target{
	{name: "Rust", command: "rustc", versionArgument: "--version"},
	{name: "Cargo", command: "cargo", versionArgument: "--version"},
	{name: "Node.js", command: "node", versionArgument: "--version"},
	{name: "npm", command: "npm", versionArgument: "--version"},
	{name: "Git", command: "git", versionArgument: "--version"},
	{name: "Codex CLI", command: "codex", versionArgument: "--version"},
	{name: "Claude Code", command: "claude", versionArgument: "--version"},
	{name: "Gemini CLI", command: "gemini", versionArgument: "--version"},
	{name: "Antigravity", command: "antigravity", versionArgument: "--version"},
	{name: "Ollama", command: "ollama", versionArgument: "--version"},
	{name: "MCP runtime", command: "npx", versionArgument: "--version"},
	{name: "uv", command: "uv", versionArgument: "--version"},
}

// Inspect checks executable availability and a version string, if available.
func Inspect() Report {
	report := Report{OS: runtime.GOOS, Arch: runtime.GOARCH, Tools: make([]Tool, 0, len(targets))}
	for _, target := range targets {
		tool := Tool{Name: target.name, Command: target.command}
		path, err := exec.LookPath(target.command)
		if err != nil {
			report.Tools = append(report.Tools, tool)
			continue
		}

		tool.Available = true
		output, err := exec.Command(path, target.versionArgument).CombinedOutput()
		if err == nil {
			tool.Version = trimVersion(string(output))
		}
		report.Tools = append(report.Tools, tool)
	}
	return report
}

func trimVersion(value string) string {
	value = strings.TrimSpace(value)
	if len(value) > 120 {
		return value[:120] + "..."
	}
	return value
}
