package provider

import (
	"regexp"
	"testing"
)

var anthropicToolNamePattern = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,128}$`)

// TestCloakClaudeToolsSanitizesNamesAnthropicRejects pins the live-verified
// 400: a tool name with a dot or slash (an MCP name such as mcp/files.read)
// fails Anthropic's name pattern, so cloaking must sanitize, not only suffix.
func TestCloakClaudeToolsSanitizesNamesAnthropicRejects(t *testing.T) {
	tools := []map[string]any{
		{"name": "mcp/files.read", "description": "Read via MCP."},
		{"name": "mcp files.read", "description": "Collides after sanitizing."},
		{"name": "read_file", "description": "Plain name."},
	}
	cloaked, aliases := cloakClaudeTools(tools)
	seen := map[string]bool{}
	for _, tool := range cloaked {
		name, _ := tool["name"].(string)
		if !anthropicToolNamePattern.MatchString(name) {
			t.Errorf("cloaked tool name %q fails Anthropic's pattern", name)
		}
		if seen[name] {
			t.Errorf("cloaked tool name %q is duplicated", name)
		}
		seen[name] = true
	}
	if aliases["mcp_files_read_ide"] != "mcp/files.read" {
		t.Errorf("aliases = %v, want mcp_files_read_ide back to mcp/files.read", aliases)
	}

	messages := []map[string]any{
		{"role": "assistant", "content": []map[string]any{
			{"type": "tool_use", "id": "tu_1", "name": "mcp/files.read"},
		}},
	}
	cloakClaudeMessages(messages, aliases)
	blocks := messages[0]["content"].([]map[string]any)
	if got := blocks[0]["name"]; got != "mcp_files_read_ide" {
		t.Errorf("history tool_use name = %v, want mcp_files_read_ide", got)
	}
}
