package tui

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// slashCommand is one entry of the command menu.
type slashCommand struct {
	name string
	desc string
}

var slashCommands = []slashCommand{
	{"/model", "pick a provider and model"},
	{"/providers", "show which providers are signed in"},
	{"/settings", "show or change a setting"},
	{"/status", "session and workspace status"},
	{"/cost", "token usage and cost"},
	{"/setup", "check the setup"},
	{"/key", "store an API key: /key <provider> <key>"},
	{"/login", "sign in with OAuth: /login <provider>"},
	{"/sessions", "list saved sessions"},
	{"/copy", "copy the last reply"},
	{"/new", "start a new session"},
	{"/help", "list commands and keys"},
	{"/quit", "save and exit"},
}

// suggestion is one row of the completion menu. insert replaces the token the
// operator is typing.
type suggestion struct {
	label  string
	desc   string
	insert string
}

const (
	menuNone = iota
	menuSlash
	menuFile
)

const maxMenuRows = 6

// completion works out what the menu should offer for the text typed so far.
// It returns the kind, the rows, and the byte offset where the token being
// completed starts. The cursor is taken to be at the end of the value, which
// holds for the composer: it only appends.
func completion(value string, files []string) (kind int, rows []suggestion, start int) {
	if strings.HasPrefix(value, "/") && !strings.ContainsAny(value, " \n") {
		query := strings.ToLower(value)
		for _, command := range slashCommands {
			if strings.HasPrefix(command.name, query) {
				rows = append(rows, suggestion{label: command.name, desc: command.desc, insert: command.name + " "})
			}
		}
		return menuSlash, limitRows(rows), 0
	}
	at := strings.LastIndex(value, "@")
	if at < 0 || (at > 0 && !isSpace(value[at-1])) {
		return menuNone, nil, 0
	}
	query := value[at+1:]
	if strings.ContainsAny(query, " \n\t") {
		return menuNone, nil, 0
	}
	for _, path := range rankFiles(files, query) {
		rows = append(rows, suggestion{label: path, insert: "@" + path + " "})
	}
	return menuFile, limitRows(rows), at
}

func limitRows(rows []suggestion) []suggestion {
	if len(rows) > maxMenuRows {
		return rows[:maxMenuRows]
	}
	return rows
}

func isSpace(b byte) bool { return b == ' ' || b == '\n' || b == '\t' }

// rankFiles keeps the paths that contain the query, best first: a name that
// starts with it, then a name that contains it, then a match in the directory
// part, shorter paths before longer ones.
func rankFiles(files []string, query string) []string {
	query = strings.ToLower(query)
	type scored struct {
		path  string
		score int
	}
	var found []scored
	for _, path := range files {
		lower := strings.ToLower(path)
		if !strings.Contains(lower, query) {
			continue
		}
		base := lower[strings.LastIndex(lower, "/")+1:]
		score := 2
		switch {
		case strings.HasPrefix(base, query):
			score = 0
		case strings.Contains(base, query):
			score = 1
		}
		found = append(found, scored{path, score})
	}
	sort.SliceStable(found, func(i, j int) bool {
		if found[i].score != found[j].score {
			return found[i].score < found[j].score
		}
		if len(found[i].path) != len(found[j].path) {
			return len(found[i].path) < len(found[j].path)
		}
		return found[i].path < found[j].path
	})
	paths := make([]string, len(found))
	for index, item := range found {
		paths[index] = item.path
	}
	return paths
}

var skippedDirs = map[string]bool{
	".git": true, "node_modules": true, "vendor": true, "target": true,
	"dist": true, "build": true, ".next": true, ".termigo": true, "__pycache__": true,
}

const maxIndexedFiles = 5000

// listFiles indexes the workspace for @ completion: slash-separated relative
// paths, without the directories that hold dependencies or build output, and
// bounded so a huge tree cannot stall the composer.
func listFiles(workspace string) []string {
	var files []string
	_ = filepath.WalkDir(workspace, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if entry.IsDir() {
			if path != workspace && skippedDirs[entry.Name()] {
				return filepath.SkipDir
			}
			return nil
		}
		if !entry.Type().IsRegular() {
			return nil
		}
		rel, relErr := filepath.Rel(workspace, path)
		if relErr != nil {
			return nil
		}
		files = append(files, filepath.ToSlash(rel))
		if len(files) >= maxIndexedFiles {
			return fs.SkipAll
		}
		return nil
	})
	return files
}

var mentionRE = regexp.MustCompile(`(^|\s)@([^\s]+)`)

const maxMentionBytes = 64 * 1024

// expandMentions appends the content of every @path the prompt names, so the
// model reads the file without spending a tool call on it. A mention that is
// not a regular file inside the workspace stays plain text. It returns the
// prompt to send and the paths that were attached.
func expandMentions(prompt, workspace string) (string, []string) {
	var attached []string
	var block strings.Builder
	seen := map[string]bool{}
	for _, match := range mentionRE.FindAllStringSubmatch(prompt, -1) {
		name := strings.TrimRight(match[2], ",.;:!?)")
		if name == "" || seen[name] {
			continue
		}
		seen[name] = true
		path, ok := insideWorkspace(workspace, name)
		if !ok {
			continue
		}
		data, truncated, ok := readMention(path)
		if !ok {
			continue
		}
		attached = append(attached, name)
		fmt.Fprintf(&block, "\n\n<file path=%q>\n%s", name, data)
		if truncated {
			fmt.Fprintf(&block, "\n[truncated at %d KB]", maxMentionBytes/1024)
		}
		block.WriteString("\n</file>")
	}
	if len(attached) == 0 {
		return prompt, nil
	}
	return prompt + block.String(), attached
}

func insideWorkspace(workspace, name string) (string, bool) {
	path := name
	if !filepath.IsAbs(path) {
		path = filepath.Join(workspace, filepath.FromSlash(name))
	}
	rel, err := filepath.Rel(workspace, path)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", false
	}
	return path, true
}

func readMention(path string) (content string, truncated, ok bool) {
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return "", false, false
	}
	file, err := os.Open(path)
	if err != nil {
		return "", false, false
	}
	defer file.Close()
	buffer := make([]byte, maxMentionBytes+1)
	n, _ := file.Read(buffer)
	buffer = buffer[:n]
	if n > maxMentionBytes {
		buffer, truncated = buffer[:maxMentionBytes], true
	}
	probe := buffer
	if len(probe) > 512 {
		probe = probe[:512]
	}
	for _, b := range probe {
		if b == 0 {
			return "", false, false
		}
	}
	return string(buffer), truncated, true
}
