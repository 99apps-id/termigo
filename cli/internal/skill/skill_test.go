package skill

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseFrontmatter(t *testing.T) {
	data := []byte("---\nname: review\ndescription: Review the change set.\n---\n\nDo the review.\n")
	meta, body, err := Parse(data)
	if err != nil {
		t.Fatalf("Parse returned an error: %v", err)
	}
	if meta.Name != "review" || meta.Description != "Review the change set." {
		t.Fatalf("unexpected frontmatter: %+v", meta)
	}
	if !strings.Contains(body, "Do the review.") {
		t.Fatalf("body missing content: %q", body)
	}
}

func TestParseWithoutFrontmatter(t *testing.T) {
	meta, body, err := Parse([]byte("just instructions"))
	if err != nil {
		t.Fatalf("Parse returned an error: %v", err)
	}
	if meta.Name != "" {
		t.Fatalf("unexpected frontmatter: %+v", meta)
	}
	if body != "just instructions" {
		t.Fatalf("body = %q", body)
	}
}

func TestParseInvalidFrontmatter(t *testing.T) {
	if _, _, err := Parse([]byte("---\nname: [unclosed\n---\n")); err == nil {
		t.Fatal("Parse accepted invalid YAML frontmatter")
	}
}

func TestCreateAndDiscover(t *testing.T) {
	workspace := t.TempDir()
	home := filepath.Join(t.TempDir(), "termigo-home")
	t.Setenv("TERMIGO_HOME", home)

	created, err := Create(workspace, "Code Review", "Review diffs before commit.")
	if err != nil {
		t.Fatalf("Create failed: %v", err)
	}
	if created.Name != "code-review" {
		t.Fatalf("normalized name = %q, want code-review", created.Name)
	}
	if created.Scope != "project" {
		t.Fatalf("scope = %q, want project", created.Scope)
	}
	if !filepath.IsAbs(created.Path) {
		t.Fatalf("path not absolute: %q", created.Path)
	}

	// A user-level skill should be discovered too.
	userSkill := filepath.Join(home, "skills", "commit", "SKILL.md")
	if err := os.MkdirAll(filepath.Dir(userSkill), 0o755); err != nil {
		t.Fatal(err)
	}
	userContent := "---\nname: commit\ndescription: Write conventional commit messages.\n---\n\nUse conventional commits.\n"
	if err := os.WriteFile(userSkill, []byte(userContent), 0o644); err != nil {
		t.Fatal(err)
	}

	skills, err := Discover(workspace)
	if err != nil {
		t.Fatalf("Discover failed: %v", err)
	}
	if len(skills) != 2 {
		t.Fatalf("discovered %d skills, want 2", len(skills))
	}
	if skills[0].Name != "code-review" || skills[1].Name != "commit" {
		t.Fatalf("unexpected order: %v, %v", skills[0].Name, skills[1].Name)
	}
	if skills[1].Scope != "user" {
		t.Fatalf("user skill scope = %q", skills[1].Scope)
	}
}

func TestLoadMissingSkill(t *testing.T) {
	workspace := t.TempDir()
	if _, err := Load(workspace, "missing"); err == nil {
		t.Fatal("Load accepted a missing skill")
	}
}

func TestCreateRejectsInvalidNames(t *testing.T) {
	workspace := t.TempDir()
	if _, err := Create(workspace, "bad/name", ""); err == nil {
		t.Fatal("Create accepted a name containing a path separator")
	}
	if _, err := Create("", "ok", ""); err == nil {
		t.Fatal("Create accepted an empty workspace")
	}
}
