package terminal

import (
	"fmt"
	"strings"
	"testing"

	"github.com/99apps-id/termigo/cli/internal/control"
)

// fakeSession is the app-side surface with no socket behind it, so a whole
// session can be scripted: this is the point of the Session interface.
type fakeSession struct {
	catalogue *control.Catalogue
	settings  *control.SettingsView
	status    map[string]interface{}
	err       error

	secrets   []string
	changes   []string
	approvals []string
}

func (f *fakeSession) Catalogue() (*control.Catalogue, error) {
	if f.err != nil {
		return nil, f.err
	}
	return f.catalogue, nil
}

func (f *fakeSession) Settings() (*control.SettingsView, error) {
	if f.err != nil {
		return nil, f.err
	}
	return f.settings, nil
}

func (f *fakeSession) SetSetting(key string, value interface{}) error {
	if f.err != nil {
		return f.err
	}
	f.changes = append(f.changes, fmt.Sprintf("%s=%v", key, value))
	return nil
}

func (f *fakeSession) SetSecret(provider, key string) error {
	if f.err != nil {
		return f.err
	}
	// The fake never stores the key: a test that found it here would be a test
	// proving the key leaked into a log.
	f.secrets = append(f.secrets, provider+":"+key)
	return nil
}

func (f *fakeSession) SetApproval(mode string) error {
	if f.err != nil {
		return f.err
	}
	f.approvals = append(f.approvals, mode)
	return nil
}

func (f *fakeSession) Status() (map[string]interface{}, error) {
	if f.err != nil {
		return nil, f.err
	}
	return f.status, nil
}

func fixtureCatalogue() *control.Catalogue {
	return &control.Catalogue{
		Providers: []control.Provider{
			{ID: "deepseek", Label: "DeepSeek", NeedsKey: true, ConsoleURL: "https://platform.deepseek.com/api_keys"},
			{ID: "ollama", Label: "Ollama", NeedsKey: false},
			{ID: "openai", Label: "OpenAI", NeedsKey: true},
		},
		Models: []control.Model{
			{ID: "deepseek-v4-pro", Provider: "deepseek", Label: "DeepSeek V4 Pro"},
			{ID: "deepseek-v4-flash", Provider: "deepseek", Label: "Flash"},
			{ID: "gpt-5", Provider: "openai", Label: "GPT-5"},
		},
		Current: control.ModelState{DefaultModelID: "deepseek-v4-pro"},
	}
}

func fixtureSettings() *control.SettingsView {
	return &control.SettingsView{
		Settings: control.Settings{
			DefaultModelID:    "deepseek-v4-pro",
			ToolSearchEnabled: true,
			AgentApprovalMode: "all",
			Language:          "en",
		},
		WritableKeys: []string{"defaultModelId", "toolSearchEnabled", "disabledToolGroups", "agentApprovalMode"},
	}
}

func newFakeSession() *fakeSession {
	return &fakeSession{
		catalogue: fixtureCatalogue(),
		settings:  fixtureSettings(),
		status: map[string]interface{}{
			"app_version": "0.9.3",
			"os":          "linux",
			"ui": map[string]interface{}{
				"agent":        map[string]interface{}{"status": "thinking"},
				"model":        map[string]interface{}{"id": "deepseek-v4-pro"},
				"costTodayUsd": 1.25,
			},
		},
	}
}

// runScript drives one whole session from scripted input. Echo masking is
// stubbed here so no test can leave the real console silent.
func runScript(t *testing.T, session *fakeSession, input string) string {
	t.Helper()
	stubEcho(t, true)
	out := &strings.Builder{}
	if err := RunWith(strings.NewReader(input), out, session); err != nil {
		t.Fatalf("RunWith: %v", err)
	}
	return out.String()
}

