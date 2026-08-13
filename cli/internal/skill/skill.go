// Package skill discovers and manages Termigo skills.
//
// A skill is a folder containing a SKILL.md file with YAML frontmatter and,
// optionally, helper scripts. Skills are project-scoped when stored under
// <workspace>/.termigo/skills/<name>/SKILL.md and user-scoped when stored
// under <termigo-home>/skills/<name>/SKILL.md.
//
// Format:
//
//	---
//	name: review
//	description: Review the current change set for correctness and style.
//	---
//
//	Instructions for the agent, in Markdown.
//
// The description doubles as the agent-facing summary and must be short
// enough to fit into a system prompt.
package skill

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

// Skill describes one discovered skill.
type Skill struct {
	// Name is the skill id, derived from the folder name unless frontmatter
	// overrides it.
	Name string `json:"name"`
	// Description is the short agent-facing summary.
	Description string `json:"description"`
	// Path is the skill folder.
	Path string `json:"path"`
	// Body is the Markdown instruction content (frontmatter removed).
	Body string `json:"body,omitempty"`
	// Files lists helper files inside the skill folder.
	Files []string `json:"files,omitempty"`
	// Scope is "project" or "user".
	Scope string `json:"scope"`
}

// Frontmatter is the YAML header of a SKILL.md file.
type Frontmatter struct {
	Name        string `yaml:"name"`
	Description string `yaml:"description"`
}

const frontmatterDelimiter = "---"

// Discover returns skills found in the workspace and the user home,
// sorted by name. Missing folders are not an error.
func Discover(workspace string) ([]Skill, error) {
	var skills []Skill
	if workspace != "" {
		project, err := fromFolder(filepath.Join(workspace, ".termigo", "skills"), "project")
		if err != nil {
			return nil, err
		}
		skills = append(skills, project...)
	}
	user, err := userSkills()
	if err != nil {
		return nil, err
	}
	skills = append(skills, user...)

	sort.SliceStable(skills, func(i, j int) bool {
		return strings.ToLower(skills[i].Name) < strings.ToLower(skills[j].Name)
	})
	return skills, nil
}

// Load returns one skill by name from either scope.
func Load(workspace, name string) (Skill, error) {
	skills, err := Discover(workspace)
	if err != nil {
		return Skill{}, err
	}
	for _, candidate := range skills {
		if strings.EqualFold(candidate.Name, name) {
			return candidate, nil
		}
	}
	return Skill{}, fmt.Errorf("skill %q not found (looked in the workspace and %s)", name, userSkillsDir())
}

// Create scaffolds a new project-scoped skill in <workspace>/.termigo/skills.
func Create(workspace, name, description string) (Skill, error) {
	if workspace == "" {
		return Skill{}, errors.New("a workspace is required to create a project skill")
	}
	if strings.ContainsAny(name, `/\`) {
		return Skill{}, errors.New("skill name must be a single folder name")
	}
	name = normalizeName(name)
	if name == "" {
		return Skill{}, errors.New("skill name must not be empty")
	}
	if description == "" {
		description = "A Termigo skill."
	}

	// Check for a conflict before creating anything, so a rejected create does
	// not leave an empty skill folder behind.
	dir := filepath.Join(workspace, ".termigo", "skills", name)
	document := filepath.Join(dir, "SKILL.md")
	if _, err := os.Stat(document); err == nil {
		return Skill{}, fmt.Errorf("skill %q already exists at %s", name, document)
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return Skill{}, fmt.Errorf("create skill folder: %w", err)
	}

	content := fmt.Sprintf(`---
name: %s
description: %s
---

# %s

Instructions for the agent. Keep them concrete: when to use this skill,
what to inspect, and what output is expected.
`, name, description, name)
	if err := os.WriteFile(document, []byte(content), 0o644); err != nil {
		return Skill{}, fmt.Errorf("write SKILL.md: %w", err)
	}
	return Load(workspace, name)
}

// normalizeName keeps a lowercase, hyphenated identifier.
func normalizeName(name string) string {
	name = strings.TrimSpace(strings.ToLower(name))
	var builder strings.Builder
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '-', r == '_':
			builder.WriteRune(r)
		case r == ' ':
			builder.WriteRune('-')
		}
	}
	return builder.String()
}

// fromFolder reads skills from one skills root.
func fromFolder(root, scope string) ([]Skill, error) {
	entries, err := os.ReadDir(root)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read skills folder %s: %w", root, err)
	}
	skills := make([]Skill, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		document := filepath.Join(root, entry.Name(), "SKILL.md")
		data, err := os.ReadFile(document)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, fmt.Errorf("read %s: %w", document, err)
		}
		parsed, body, err := Parse(data)
		if err != nil {
			return nil, fmt.Errorf("parse %s: %w", document, err)
		}
		name := parsed.Name
		if name == "" {
			name = entry.Name()
		}
		skills = append(skills, Skill{
			Name:        name,
			Description: parsed.Description,
			Path:        filepath.Join(root, entry.Name()),
			Body:        body,
			Files:       helperFiles(filepath.Join(root, entry.Name())),
			Scope:       scope,
		})
	}
	return skills, nil
}

// Parse splits a SKILL.md document into frontmatter and body.
func Parse(data []byte) (Frontmatter, string, error) {
	lines := strings.Split(string(data), "\n")
	if len(lines) < 3 || strings.TrimSpace(lines[0]) != frontmatterDelimiter {
		// No frontmatter: treat the whole document as the body.
		return Frontmatter{}, string(data), nil
	}
	end := -1
	for index := 1; index < len(lines); index++ {
		if strings.TrimSpace(lines[index]) == frontmatterDelimiter {
			end = index
			break
		}
	}
	if end < 0 {
		return Frontmatter{}, string(data), nil
	}
	var meta Frontmatter
	if err := yaml.Unmarshal([]byte(strings.Join(lines[1:end], "\n")), &meta); err != nil {
		return Frontmatter{}, "", fmt.Errorf("invalid YAML frontmatter: %w", err)
	}
	body := strings.Join(lines[end+1:], "\n")
	return meta, strings.TrimSpace(body), nil
}

// helperFiles lists non-SKILL.md files inside a skill folder.
func helperFiles(dir string) []string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var files []string
	for _, entry := range entries {
		if entry.IsDir() || entry.Name() == "SKILL.md" {
			continue
		}
		files = append(files, entry.Name())
	}
	sort.Strings(files)
	return files
}

func userSkills() ([]Skill, error) {
	return fromFolder(userSkillsDir(), "user")
}

func userSkillsDir() string {
	home := os.Getenv("TERMIGO_HOME")
	if home == "" {
		if base, err := os.UserHomeDir(); err == nil {
			home = filepath.Join(base, ".termigo")
		}
	}
	if home == "" {
		return ".termigo/skills"
	}
	return filepath.Join(home, "skills")
}
