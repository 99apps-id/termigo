// Package initcmd scaffolds the Termigo workspace layout:
//
//	<workspace>/
//	├── .termigo/
//	│   ├── mcp.json          MCP server registry (optional)
//	│   └── skills/           project-scoped skills (optional)
//	└── TERMIGO.md            project memory for agents (optional)
package initcmd

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Result describes what init created or updated.
type Result struct {
	Workspace string   `json:"workspace"`
	Created   []string `json:"created"`
}

// Run scaffolds the workspace and returns the created paths.
func Run(workspace string) (Result, error) {
	if workspace == "" {
		workspace, _ = os.Getwd()
	}
	workspace, err := filepath.Abs(workspace)
	if err != nil {
		return Result{}, fmt.Errorf("resolve workspace: %w", err)
	}
	info, err := os.Stat(workspace)
	if err != nil || !info.IsDir() {
		return Result{}, fmt.Errorf("workspace %s is not a directory", workspace)
	}

	result := Result{Workspace: workspace}
	create := func(path, content string) (string, error) {
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			return "", err
		}
		return path, nil
	}

	skillsDir := filepath.Join(workspace, ".termigo", "skills")
	if err := os.MkdirAll(skillsDir, 0o755); err != nil {
		return Result{}, fmt.Errorf("create .termigo/skills: %w", err)
	}

	mcpPath := filepath.Join(workspace, ".termigo", "mcp.json")
	if _, err := os.Stat(mcpPath); os.IsNotExist(err) {
		if created, err := create(mcpPath, mcpTemplate); err != nil {
			return Result{}, err
		} else {
			result.Created = append(result.Created, created)
		}
	}

	skillsReadme := filepath.Join(skillsDir, "README.md")
	if _, err := os.Stat(skillsReadme); os.IsNotExist(err) {
		if created, err := create(skillsReadme, skillsReadmeContent); err != nil {
			return Result{}, err
		} else {
			result.Created = append(result.Created, created)
		}
	}

	memoryPath := filepath.Join(workspace, "TERMIGO.md")
	if _, err := os.Stat(memoryPath); os.IsNotExist(err) {
		projectName := filepath.Base(workspace)
		if created, err := create(memoryPath, memoryTemplate(projectName)); err != nil {
			return Result{}, err
		} else {
			result.Created = append(result.Created, created)
		}
	}

	if len(result.Created) == 0 {
		result.Created = append(result.Created, "(already initialized)")
	}
	return result, nil
}

const mcpTemplate = `{
  "mcpServers": {
    "example": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-everything", "."]
    }
  }
}
`

const skillsReadmeContent = `# Project skills

Add one folder per skill, each with a SKILL.md file:

    skills/
    └── review/
        └── SKILL.md

SKILL.md starts with YAML frontmatter (name, description) followed by
Markdown instructions for the agent. Optional helper scripts live next to
SKILL.md. See docs/SKILLS.md in the Termigo repository.
`

func memoryTemplate(projectName string) string {
	return strings.TrimSpace(fmt.Sprintf(`# %s

Project memory for coding agents working in this workspace.

## Project

- Purpose: (describe the project)
- Stack: (languages, frameworks, build commands)

## Conventions

- Build: (command)
- Test: (command)
- Lint: (command)

## Workspace notes

- Commands that must never be run here:
- Files or folders to be careful with:
`, projectName)) + "\n"
}
