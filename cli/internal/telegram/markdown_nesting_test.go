package telegram

import (
	"strings"
	"testing"
)

// Telegram rejects any entity inside <code>, so emphasis markers in a code
// span must stay literal.
func TestCodeSpanKeepsEmphasisLiteral(t *testing.T) {
	got := markdownToTelegramHTML("run `a **b** _c_ [x](y)` now **bold**")
	want := "run <code>a **b** _c_ [x](y)</code> now <b>bold</b>"
	if got != want {
		t.Fatalf("got  %q\nwant %q", got, want)
	}
}

// A URL is never rewritten by emphasis rules, and a quote cannot close the
// href attribute.
func TestLinkHrefIsLeftIntactAndQuoted(t *testing.T) {
	got := markdownToTelegramHTML(`see [**docs**](https://a.io/_x_/b"c)`)
	want := `see <a href="https://a.io/_x_/b&quot;c"><b>docs</b></a>`
	if got != want {
		t.Fatalf("got  %q\nwant %q", got, want)
	}
	if strings.Count(got, "<i>") != 0 {
		t.Fatalf("the URL must not gain italics: %q", got)
	}
}
