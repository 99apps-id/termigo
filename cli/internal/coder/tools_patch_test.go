package coder

import (
	"os"
	"path/filepath"
	"testing"
)

// The Add File form the tool advertises has no `@@` marker, so the body has to
// open a hunk of its own. Before that, every `+line` was dropped and the patch
// died with "holds no hunks" - an error the model could not act on.
func TestParsePatchKeepsAnAddFileBodyWithoutHunkMarkers(t *testing.T) {
	document := "*** Begin Patch\n*** Add File: hello.txt\n+hi\n+\n+there\n*** End Patch"

	ops, err := parsePatch(document)
	if err != nil {
		t.Fatalf("parsePatch: %v", err)
	}
	if len(ops) != 1 || ops[0].action != "add" || ops[0].path != "hello.txt" {
		t.Fatalf("ops = %+v", ops)
	}

	var body []string
	for _, hunk := range ops[0].hunks {
		for _, line := range hunk.lines {
			body = append(body, line.kind+line.text)
		}
	}
	want := []string{"+hi", "+", "+there"}
	if len(body) != len(want) {
		t.Fatalf("body = %q, want %q", body, want)
	}
	for i := range want {
		if body[i] != want[i] {
			t.Fatalf("body = %q, want %q", body, want)
		}
	}
}

func TestApplyPatchAddWritesTheWholeBody(t *testing.T) {
	ops, err := parsePatch("*** Begin Patch\n*** Add File: hello.txt\n+one\n+two\n*** End Patch")
	if err != nil {
		t.Fatalf("parsePatch: %v", err)
	}

	path := filepath.Join(t.TempDir(), "hello.txt")
	if err := applyPatchAdd(path, ops[0]); err != nil {
		t.Fatalf("applyPatchAdd: %v", err)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if string(data) != "one\ntwo\n" {
		t.Fatalf("file = %q, want both lines", string(data))
	}
}

func TestParsePatchStillRefusesAnUpdateWithoutHunks(t *testing.T) {
	if _, err := parsePatch("*** Begin Patch\n*** Update File: a.txt\n*** End Patch"); err == nil {
		t.Fatal("an update with no hunk must be refused")
	}
}
