package tui

import (
	"strings"
	"testing"

	"github.com/99apps-id/termigo/cli/internal/coder"
	"github.com/99apps-id/termigo/cli/internal/config"
	"github.com/99apps-id/termigo/cli/internal/provider"
)

func TestCostReportShowsUnknownThenAPrice(t *testing.T) {
	m := &Model{
		model:   provider.Model{ID: "muse-spark-1.3"},
		session: &coder.Session{Usage: provider.Usage{PromptTokens: 10, CompletionTokens: 5, TotalTokens: 15}},
	}

	report := m.costReport()
	if !strings.Contains(report, "prompt 10") || !strings.Contains(report, "unknown") {
		t.Errorf("report without a price = %q", report)
	}

	m.cfg = config.Config{ModelPrices: map[string]config.ModelPrice{
		"muse-spark-1.3": {InputPerMillion: 3, OutputPerMillion: 15},
	}}
	report = m.costReport()
	if strings.Contains(report, "unknown") || !strings.Contains(report, "cost: ~$") {
		t.Errorf("report with a price = %q", report)
	}
}
