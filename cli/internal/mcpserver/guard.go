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

// Security guards for the MCP server.
//
// The MCP server is a stdio transport, but it is its own trust boundary: the
// client-side approval in the host app only protects one consumer. These guards
// make the server safe against any client, so a direct or future connection
// cannot get unrestricted shell access.

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

// validateShellCommand mirrors the frontend's checkShellCommand. It blocks
// empty commands, C0 control characters (including CR/LF, which would let a
// second statement smuggle past a single-line approval), Unicode bidi
// overrides (Trojan Source), and a deny-list of destructive commands. It is a
// safety net, not a complete boundary - the approval gate is the real control.
var (
	reControl        = regexp.MustCompile(`[\x00-\x1f]`)
	reBidi           = regexp.MustCompile(`[\x{202A}-\x{202E}\x{2066}-\x{2069}\x{200E}\x{200F}\x{061C}]`)
	reRmRoot         = regexp.MustCompile(`\brm\s+(-[A-Za-z]*r[A-Za-z]*f[A-Za-z]*|-[A-Za-z]*f[A-Za-z]*r[A-Za-z]*|--recursive\s+--force|--force\s+--recursive)\s+['"]?/['"]?\s*($|;|&|\|)`)
	reRmHome         = regexp.MustCompile(`\brm\s+(?:-[A-Za-z]*(?:rf|fr)[A-Za-z]*|--recursive\s+--force|--force\s+--recursive)\s+['"]?(?:~|\$HOME|\$\{HOME\})['"]?(?:/|\s|['"]|$|;|&|\|)`)
	reNoPreserveRoot = regexp.MustCompile(`--no-preserve-root`)
	reDdBlock        = regexp.MustCompile(`(?i)\bdd\b[^\n]*\bof=/dev/(disk|sd|nvme|hd)`)
	reFormat         = regexp.MustCompile(`\b(mkfs(\.[a-z0-9]+)?|fdisk|parted)\b`)
	reDiskutilErase  = regexp.MustCompile(`(?i)\bdiskutil\s+erase`)
	reForkBomb       = regexp.MustCompile(`:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;`)
	rePipeToShell    = regexp.MustCompile(`\b(curl|wget)\b[^|;&]*\|\s*(ba|z|k|d|fi|c)?sh\b`)
	reUnsafeToolPath = regexp.MustCompile(`[^A-Za-z0-9._/]`)
	reRedact         = regexp.MustCompile(`(sk-[A-Za-z0-9_-]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|xox[baprs]-[A-Za-z0-9-]{10,})`)
)

// validateShellCommand returns whether a command is permitted and, if not, a
// short reason.
func validateShellCommand(cmd string) (bool, string) {
	c := strings.TrimSpace(cmd)
	if c == "" {
		return false, "Refused: empty command."
	}
	if reControl.MatchString(c) {
		return false, "Refused: command contains control characters (including CR/LF). Commands must be single-line."
	}
	if reBidi.MatchString(c) {
		return false, "Refused: command contains Unicode bidirectional override characters."
	}
	if reRmRoot.MatchString(c) {
		return false, "Refused: command attempts to recursively delete the filesystem root."
	}
	if reRmHome.MatchString(c) {
		return false, "Refused: command attempts to recursively delete the home directory."
	}
	if reNoPreserveRoot.MatchString(c) {
		return false, "Refused: --no-preserve-root is not allowed."
	}
	if reDdBlock.MatchString(c) {
		return false, "Refused: dd to a block device is not allowed."
	}
	if reFormat.MatchString(c) || reDiskutilErase.MatchString(c) {
		return false, "Refused: disk-formatting commands are not allowed."
	}
	if reForkBomb.MatchString(c) {
		return false, "Refused: fork-bomb pattern detected."
	}
	if rePipeToShell.MatchString(c) {
		return false, "Refused: piping a network download directly into a shell is blocked. Download first, inspect, then run."
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