func TestRunWithShowsTheBannerAndQuits(t *testing.T) {
	output := runScript(t, newFakeSession(), "q\n")
	if !strings.Contains(output, "_____ ") {
		t.Fatalf("the welcome screen must show the wordmark: %q", output)
	}
	if !strings.Contains(output, "Termigo terminal") || !strings.Contains(output, "Bye.") {
		t.Fatalf("unexpected welcome screen: %q", output)
	}
}

func TestRunWithEndsAtEndOfInput(t *testing.T) {
	// A piped or closed stdin must end the session cleanly, not spin or fail.
	if output := runScript(t, newFakeSession(), ""); !strings.Contains(output, "_____ ") {
		t.Fatalf("expected the banner before the end of input: %q", output)
	}
}

func TestRunWithRejectsAnUnknownChoiceButContinues(t *testing.T) {
	output := runScript(t, newFakeSession(), "9\nq\n")
	if !strings.Contains(output, "not one of the choices") {
		t.Fatalf("expected a message about the choice: %q", output)
	}
	if !strings.Contains(output, "Bye.") {
		t.Fatalf("the session should continue after a bad choice: %q", output)
	}
}

func TestSetupStoresTheKeyAndTheModel(t *testing.T) {
	session := newFakeSession()
	// menu, provider 1 (DeepSeek), the key, model 1, quit.
	output := runScript(t, session, "1\n1\nsk-test\n1\nq\n")
	if len(session.secrets) != 1 || session.secrets[0] != "deepseek:sk-test" {
		t.Fatalf("expected the key to be stored once, got: %v", session.secrets)
	}
	if len(session.changes) != 1 || session.changes[0] != "defaultModelId=deepseek-v4-pro" {
		t.Fatalf("expected the default model to be set, got: %v", session.changes)
	}
	if !strings.Contains(output, "Stored a key for DeepSeek.") {
		t.Fatalf("expected a confirmation: %q", output)
	}
	if !strings.Contains(output, "platform.deepseek.com") {
		t.Fatalf("expected the console hint: %q", output)
	}
}

func TestSetupDecliningAReplaceKeepsTheStoredKey(t *testing.T) {
	session := newFakeSession()
	session.catalogue.Current.ConfiguredProviders = []string{"deepseek"}
	output := runScript(t, session, "1\n1\nn\nq\n")
	if len(session.secrets) != 0 {
		t.Fatalf("a declined replace must not overwrite the key: %v", session.secrets)
	}
	if !strings.Contains(output, "Kept the stored key.") {
		t.Fatalf("expected the kept-key message: %q", output)
	}
}

func TestSetupReplacingAStoredKey(t *testing.T) {
	session := newFakeSession()
	session.catalogue.Current.ConfiguredProviders = []string{"deepseek"}
	runScript(t, session, "1\n1\ny\nsk-new\n1\nq\n")
	if len(session.secrets) != 1 || session.secrets[0] != "deepseek:sk-new" {
		t.Fatalf("an accepted replace must store the new key: %v", session.secrets)
	}
}

func TestSetupCancelsOnAnEmptyKey(t *testing.T) {
	session := newFakeSession()
	output := runScript(t, session, "1\n1\n\nq\n")
	if len(session.secrets) != 0 || len(session.changes) != 0 {
		t.Fatalf("an empty key must change nothing: %v %v", session.secrets, session.changes)
	}
	if !strings.Contains(output, "Cancelled.") {
		t.Fatalf("expected a cancellation: %q", output)
	}
}

func TestSetupCancelsOnAnEmptyProviderAnswer(t *testing.T) {
	session := newFakeSession()
	output := runScript(t, session, "1\n\nq\n")
	if len(session.secrets) != 0 {
		t.Fatalf("an empty provider answer must store nothing: %v", session.secrets)
	}
	if !strings.Contains(output, "Cancelled.") {
		t.Fatalf("expected a cancellation: %q", output)
	}
}

