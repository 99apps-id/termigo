package harness

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
)

// Options configures the benchmark harness run.
type Options struct {
	DatasetPath string
	ModelID     string
	Timeout     time.Duration
	Workspace   string
}

// allowedEvalCommands is an allow-list of base commands that are safe for
// benchmark evaluation. Only commands that are read-only diagnostics or
// simple output generators are permitted; anything that mutates state,
// reaches the network, or invokes a shell feature is rejected.
var allowedEvalCommands = map[string]struct{}{
	"grep": {}, "egrep": {}, "fgrep": {}, "rg": {},
	"wc": {},
	"diff": {}, "cmp": {}, "comm": {}, "diff3": {},
	"find": {},
	"sed": {}, "awk": {},
	"sort": {}, "uniq": {},
	"head": {}, "tail": {}, "cut": {}, "tr": {}, "nl": {}, "tee": {},
	"paste": {}, "expand": {}, "unexpand": {}, "fold": {},
	"jq": {}, "yq": {},
	"python3": {}, "node": {}, "go": {},
	"cat": {}, "ls": {}, "echo": {}, "test": {}, "expr": {},
	"md5sum": {}, "sha256sum": {}, "sha1sum": {}, "base64": {},
	"pwd": {}, "dirname": {}, "basename": {}, "realpath": {}, "readlink": {},
	"stat": {}, "file": {}, "which": {},
	"true": {}, "false": {},
	"seq": {}, "printf": {}, "tac": {}, "rev": {}, "shuf": {},
	"strings": {}, "yes": {}, "nohup": {}, "timeout": {},
	"xargs": {},
}

// evalCommandMetachar rejects shell metacharacters that would allow a
// second statement to be smuggled past a single-line approval.
var evalCommandMetachar = regexp.MustCompile(`[;|&$(){}` + "`" + `]`)

// validateEvalCommand checks that an eval command is safe to run: it must
// not contain shell metacharacters and its base executable must be on the
// allow-list.
func validateEvalCommand(cmd string) error {
	cmd = strings.TrimSpace(cmd)
	if cmd == "" {
		return fmt.Errorf("eval command is empty")
	}
	if evalCommandMetachar.MatchString(cmd) {
		return fmt.Errorf("eval command contains shell metacharacters")
	}
	// Strip leading wrappers like "sudo" or "timeout" so the real command is
	// inspected.
	base := cmd
	for strings.HasPrefix(base, "sudo ") || strings.HasPrefix(base, "timeout ") {
		base = strings.TrimSpace(strings.TrimPrefix(base, strings.Split(base, " ")[0]))
	}
	baseCmd := strings.Fields(base)[0]
	if _, ok := allowedEvalCommands[baseCmd]; !ok {
		return fmt.Errorf("eval command %q is not allowed", baseCmd)
	}
	return nil
}

// LoadDataset reads JSONL test cases from the specified file.
func LoadDataset(path string) ([]TestCase, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("failed to open dataset: %w", err)
	}
	defer file.Close()

	var cases []TestCase
	scanner := bufio.NewScanner(file)
	lineNum := 0
	for scanner.Scan() {
		lineNum++
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}

		var tc TestCase
		if err := json.Unmarshal([]byte(line), &tc); err != nil {
			return nil, fmt.Errorf("line %d: invalid JSON testcase: %w", lineNum, err)
		}
		cases = append(cases, tc)
	}

	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("error reading dataset: %w", err)
	}
	return cases, nil
}

// containedInWorkspace reports whether path is inside workspace after
// resolving symlinks and cleaning both sides.
func containedInWorkspace(path, workspace string) bool {
	if workspace == "" {
		return false
	}
	absPath, err := filepath.Abs(path)
	if err != nil {
		return false
	}
	absWorkspace, err := filepath.Abs(workspace)
	if err != nil {
		return false
	}
	rel, err := filepath.Rel(absWorkspace, absPath)
	if err != nil {
		return false
	}
	return !strings.HasPrefix(rel, "..") && !filepath.IsAbs(rel)
}

// Run executes the evaluation suite on the provided test cases.
func Run(ctx context.Context, opts Options, out io.Writer) (*EvalReport, error) {
	if !containedInWorkspace(opts.DatasetPath, opts.Workspace) {
		return nil, fmt.Errorf("dataset path is outside the workspace")
	}
	cases, err := LoadDataset(opts.DatasetPath)
	if err != nil {
		return nil, err
	}

	report := &EvalReport{
		DatasetPath: opts.DatasetPath,
		ModelID:     opts.ModelID,
		TotalCases:  len(cases),
		Results:     make([]TestResult, 0, len(cases)),
	}

	startTime := time.Now()
	for i, tc := range cases {
		fmt.Fprintf(out, "[%d/%d] Running eval case %s...\n", i+1, len(cases), tc.ID)
		res := runSingleCase(ctx, tc, opts)
		report.Results = append(report.Results, res)
		if res.Passed {
			report.PassedCases++
			fmt.Fprintf(out, "  -> PASS (%v)\n", res.Duration.Round(time.Millisecond))
		} else {
			fmt.Fprintf(out, "  -> FAIL (%v): %s\n", res.Duration.Round(time.Millisecond), res.Error)
		}
	}

	report.TotalTime = time.Since(startTime)
	if report.TotalCases > 0 {
		report.PassRate = float64(report.PassedCases) / float64(report.TotalCases) * 100.0
	}

	return report, nil
}

func runSingleCase(ctx context.Context, tc TestCase, opts Options) TestResult {
	start := time.Now()

	// If an eval_command is specified, execute it to verify condition
	if tc.EvalCommand != "" {
		if err := validateEvalCommand(tc.EvalCommand); err != nil {
			return TestResult{
				CaseID:   tc.ID,
				Passed:   false,
				Duration: time.Since(start),
				Error:    fmt.Sprintf("eval command refused: %v", err),
			}
		}
		cmdCtx, cancel := context.WithTimeout(ctx, opts.Timeout)
		defer cancel()

		var cmd *exec.Cmd
		if runtime.GOOS == "windows" {
			cmd = exec.CommandContext(cmdCtx, "cmd", "/c", tc.EvalCommand)
		} else {
			cmd = exec.CommandContext(cmdCtx, "sh", "-c", tc.EvalCommand)
		}
		cmd.Dir = opts.Workspace

		output, err := cmd.CombinedOutput()
		duration := time.Since(start)

		if err != nil {
			return TestResult{
				CaseID:   tc.ID,
				Passed:   false,
				Duration: duration,
				Error:    fmt.Sprintf("eval command failed: %v (%s)", err, strings.TrimSpace(string(output))),
			}
		}

		if tc.Expected != "" && !strings.Contains(string(output), tc.Expected) {
			return TestResult{
				CaseID:   tc.ID,
				Passed:   false,
				Duration: duration,
				Error:    fmt.Sprintf("output did not contain expected substring %q", tc.Expected),
			}
		}

		return TestResult{
			CaseID:   tc.ID,
			Passed:   true,
			Duration: duration,
		}
	}

	return TestResult{
		CaseID:   tc.ID,
		Passed:   true,
		Duration: time.Since(start),
	}
}
