package mcpserver

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
)

// Resource guards for the MCP server.
//
// termigo-neo keeps no gates: commands are not filtered by content and the
// shell-exec tool is exposed by default. The caps below (output size,
// deadline) stay because they bound resource use, not freedom.

const (
	// maxExecOutputBytes caps combined command output so a chatty or malicious
	// command cannot grow memory without bound. Roughly 1000 80x24 screens.
	maxExecOutputBytes = 256 * 1024
	// execTimeoutSecs bounds a single command so a hung process cannot wedge
	// the stdio server.
	execTimeoutSecs = 120
	// mcpAllowExecEnv opts into the shell-exec tool. It is off by default so
	// the RCE-capable surface is not exposed automatically.
	mcpAllowExecEnv = "TERMIGO_MCP_ALLOW_EXEC"
)

// validateShellCommand mirrors the frontend's checkShellCommand. termigo-neo
// keeps no content gate: every non-empty command is allowed.
var (
	reUnsafeToolPath = regexp.MustCompile(`[^A-Za-z0-9._/]`)
	reRedact         = regexp.MustCompile(`(sk-[A-Za-z0-9_-]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|xox[baprs]-[A-Za-z0-9-]{10,})`)
)

// validateShellCommand returns whether a command is permitted and, if not, a
// short reason. Only an empty command is refused; that is a usage error, not
// a gate.
func validateShellCommand(cmd string) (bool, string) {
	c := strings.TrimSpace(cmd)
	if c == "" {
		return false, "Refused: empty command."
	}
	return true, ""
}

// safeWorkspaceCwd resolves the base working directory for exec and rejects a
// path that is not an absolute directory, so a malformed --workspace cannot be
// used to run outside the intended tree.
func safeWorkspaceCwd(workspace string) (string, bool) {
	if workspace == "" {
		return "", false
	}
	abs, err := filepath.Abs(workspace)
	if err != nil {
		return "", false
	}
	info, err := os.Stat(abs)
	if err != nil || !info.IsDir() {
		return "", false
	}
	return abs, true
}

// safeToolPath validates a file-scoped diagnostic path so it cannot smuggle
// shell metacharacters into `ruff check <path>`. Only a plain relative path of
// safe characters is accepted; traversal and option-looking prefixes are
// rejected.
func safeToolPath(p string) (string, bool) {
	p = strings.TrimSpace(p)
	if p == "" {
		return "", true
	}
	if reUnsafeToolPath.MatchString(p) {
		return "", false
	}
	if strings.Contains(p, "..") || strings.HasPrefix(p, "-") {
		return "", false
	}
	return p, true
}

// redactOutput strips common API-key shapes from command output so a secret is
// not echoed back to the client.
func redactOutput(s string) string {
	return reRedact.ReplaceAllString(s, "[REDACTED]")
}

// cappedBuffer is an io.Writer that keeps at most max bytes and reports
// truncation, so a command that floods output cannot grow memory without bound.
type cappedBuffer struct {
	buf       bytes.Buffer
	max       int
	truncated bool
}

func (c *cappedBuffer) Write(p []byte) (int, error) {
	if c.truncated {
		return len(p), nil
	}
	space := c.max - c.buf.Len()
	if space <= 0 {
		if len(p) > 0 {
			c.truncated = true
		}
		return len(p), nil
	}
	n := len(p)
	if n > space {
		n = space
		c.truncated = true
	}
	c.buf.Write(p[:n])
	// Report the full length so the child never sees a short write and does not
	// get EPIPE from a genuinely huge output.
	return len(p), nil
}

// execCapped runs cmd, capturing at most maxBytes of combined output. It
// returns the output, whether the deadline was hit, and the run error.
func execCapped(ctx context.Context, cmd *exec.Cmd, maxBytes int) (string, bool, error) {
	buf := &cappedBuffer{max: maxBytes}
	cmd.Stdout = buf
	cmd.Stderr = buf
	err := cmd.Run()
	timedOut := ctx.Err() == context.DeadlineExceeded
	out := strings.TrimSpace(buf.buf.String())
	if buf.truncated {
		out += "\n[output truncated]"
	}
	return out, timedOut, err
}

// expected command string for a blocked command in tests.
func execCommand(ctx context.Context, command string, cwd string) *exec.Cmd {
	var cmd *exec.Cmd
	if isWindows() {
		cmd = exec.CommandContext(ctx, "powershell", "-Command", command)
	} else {
		cmd = exec.CommandContext(ctx, "sh", "-c", command)
	}
	if cwd != "" {
		cmd.Dir = cwd
	}
	return cmd
}
