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
type TestResult struct {
	CaseID     string        `json:"case_id"`
	Passed     bool          `json:"passed"`
	Duration   time.Duration `json:"duration"`
	TotalSteps int           `json:"total_steps"`
	TokensUsed int           `json:"tokens_used"`
	CostUSD    float64       `json:"cost_usd"`
	Error      string        `json:"error,omitempty"`
}

// EvalReport aggregates the entire benchmark run.
type EvalReport struct {
	DatasetPath string        `json:"dataset_path"`
	ModelID     string        `json:"model_id"`
	TotalCases  int           `json:"total_cases"`
	PassedCases int           `json:"passed_cases"`
	PassRate    float64       `json:"pass_rate"`
	TotalTime   time.Duration `json:"total_time"`
	TotalTokens int           `json:"total_tokens"`
	TotalCost   float64       `json:"total_cost_usd"`
	Results     []TestResult  `json:"results"`
}