func TestFlowsReportAStoppedAppInsteadOfEnding(t *testing.T) {
	session := newFakeSession()
	session.err = fmt.Errorf("Termigo is not running")
	for _, choice := range []string{"1", "2", "3", "4", "5"} {
		output := runScript(t, session, choice+"\nq\n")
		if !strings.Contains(output, "The Termigo app must be running") {
			t.Fatalf("choice %s should explain that the app is down: %q", choice, output)
		}
		if !strings.Contains(output, "Bye.") {
			t.Fatalf("choice %s must return to the menu: %q", choice, output)
		}
	}
}

func TestPickModelListsTheCatalogueAndSetsTheChoice(t *testing.T) {
	session := newFakeSession()
	output := runScript(t, session, "2\n2\nq\n")
	if len(session.changes) != 1 || session.changes[0] != "defaultModelId=deepseek-v4-flash" {
		t.Fatalf("expected the second model to be set: %v", session.changes)
	}
	if !strings.Contains(output, "[current]") {
		t.Fatalf("the pick list must mark the current model: %q", output)
	}
	if !strings.Contains(output, "DeepSeek V4 Pro (DeepSeek)") {
		t.Fatalf("the pick list should name the provider: %q", output)
	}
}

func TestPickModelDoesNothingWhenTheChoiceIsAlreadyCurrent(t *testing.T) {
	session := newFakeSession()
	output := runScript(t, session, "2\n1\nq\n")
	if len(session.changes) != 0 {
		t.Fatalf("an unchanged pick must not write: %v", session.changes)
	}
	if !strings.Contains(output, "already the default") {
		t.Fatalf("expected an explanation: %q", output)
	}
}

func TestSettingsShowsTheValuesAndWritableKeys(t *testing.T) {
	output := runScript(t, newFakeSession(), "3\n\nq\n")
	for _, want := range []string{"defaultModelId", "agentApprovalMode", "toolSearchEnabled", "disabledToolGroups", "language", "deepseek-v4-pro"} {
		if !strings.Contains(output, want) {
			t.Fatalf("the settings screen should show %q: %q", want, output)
		}
	}
}

func TestSettingsChangesADefaultModel(t *testing.T) {
	session := newFakeSession()
	runScript(t, session, "3\n1\ndeepseek-v4-flash\nq\n")
	if len(session.changes) != 1 || session.changes[0] != "defaultModelId=deepseek-v4-flash" {
		t.Fatalf("expected the model to change: %v", session.changes)
	}
}

func TestSettingsParsesABoolean(t *testing.T) {
	session := newFakeSession()
	// Key 2 is toolSearchEnabled; the value has to reach the app as a bool, not
	// as the string "false".
	runScript(t, session, "3\n2\nfalse\nq\n")
	if len(session.changes) != 1 || session.changes[0] != "toolSearchEnabled=false" {
		t.Fatalf("expected a boolean change: %v", session.changes)
	}
}

func TestSettingsClearsTheToolGroupList(t *testing.T) {
	session := newFakeSession()
	// Key 3 is disabledToolGroups; an empty answer is valid here and means "no
	// groups disabled", which is why this flow cannot treat empty as a cancel.
	runScript(t, session, "3\n3\n\nq\n")
	if len(session.changes) != 1 || session.changes[0] != "disabledToolGroups=[]" {
		t.Fatalf("expected the list to be cleared: %v", session.changes)
	}
}

func TestSettingsRoutesTheApprovalModeThroughSetApproval(t *testing.T) {
	session := newFakeSession()
	// Key 4 is agentApprovalMode. It must not travel as a plain setting: it
	// loosens the approval gate, so it goes through SetApproval.
	runScript(t, session, "3\n4\nask\nq\n")
	if len(session.approvals) != 1 || session.approvals[0] != "ask" {
		t.Fatalf("expected the approval mode to change: %v", session.approvals)
	}
	if len(session.changes) != 0 {
		t.Fatalf("the approval mode must not be written as a plain setting: %v", session.changes)
	}
}

