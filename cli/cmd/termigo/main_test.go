package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestRunHelp(t *testing.T) {
	var output bytes.Buffer
	if err := run(nil, &output, &bytes.Buffer{}); err != nil {
		t.Fatalf("run returned an error: %v", err)
	}
	if !strings.Contains(output.String(), "Termigo CLI") {
		t.Fatalf("help did not include the CLI name: %q", output.String())
	}
}

func TestRunVersion(t *testing.T) {
	var output bytes.Buffer
	if err := run([]string{"version"}, &output, &bytes.Buffer{}); err != nil {
		t.Fatalf("run returned an error: %v", err)
	}
	if !strings.Contains(output.String(), "termigo") {
		t.Fatalf("version did not include the executable name: %q", output.String())
	}
}

func TestRunRejectsUnknownCommand(t *testing.T) {
	if err := run([]string{"unknown"}, &bytes.Buffer{}, &bytes.Buffer{}); err == nil {
		t.Fatal("run accepted an unknown command")
	}
}

func TestWorkspaceFlagParsing(t *testing.T) {
	workspace, rest, err := workspaceFromArgs([]string{"list", "-w", "C:/work", "--json"})
	if err != nil {
		t.Fatalf("workspaceFromArgs returned an error: %v", err)
	}
	if workspace != "C:/work" {
		t.Fatalf("workspace = %q, want C:/work", workspace)
	}
	if len(rest) != 2 || rest[0] != "list" || rest[1] != "--json" {
		t.Fatalf("rest = %v, want [list --json]", rest)
	}

	workspace, rest, err = workspaceFromArgs([]string{"--workspace=other", "show"})
	if err != nil {
		t.Fatalf("workspaceFromArgs returned an error: %v", err)
	}
	if workspace != "other" || len(rest) != 1 || rest[0] != "show" {
		t.Fatalf("got workspace=%q rest=%v", workspace, rest)
	}
}

func TestSkillCreateThenList(t *testing.T) {
	workspace := t.TempDir()
	var output bytes.Buffer
	if err := run([]string{"skill", "create", "code-review", "Review pull request diffs", "-w", workspace}, &output, &bytes.Buffer{}); err != nil {
		t.Fatalf("skill create failed: %v\n%s", err, output.String())
	}
	output.Reset()
	if err := run([]string{"skill", "list", "-w", workspace}, &output, &bytes.Buffer{}); err != nil {
		t.Fatalf("skill list failed: %v", err)
	}
	if !strings.Contains(output.String(), "code-review") {
		t.Fatalf("skill list did not include created skill: %q", output.String())
	}
	output.Reset()
	if err := run([]string{"skill", "show", "code-review", "-w", workspace}, &output, &bytes.Buffer{}); err != nil {
		t.Fatalf("skill show failed: %v", err)
	}
	if !strings.Contains(output.String(), "Review pull request diffs") {
		t.Fatalf("skill show did not include the description: %q", output.String())
	}
}
