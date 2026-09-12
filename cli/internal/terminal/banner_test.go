package terminal

import (
	"strings"
	"testing"

	"github.com/99apps-id/termigo/cli/internal/control"
)

func TestBannerIsRectangularPrintableASCII(t *testing.T) {
	rows := bannerRows()
	if len(rows) != 5 {
		t.Fatalf("expected a 5-row wordmark, got %d rows", len(rows))
	}
	width := len(rows[0])
	for index, row := range rows {
		if len(row) != width {
			t.Fatalf("row %d is %d wide, row 0 is %d: the art is sheared", index, len(row), width)
		}
		for _, char := range row {
			if char < 0x20 || char > 0x7e {
				t.Fatalf("row %d holds a non-ASCII character %q, which a legacy console cannot render", index, char)
			}
		}
	}

	// The printed form drops the blank columns on the right and nothing else.
	printed := strings.Split(Banner(), "\n")
	if len(printed) != len(rows) {
		t.Fatalf("Banner printed %d rows for %d glyph rows", len(printed), len(rows))
	}
	for index, line := range printed {
		if strings.HasSuffix(line, " ") {
			t.Fatalf("printed row %d keeps a trailing space", index)
		}
		if !strings.HasPrefix(rows[index], line) {
			t.Fatalf("printed row %d is not the glyph row with its trailing blanks removed: %q vs %q", index, line, rows[index])
		}
	}
}

// TestBannerGlyphsMatchTheWordmark keeps the art and the word it is supposed to
// spell from drifting apart: a glyph added or removed would make the mark
// meaningless, and nothing else in the program would notice.
func TestBannerGlyphsMatchTheWordmark(t *testing.T) {
	if len(bannerGlyphs) != len(bannerWord) {
		t.Fatalf("%d glyphs for %q", len(bannerGlyphs), bannerWord)
	}
	for index, glyph := range bannerGlyphs {
		first := len(glyph[0])
		for row, line := range glyph {
			if len(line) != first {
				t.Fatalf("glyph %d (%c) row %d is %d wide, not %d", index, bannerWord[index], row, len(line), first)
			}
		}
	}
}

func TestBannerStartsWithTheFirstLetter(t *testing.T) {
	// The leading column belongs to T; trimming it would shear the art, so the
	// first row must keep its one leading space.
	if !strings.HasPrefix(Banner(), " _____  _____") {
		t.Fatalf("unexpected first row: %q", strings.Split(Banner(), "\n")[0])
	}
}

func TestNestedString(t *testing.T) {
	payload := map[string]interface{}{
		"app_version": "0.9.3",
		"ui": map[string]interface{}{
			"agent": map[string]interface{}{"status": "thinking", "step": nil},
			"model": map[string]interface{}{"id": "deepseek-v4-pro"},
		},
	}
	cases := []struct{ path, want string }{
		{"app_version", "0.9.3"},
		{"ui.agent.status", "thinking"},
		{"ui.model.id", "deepseek-v4-pro"},
		{"ui.agent.step", ""},
		{"ui.missing.status", ""},
		{"app_version.deeper", ""},
	}
	for _, tc := range cases {
		if got := nestedString(payload, tc.path); got != tc.want {
			t.Errorf("nestedString(%q) = %q, want %q", tc.path, got, tc.want)
		}
	}
}

func TestSettingsValueCoversEverySetting(t *testing.T) {
	view := &control.SettingsView{
		Settings: control.Settings{
			DefaultModelID:     "",
			ToolSearchEnabled:  true,
			DisabledToolGroups: nil,
			AgentApprovalMode:  "ask",
			Language:           "en",
		},
	}
	// Every key the list prints has to answer something, or the settings screen
	// would show a blank line the operator cannot explain.
	for _, key := range settingsOrder {
		if value := settingsValue(view, key); strings.TrimSpace(value) == "" {
			t.Errorf("settingsValue(%q) is blank", key)
		}
	}
	if got := settingsValue(view, "defaultModelId"); got != "not set" {
		t.Errorf("an unset model should read 'not set', got %q", got)
	}
	if got := settingsValue(view, "disabledToolGroups"); got != "none" {
		t.Errorf("no disabled groups should read 'none', got %q", got)
	}
}

func TestFormatSettingValueMatchesTheSettingsList(t *testing.T) {
	// The change confirmation and the settings list have to agree, which is why
	// both go through the same shared formatter.
	cases := []struct {
		value interface{}
		want  string
	}{
		{[]string{"browser", "sql"}, "browser, sql"},
		{[]string{}, "none"},
		{[]interface{}{"browser", "sql"}, "browser, sql"},
		{[]interface{}{}, "none"},
		{true, "true"},
		{false, "false"},
		{"deepseek-v4-pro", "deepseek-v4-pro"},
	}
	for _, tc := range cases {
		if got := control.FormatSettingValue(tc.value); got != tc.want {
			t.Errorf("FormatSettingValue(%v) = %q, want %q", tc.value, got, tc.want)
		}
	}
}

func TestModelLabelsMarkTheCurrentModel(t *testing.T) {
	labels := modelLabels([]control.Model{
		{ID: "deepseek-v4-pro", Label: "DeepSeek V4 Pro"},
		{ID: "deepseek-v4-flash", Label: "Flash", APIModelID: "deepseek-flash"},
	}, "deepseek-v4-flash")
	if !strings.Contains(labels[0], "DeepSeek V4 Pro") || strings.Contains(labels[0], "[current]") {
		t.Fatalf("unexpected first label: %q", labels[0])
	}
	if !strings.Contains(labels[1], "[current]") {
		t.Fatalf("the current model must be marked: %q", labels[1])
	}
	// The provider-side id is shown when it differs, which is what tells the
	// operator which name goes on the wire.
	if !strings.Contains(labels[1], "deepseek-flash") {
		t.Fatalf("the provider-side id should be shown: %q", labels[1])
	}
}
