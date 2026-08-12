package doctor

import "testing"

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
