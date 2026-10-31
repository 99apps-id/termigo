package doctor

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestTrimVersion(t *testing.T) {
	if got := trimVersion("  termigo 1.0.0\n"); got != "termigo 1.0.0" {
		t.Fatalf("trimVersion() = %q", got)
	}
}

func TestTrimVersionCapsLongValues(t *testing.T) {
	input := make([]byte, 121)
	for index := range input {
		input[index] = 'x'
	}
	if got := trimVersion(string(input)); len(got) != 123 {
		t.Fatalf("trimVersion length = %d, want 123", len(got))
	}
}

func TestTrimVersionKeepsValidUTF8AtTheLimit(t *testing.T) {
	input := strings.Repeat("界", 121)
	got := trimVersion(input)
	if !utf8.ValidString(got) {
		t.Fatalf("trimVersion returned invalid UTF-8: %q", got)
	}
	if got != strings.Repeat("界", 120)+"..." {
		t.Fatalf("trimVersion() = %q", got)
	}
}
