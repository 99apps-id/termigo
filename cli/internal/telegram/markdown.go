package telegram

import (
	"regexp"
	"strconv"
	"strings"
)

var (
	codeSpanPattern   = regexp.MustCompile("`([^`\n]+)`")
	boldItalicPattern = regexp.MustCompile(`\*\*\*([^*\n]+)\*\*\*`)
	boldPattern       = regexp.MustCompile(`\*\*([^*\n]+)\*\*`)
	underscoreBold    = regexp.MustCompile(`__([^_\n]+)__`)
	italicAsterisk    = regexp.MustCompile(`\*([^\s*](?:[^*\n]*?[^\s*])?)\*`)
	italicUnderscore  = regexp.MustCompile(`\b_([^_]+)_\b`)
	strikePattern     = regexp.MustCompile(`~~([^~\n]+)~~`)
	linkPattern       = regexp.MustCompile(`\[([^\]\n]+)\]\(([^)\s]+)\)`)
	tableRowPattern   = regexp.MustCompile(`^\|?[ \t]*([^|\r\n]+(?:[ \t]*\|[ \t]*[^|\r\n]+)*)\|?[ \t]*$`)
	tableCellSplitter = regexp.MustCompile(`[ \t]*\|[ \t]*`)
)

// markdownToTelegramHTML renders a small, deliberate subset of Markdown as the
// HTML that Telegram accepts: fenced code, inline code, bold, links, strikethrough,
// blockquotes and headings. It also converts pipe tables and fenced code blocks
// whose info string ends with `linenos` into numbered code blocks. Everything
// else passes through escaped, so a stray '<' or '&' in model output cannot
// break the message.
func markdownToTelegramHTML(text string) string {
	lines := strings.Split(text, "\n")
	var out strings.Builder
	inCode := false
	codeLinenos := false
	codeLang := ""
	var codeLines []string
	inTable := false
	flushCode := func() {
		if !inCode {
			return
		}
		inCode = false
		if codeLang != "" {
			out.WriteString(`<pre><code class="language-` + escapeHTML(codeLang) + `">`)
		} else {
			out.WriteString("<pre>")
		}
		for index, line := range codeLines {
			if codeLinenos {
				out.WriteString(strconv.Itoa(index + 1))
				out.WriteString(": ")
			}
			out.WriteString(escapeHTML(line))
			out.WriteString("\n")
		}
		if codeLang != "" {
			out.WriteString("</code></pre>")
		} else {
			out.WriteString("</pre>")
		}
		codeLines = nil
		codeLang = ""
	}
	closeTable := func() {
		if inTable {
			out.WriteString("</pre>")
			inTable = false
		}
	}
	for _, line := range lines {
		if !inCode {
			tableRow, isTable := parseTableRow(line)
			isSep := isTableSeparator(line)
			if isTable || isSep {
				if !inTable {
					out.WriteString("<pre>")
					inTable = true
				}
				if isSep {
					out.WriteString(escapeHTML(line))
				} else {
					// Cells are model output like any other line, so they are
					// escaped too. Writing them raw let a cell holding '<' or
					// '&' reach Telegram's HTML parser and break the message.
					out.WriteString(escapeHTML(tableRow))
				}
				out.WriteString("\n")
				continue
			}
			closeTable()
		}
		if !inCode && strings.HasPrefix(strings.TrimSpace(line), "```") {
			inCode = true
			codeInfo := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(line), "```"))
			codeLinenos = strings.HasSuffix(codeInfo, "linenos")
			codeLang = ""
			if !codeLinenos && codeInfo != "" {
				codeLang = strings.Fields(codeInfo)[0]
			}
			codeLines = nil
			continue
		}
		if inCode {
			if strings.HasPrefix(strings.TrimSpace(line), "```") {
				flushCode()
				continue
			}
			codeLines = append(codeLines, line)
			continue
		}
		out.WriteString(inlineToHTML(line))
		out.WriteString("\n")
	}
	flushCode()
	closeTable()
	return strings.TrimRight(out.String(), "\n")
}

// inlineToHTML styles one non-code line: headings, inline code, bold, links,
// quotes, and bullet lists.
func inlineToHTML(line string) string {
	escaped := escapeHTML(line)
	trimmed := strings.TrimLeft(escaped, " \t")
	if trimmed == "---" || trimmed == "***" || trimmed == "___" {
		return "──────────"
	}
	if strings.HasPrefix(trimmed, "#") {
		if heading := strings.TrimSpace(strings.TrimLeft(trimmed, "#")); heading != "" {
			// Avoid nested <b><b>...</b></b> inside headings while still rendering inline code or links.
			cleaned := boldPattern.ReplaceAllString(heading, "$1")
			return "<b>" + inlineSpansToHTML(cleaned) + "</b>"
		}
	}
	if strings.HasPrefix(trimmed, "&gt; ") {
		quote := strings.TrimPrefix(trimmed, "&gt; ")
		return "<blockquote>" + inlineSpansToHTML(quote) + "</blockquote>"
	}
	if strings.HasPrefix(trimmed, "- ") {
		leading := line[:len(line)-len(strings.TrimLeft(line, " \t"))]
		return leading + "• " + inlineSpansToHTML(trimmed[2:])
	}
	if strings.HasPrefix(trimmed, "* ") && !strings.HasPrefix(trimmed, "* *") {
		leading := line[:len(line)-len(strings.TrimLeft(line, " \t"))]
		return leading + "• " + inlineSpansToHTML(trimmed[2:])
	}
	return inlineSpansToHTML(escaped)
}

