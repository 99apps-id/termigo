package secrets

// FileAccess describes who can reach a path, for auditing and tests.
type FileAccess struct {
	// OwnerOnly is true when only the owner can read or write the path.
	OwnerOnly bool
	// Entries names the trustees that currently hold access.
	Entries []string
	// Detail carries a short platform-specific summary, for doctor output.
	Detail string
}

// Inspect reports the current access rules of a path. It is the check behind
// `termigo doctor` and the assertion the tests use, so the claim "the secret
// file is private" is verified rather than assumed.
func Inspect(path string) (FileAccess, error) { return inspect(path) }

// RestrictFile makes a file reachable only by the current user.
//
// It is exported because the protection is not specific to credentials: a saved
// conversation can contain a key the operator pasted, and on Windows a plain
// write inherits whatever the parent directory grants, which is how a shared
// local group could read it. Any file that must stay private goes through here.
func RestrictFile(path string) error { return restrictFile(path) }
