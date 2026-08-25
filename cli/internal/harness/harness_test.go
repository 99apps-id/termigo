package harness

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestLoadDataset(t *testing.T) {
	dir := t.TempDir()
	datasetPath := filepath.Join(dir, "cases.jsonl")

	content := `{"id":"test-1","prompt":"Fix syntax error in main.go","eval_command":"echo ok","expected":"ok"}
{"id":"test-2","prompt":"Refactor database query"}`

	if err := os.WriteFile(datasetPath, []byte(content), 0644); err != nil {
		t.Fatalf("failed to write test dataset: %v", err)
	}

	cases, err := LoadDataset(datasetPath)
	if err != nil {
		t.Fatalf("LoadDataset failed: %v", err)
	}

	if len(cases) != 2 {
		t.Fatalf("expected 2 cases, got %d", len(cases))
	}
	if cases[0].ID != "test-1" || cases[0].Expected != "ok" {
		t.Errorf("unexpected case 0: %+v", cases[0])
	}
}

func TestRunHarness(t *testing.T) {
	dir := t.TempDir()
	datasetPath := filepath.Join(dir, "cases.jsonl")

	content := `{"id":"test-echo","prompt":"Echo test","eval_command":"echo pass","expected":"pass"}`
	if err := os.WriteFile(datasetPath, []byte(content), 0644); err != nil {
		t.Fatalf("failed to write test dataset: %v", err)
	}

	var buf bytes.Buffer
	report, err := Run(context.Background(), Options{
		DatasetPath: datasetPath,
		ModelID:     "mock-model",
		Timeout:     5 * time.Second,
		Workspace:   dir,
	}, &buf)

	if err != nil {
		t.Fatalf("Run failed: %v", err)
	}
	if report.TotalCases != 1 || report.PassedCases != 1 {
		t.Errorf("unexpected report: %+v", report)
	}
}
