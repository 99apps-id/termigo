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

func TestEnrichedTelegramMarkdown(t *testing.T) {
	input := strings.Join([]string{
		"Paragraf 1 👨‍💻",
		"",
		"",
		"- Item *satu*",
		"  - Sub item",
		"+ Item plus",
		"- [ ] Todo",
		"- [x] Done",
		"",
		"1. Langkah **pertama**",
		"2. Langkah _kedua_",
		"",
		"> baris satu",
		"> baris dua",
		"",
		"Rahasia ||rahasia||",
	}, "\r\n")
	got := markdownToTelegramHTML(input)
	for _, want := range []string{
		"Paragraf 1 👨‍💻\n\n• Item <i>satu</i>",
		"  ◦ Sub item",
		"• Item plus",
		"☐ Todo",
		"☑ Done",
		"1. Langkah <b>pertama</b>",
		"2. Langkah <i>kedua</i>",
		"<blockquote>baris satu\nbaris dua</blockquote>",
		"Rahasia <tg-spoiler>rahasia</tg-spoiler>",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("missing %q in:\n%s", want, got)
		}
	}
}
