package coder

import "strings"

// Decision is the operator's answer to an approval request.
type Decision int

const (
	// DecisionDeny refuses the call and reports the refusal to the model.
	DecisionDeny Decision = iota
	// DecisionAllowOnce runs this call only.
	DecisionAllowOnce
	// DecisionAllowSession runs this tool for the rest of the session.
	DecisionAllowSession
	// DecisionAllowAlways persists the tool in the always-allowed list.
	DecisionAllowAlways
)

// Allowed reports whether a decision runs the call.
func (d Decision) Allowed() bool { return d != DecisionDeny }

// ApprovalRequest is one tool call waiting on the operator.
type ApprovalRequest struct {
	Tool   string
	Detail string
	Risk   string
	// Diff previews the file change for edit-like tools. It is empty for
	// anything else, and the dialog falls back to the one-line detail.
	Diff string
	// Respond delivers the decision. It must be called exactly once.
	Respond func(Decision)
}

// ApprovalPolicy decides, before the model is consulted, whether a call needs
// the operator at all.
type ApprovalPolicy struct {
	Mode ApprovalMode
	// AlwaysAllowed holds tools the operator allowed permanently.
	AlwaysAllowed map[string]bool
	// SessionAllowed holds tools allowed for this session.
	SessionAllowed map[string]bool
}

// ApprovalMode mirrors config.ApprovalMode without importing it here, which
// keeps the agent package usable from tests without the config file.
type ApprovalMode string

const (
	ApprovalAsk   ApprovalMode = "ask"
	ApprovalEdits ApprovalMode = "edits"
	ApprovalAll   ApprovalMode = "all"
	// ApprovalPlan blocks every mutating tool without asking. The runner
	// enforces it before the approval handshake, so no prompt is shown.
	ApprovalPlan ApprovalMode = "plan"
)

// NeedsApproval reports whether a call must wait.
func (p ApprovalPolicy) NeedsApproval(tool Tool) bool {
	name := tool.Name()
	if p.AlwaysAllowed[name] || p.SessionAllowed[name] {
		return false
	}
	if !tool.Mutating() {
		return false
	}
	switch p.Mode {
	case ApprovalAll:
		return false
	case ApprovalAsk:
		return true
	case ApprovalPlan:
		return true
	case ApprovalEdits:
		// File edits run; commands wait.
		return tool.Risk() != RiskEdit
	default:
		return true
	}
}

// AllowSession records a session-scoped allowance. A nil policy is a valid
// state, because the trust gate can demand approval for a runner that has no
// policy at all, so it is ignored rather than dereferenced.
func (p *ApprovalPolicy) AllowSession(name string) {
	if p == nil {
		return
	}
	if p.SessionAllowed == nil {
		p.SessionAllowed = map[string]bool{}
	}
	p.SessionAllowed[name] = true
}

// Risk classifies what a mutating tool does.
type Risk string

const (
	// RiskEdit changes a file.
	RiskEdit Risk = "edit"
	// RiskCommand runs a process.
	RiskCommand Risk = "command"
	// RiskNetwork reaches outside the machine.
	RiskNetwork Risk = "network"
)

// Shorten collapses whitespace and clips text for a one-line label.
func Shorten(text string, max int) string {
	collapsed := strings.Join(strings.Fields(text), " ")
	if max <= 0 || len(collapsed) <= max {
		return collapsed
	}
	if max <= 1 {
		return clipBytes(collapsed, max)
	}
	return clipBytes(collapsed, max-1) + "..."
}
