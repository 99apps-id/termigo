package harness

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
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

// Run executes the evaluation suite on the provided test cases.
func Run(ctx context.Context, opts Options, out io.Writer) (*EvalReport, error) {
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
