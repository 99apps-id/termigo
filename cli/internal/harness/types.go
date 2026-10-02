package harness

import "time"

// TestCase defines a single evaluation problem from a dataset.
type TestCase struct {
	ID          string   `json:"id"`
	Prompt      string   `json:"prompt"`
	TargetFiles []string `json:"target_files,omitempty"`
	EvalCommand string   `json:"eval_command,omitempty"`
	Expected    string   `json:"expected,omitempty"`
}

// TestResult holds the outcome of running one evaluation test case.
//
// Step, token and cost accounting fields were removed: they were never filled
// by the runner, so a report carried four zero-valued numbers that read as
// real measurements. When the harness grows a model-driven path, the fields
// should come back filled rather than as placeholders.
type TestResult struct {
	CaseID   string        `json:"case_id"`
	Passed   bool          `json:"passed"`
	Duration time.Duration `json:"duration"`
	Error    string        `json:"error,omitempty"`
}

// EvalReport aggregates the entire benchmark run.
//
// ModelID is a label for which model the run targeted, not a driver: the
// harness executes eval commands only, so the id is what the report carries to
// compare two runs of the same dataset.
type EvalReport struct {
	DatasetPath string        `json:"dataset_path"`
	ModelID     string        `json:"model_id"`
	TotalCases  int           `json:"total_cases"`
	PassedCases int           `json:"passed_cases"`
	PassRate    float64       `json:"pass_rate"`
	TotalTime   time.Duration `json:"total_time"`
	Results     []TestResult  `json:"results"`
}
