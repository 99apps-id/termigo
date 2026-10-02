package coder

import "unicode/utf8"

// clipBytes returns the first limit bytes of text, moved back to a rune
// boundary.
//
// A string sliced by byte can be cut inside a multi-byte character, and the
// halves of a rune are not valid UTF-8: the terminal then paints a replacement
// glyph and the provider's tokenizer reads garbage. Every size bound in this
// package goes through here for that reason. The search index had the same
// defect and it was only visible on non-ASCII text.
func clipBytes(text string, limit int) string {
	if limit <= 0 {
		return ""
	}
	if len(text) <= limit {
		return text
	}
	cut := limit
	for cut > 0 && !utf8.RuneStart(text[cut]) {
		cut--
	}
	return text[:cut]
}

// clipTailBytes returns the last limit bytes of text, moved forward to a rune
// boundary so the kept part starts on a whole character.
func clipTailBytes(text string, limit int) string {
	if limit <= 0 {
		return ""
	}
	if len(text) <= limit {
		return text
	}
	start := len(text) - limit
	for start < len(text) && !utf8.RuneStart(text[start]) {
		start++
	}
	return text[start:]
}
