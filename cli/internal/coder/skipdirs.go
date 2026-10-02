package coder

import "strings"

// skippedDirs are directory names a search walk never enters: dependency trees,
// build output and caches. They hold thousands of generated files, so walking
// them floods the results and makes a search take minutes on a large workspace.
var skippedDirs = map[string]bool{
	".git": true, "node_modules": true, "vendor": true, "dist": true, "build": true,
	".next": true, ".turbo": true, ".venv": true, "venv": true, "__pycache__": true,
	"target": true, ".pnpm-store": true, ".cache": true, "coverage": true,
}

// isSkippedDir reports whether a directory name is one a search never enters.
func isSkippedDir(name string) bool {
	return skippedDirs[strings.ToLower(strings.TrimSpace(name))]
}