func TestSettingsRejectsABadValueWithoutWriting(t *testing.T) {
	session := newFakeSession()
	output := runScript(t, session, "3\n2\nmaybe\nq\n")
	if len(session.changes) != 0 {
		t.Fatalf("a bad value must not reach the app: %v", session.changes)
	}
	if !strings.Contains(output, "true or false") {
		t.Fatalf("expected the parse error: %q", output)
	}
}

func TestSettingsCancelsOnAnEmptyValue(t *testing.T) {
	session := newFakeSession()
	output := runScript(t, session, "3\n1\n\nq\n")
	if len(session.changes) != 0 {
		t.Fatalf("an empty value must cancel: %v", session.changes)
	}
	if !strings.Contains(output, "Cancelled.") {
		t.Fatalf("expected a cancellation: %q", output)
	}
}

func TestApprovalMenuSetsTheMode(t *testing.T) {
	session := newFakeSession()
	output := runScript(t, session, "4\n1\nq\n")
	if len(session.approvals) != 1 || session.approvals[0] != "ask" {
		t.Fatalf("expected ask to be set: %v", session.approvals)
	}
	if !strings.Contains(output, "Approval mode is now ask.") {
		t.Fatalf("expected a confirmation: %q", output)
	}
}

func TestApprovalMenuSkipsAnUnchangedMode(t *testing.T) {
	session := newFakeSession()
	session.settings.Settings.AgentApprovalMode = "ask"
	output := runScript(t, session, "4\n1\nq\n")
	if len(session.approvals) != 0 {
		t.Fatalf("an unchanged mode must not be written: %v", session.approvals)
	}
	if !strings.Contains(output, "Already ask.") {
		t.Fatalf("expected an explanation: %q", output)
	}
}

func TestApprovalMenuCancels(t *testing.T) {
	session := newFakeSession()
	output := runScript(t, session, "4\n\nq\n")
	if len(session.approvals) != 0 {
		t.Fatalf("an empty answer must cancel: %v", session.approvals)
	}
	if !strings.Contains(output, "Cancelled.") {
		t.Fatalf("expected a cancellation: %q", output)
	}
}

func TestStatusPrintsTheLiveState(t *testing.T) {
	output := runScript(t, newFakeSession(), "5\nq\n")
	for _, want := range []string{"0.9.3", "linux", "thinking", "deepseek-v4-pro", "spend today", "1.25"} {
		if !strings.Contains(output, want) {
			t.Fatalf("status should include %q: %q", want, output)
		}
	}
}

func TestStatusSurvivesAPartialPayload(t *testing.T) {
	session := newFakeSession()
	session.status = map[string]interface{}{}
	output := runScript(t, session, "5\nq\n")
	if !strings.Contains(output, "may still be starting up") {
		t.Fatalf("expected an explanation for an empty payload: %q", output)
	}
}

func TestSetupOnlyOffersProvidersThatNeedAKey(t *testing.T) {
	session := newFakeSession()
	output := runScript(t, session, "1\n\nq\n")
	if strings.Contains(output, "1. Ollama") {
		t.Fatalf("a keyless provider must not be offered in setup: %q", output)
	}
	if !strings.Contains(output, "1. DeepSeek") || !strings.Contains(output, "2. OpenAI") {
		t.Fatalf("expected the key-based providers sorted by name: %q", output)
	}
}

func TestSetupWithNoKeyBasedProviderExplainsItself(t *testing.T) {
	session := newFakeSession()
	session.catalogue.Providers = []control.Provider{{ID: "ollama", Label: "Ollama"}}
	output := runScript(t, session, "1\nq\n")
	if !strings.Contains(output, "No provider in this build uses an API key") {
		t.Fatalf("expected an explanation: %q", output)
	}
}

func TestReadSecretReportsTheEndOfInput(t *testing.T) {
	stubEcho(t, true)
	if _, err := ReadSecret(strings.NewReader(""), &strings.Builder{}, "API key: "); err == nil {
		t.Fatal("expected an error when the input ends before an answer")
	}
}
