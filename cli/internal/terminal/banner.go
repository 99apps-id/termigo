package terminal

import "strings"

// bannerWord is what the art below spells, letter by letter.
const bannerWord = "TERMIGO"

// bannerGlyphs is one 5-row ASCII glyph per letter of bannerWord, in order.
//
// Kept as data rather than one hand-pasted block: a test can then prove every
// glyph has the same number of rows and that each row is as wide as its
// neighbours, which is what stops an edited letter from shearing the whole art.
var bannerGlyphs = [][5]string{
	{" _____ ", "|_   _|", "  | |  ", "  | |  ", "  |_|  "},
	{" _____ ", "| ____|", "|  _|  ", "| |___ ", "|_____|"},
	{" ____  ", "|  _ \\ ", "| |_) |", "|  _ < ", "|_| \\_\\"},
	{" __  __ ", "|  \\/  |", "| |\\/| |", "| |  | |", "|_|  |_|"},
	{" ___ ", "|_ _|", " | | ", " | | ", "|___|"},
	{"  ____ ", " / ___|", "| |  _ ", "| |_| |", " \\____|"},
	{"  ___  ", " / _ \\ ", "| | | |", "| |_| |", " \\___/ "},
}

// bannerRows renders the wordmark with every row padded to the same width.
//
// Rectangular by construction: the rows are what the art's shape depends on, and
// trimming them here would be the one thing that could shear it, since different
// rows end with a different number of blank columns.
func bannerRows() []string {
	rows := make([]string, len(bannerGlyphs[0]))
	for _, glyph := range bannerGlyphs {
		for row, text := range glyph {
			rows[row] += text
		}
	}
	return rows
}

// Banner renders the wordmark for output: the same art with the blank columns on
// the right removed, where they carry no shape and would only be trailing noise.
func Banner() string {
	rows := bannerRows()
	for index, row := range rows {
		rows[index] = strings.TrimRight(row, " ")
	}
	return strings.Join(rows, "\n")
}