// inlineSpansToHTML styles one escaped line. Code spans are cut out first and
// left untouched: Telegram rejects any entity nested inside <code>, and a
// rejected message fell back to raw Markdown. Links are cut out next so a URL
// is never rewritten by the emphasis rules; only the label is styled.
func inlineSpansToHTML(escaped string) string {
	var out strings.Builder
	last := 0
	for _, loc := range codeSpanPattern.FindAllStringSubmatchIndex(escaped, -1) {
		out.WriteString(linksToHTML(escaped[last:loc[0]]))
		out.WriteString("<code>" + escaped[loc[2]:loc[3]] + "</code>")
		last = loc[1]
	}
	out.WriteString(linksToHTML(escaped[last:]))
	return out.String()
}

// linksToHTML renders [label](url) and styles the text around and inside it.
func linksToHTML(text string) string {
	var out strings.Builder
	last := 0
	for _, loc := range linkPattern.FindAllStringSubmatchIndex(text, -1) {
		out.WriteString(emphasisToHTML(text[last:loc[0]]))
		label := text[loc[2]:loc[3]]
		rawHref := text[loc[4]:loc[5]]
		href := strings.ReplaceAll(rawHref, `"`, "&quot;")
		if isTelegramSafeURL(rawHref) {
			out.WriteString(`<a href="` + href + `">` + emphasisToHTML(label) + "</a>")
		} else if label == rawHref {
			out.WriteString(emphasisToHTML(label))
		} else {
			out.WriteString(emphasisToHTML(label) + " (" + rawHref + ")")
		}
		last = loc[1]
	}
	out.WriteString(emphasisToHTML(text[last:]))
	return out.String()
}

func isTelegramSafeURL(raw string) bool {
	lower := strings.ToLower(strings.TrimSpace(raw))
	return strings.HasPrefix(lower, "http://") ||
		strings.HasPrefix(lower, "https://") ||
		strings.HasPrefix(lower, "tg://") ||
		strings.HasPrefix(lower, "mailto:")
}

func emphasisToHTML(text string) string {
	const (
		bOpen  = "\x00B1\x00"
		bClose = "\x00B2\x00"
		iOpen  = "\x00I1\x00"
		iClose = "\x00I2\x00"
	)
	text = boldItalicPattern.ReplaceAllString(text, bOpen+iOpen+"$1"+iClose+bClose)
	text = boldPattern.ReplaceAllString(text, bOpen+"$1"+bClose)
	text = underscoreBold.ReplaceAllString(text, bOpen+"$1"+bClose)
	text = italicAsterisk.ReplaceAllString(text, iOpen+"$1"+iClose)
	text = italicUnderscore.ReplaceAllString(text, iOpen+"$1"+iClose)
	text = strikePattern.ReplaceAllString(text, "<s>$1</s>")
	return strings.NewReplacer(
		bOpen, "<b>",
		bClose, "</b>",
		iOpen, "<i>",
		iClose, "</i>",
	).Replace(text)
}

// escapeHTML escapes the three characters Telegram's HTML parser treats as
// markup. Quotes do not need escaping in text.
func escapeHTML(text string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;").Replace(text)
}

// parseTableRow converts one Markdown table row into a plain-text row.
// Telegram does not support HTML tables, so the best portable representation
// is a single preformatted block whose columns still line up.
func parseTableRow(line string) (string, bool) {
	trimmed := strings.TrimSpace(line)
	if !strings.HasPrefix(trimmed, "|") || !strings.HasSuffix(trimmed, "|") {
		return "", false
	}
	inner := strings.Trim(trimmed, "|")
	if !tableRowPattern.MatchString(inner) {
		return "", false
	}
	cells := tableCellSplitter.Split(inner, -1)
	var builder strings.Builder
	for index, cell := range cells {
		if index > 0 {
			builder.WriteString(" | ")
		}
		builder.WriteString(strings.TrimSpace(cell))
	}
	return builder.String(), true
}

// isTableSeparator reports whether a line is a Markdown table separator such
// as `|---|---|`. These are structural, not prose, so they are emitted as-is
// inside the table block.
func isTableSeparator(line string) bool {
	trimmed := strings.TrimSpace(line)
	if !strings.HasPrefix(trimmed, "|") || !strings.HasSuffix(trimmed, "|") {
		return false
	}
	inner := strings.Trim(trimmed, "|")
	for _, r := range inner {
		switch r {
		case '|', '-', ' ', '\t':
		default:
			return false
		}
	}
	return true
}
