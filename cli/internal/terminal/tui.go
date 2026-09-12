package terminal

import (
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/99apps-id/termigo/cli/internal/control"
)

// errNoInput is what a prompt returns when stdin ends before an answer, which is
// how a piped or closed session stops.
var errNoInput = errors.New("no input")

// Session is the app-facing surface the terminal drives. It is an interface so
// the whole flow can be exercised with a fake app, and so the menu never has to
// know that the commands behind it cross a socket.
type Session interface {
	Catalogue() (*control.Catalogue, error)
	Settings() (*control.SettingsView, error)
	SetSetting(key string, value interface{}) error
	SetSecret(provider, key string) error
	SetApproval(mode string) error
	Status() (map[string]interface{}, error)
}

// liveSession drives the running Termigo.
type liveSession struct{}

func (liveSession) Catalogue() (*control.Catalogue, error) { return control.Models() }

func (liveSession) Settings() (*control.SettingsView, error) { return control.ReadSettings() }

func (liveSession) SetSetting(key string, value interface{}) error {
	_, err := control.SetSetting(key, value)
	return err
}

func (liveSession) SetSecret(provider, key string) error {
	return control.SetSecret(provider, key)
}

func (liveSession) SetApproval(mode string) error {
	_, err := control.SetApproval(mode)
	return err
}

func (liveSession) Status() (map[string]interface{}, error) { return control.AppStatus() }

// Run starts the interactive terminal against the running app.
func Run(in io.Reader, out io.Writer) error {
	return RunWith(in, out, liveSession{})
}

// Setup runs only the onboarding wizard, for `termigo setup`.
func Setup(in io.Reader, out io.Writer) error {
	ui := newUI(in, out)
	ui.println(Banner())
	ui.println("")
	ui.setup(liveSession{})
	return nil
}

// ReadSecret prompts for one secret on a bare stream pair, for the
// non-interactive commands that need a single value.
func ReadSecret(in io.Reader, out io.Writer, prompt string) (string, error) {
	value, ok := newUI(in, out).secret(prompt)
	if !ok {
		return "", errNoInput
	}
	return value, nil
}

// RunWith is Run against an injected session, which is what makes the menu and
// every flow testable without a running Termigo.
//
// It owns the loop, so an action that fails returns to the menu instead of
// ending the terminal: on a headless box the terminal is the operator's only
// handle on the app, and one failed call must not take it away.
func RunWith(in io.Reader, out io.Writer, session Session) error {
	ui := newUI(in, out)
	ui.welcome()

	for {
		choice, ok := ui.menu()
		if !ok {
			return nil
		}
		switch choice {
		case "1":
			ui.setup(session)
		case "2":
			ui.pickModel(session)
		case "3":
			ui.editSettings(session)
		case "4":
			ui.approval(session)
		case "5":
			ui.status(session)
		case "q":
			ui.println("Bye.")
			return nil
		default:
			ui.printf("%q is not one of the choices.\n", choice)
		}
	}
}

// Welcome prints the opening screen: the wordmark, what this is, and the one
// rule of the interface (a number, then Enter).
func (u *ui) welcome() {
	u.println(Banner())
	u.println("")
	u.println("  Termigo terminal")
	u.println("  Models, settings, approval and API keys for the running app.")
	u.println("  Pick a number and press Enter; q quits.")
}

func (u *ui) menu() (string, bool) {
	u.println("")
	u.println("  1  Setup      store an API key and choose the default model")
	u.println("  2  Models     list the models and choose the default")
	u.println("  3  Settings   show and change app settings")
	u.println("  4  Approval   show and change the agent approval mode")
	u.println("  5  Status     show the running app's live state")
	u.println("  q  Quit")
	u.println("")
	answer, ok := u.line("Choice: ")
	if !ok {
		return "", false
	}
	return strings.ToLower(answer), true
}

// setup is the onboarding walk: provider, key, default model.
func (u *ui) setup(session Session) {
	catalogue, err := session.Catalogue()
	if err != nil {
		u.failed("read the model catalogue", err)
		u.offlineHint()
		return
	}
	providers := catalogue.ProvidersNeedingKey()
	if len(providers) == 0 {
		u.println("No provider in this build uses an API key; choose the default model from Models.")
		return
	}

	labels := make([]string, 0, len(providers))
	for _, provider := range providers {
		label := provider.Label
		if catalogue.HasKey(provider.ID) {
			label += " (key stored)"
		}
		labels = append(labels, label)
	}
	index, ok := u.choose("Provider: ", labels)
	if !ok {
		return
	}
	if index == 0 {
		u.println("Cancelled.")
		return
	}
	provider := providers[index-1]

	if catalogue.HasKey(provider.ID) {
		replace, ok := u.confirm(fmt.Sprintf("%s already has a key. Replace it? (y/N) ", provider.Label))
		if !ok {
			return
		}
		if !replace {
			u.println("Kept the stored key.")
			return
		}
	}

	if provider.ConsoleURL != "" {
		u.printf("Get a key at %s\n", provider.ConsoleURL)
	}
	key, ok := u.secret("API key (not shown, Enter to cancel): ")
	if !ok {
		return
	}
	if key == "" {
		u.println("Cancelled.")
		return
	}
	if err := session.SetSecret(provider.ID, key); err != nil {
		u.failed("store the key", err)
		return
	}
	u.printf("Stored a key for %s.\n", provider.Label)

	models := catalogue.ModelsFor(provider.ID)
	if len(models) == 0 {
		u.println("This provider has no model in the registry; pick one from Models.")
		return
	}
	modelIndex, ok := u.choose("Default model: ", modelLabels(models, catalogue.Current.DefaultModelID))
	if !ok {
		return
	}
	if modelIndex == 0 {
		u.println("Key stored. No default model was set.")
		return
	}
	model := models[modelIndex-1]
	if err := session.SetSetting("defaultModelId", model.ID); err != nil {
		u.failed("set the default model", err)
		return
	}
	u.printf("Default model is now %s.\n", model.Label)
	u.println("")
	u.println("Next: run 'termigo approval ask' if an edit should be confirmed before it runs,")
	u.println("or 'termigo tui' again to change anything else.")
}

// pickModel lists the whole catalogue and sets the default.
func (u *ui) pickModel(session Session) {
	catalogue, err := session.Catalogue()
	if err != nil {
		u.failed("read the model catalogue", err)
		u.offlineHint()
		return
	}
	choices := []modelChoice{}
	for _, provider := range catalogue.Providers {
		for _, model := range catalogue.ModelsFor(provider.ID) {
			choices = append(choices, modelChoice{id: model.ID, label: fmt.Sprintf("%s (%s)", model.Label, provider.Label)})
		}
	}
	if len(choices) == 0 {
		u.println("This build reports no models.")
		return
	}

	labels := make([]string, 0, len(choices))
	current := catalogue.Current.DefaultModelID
	for _, choice := range choices {
		label := choice.label
		if choice.id == current {
			label += "  [current]"
		}
		labels = append(labels, label)
	}
	index, ok := u.choose("Default model: ", labels)
	if !ok {
		return
	}
	if index == 0 {
		u.println("Cancelled.")
		return
	}
	chosen := choices[index-1]
	if chosen.id == current {
		u.printf("%s is already the default.\n", chosen.label)
		return
	}
	if err := session.SetSetting("defaultModelId", chosen.id); err != nil {
		u.failed("set the default model", err)
		return
	}
	u.printf("Default model is now %s.\n", chosen.label)
}

// editSettings shows the current values, then changes one.
func (u *ui) editSettings(session Session) {
	view, err := session.Settings()
	if err != nil {
		u.failed("read the settings", err)
		u.offlineHint()
		return
	}

	u.println("Current settings:")
	for _, key := range settingsOrder {
		u.printf("  %-20s %s\n", key, settingsValue(view, key))
	}

	writable := view.WritableKeys
	if len(writable) == 0 {
		u.println("The app reports no writable keys.")
		return
	}
	index, ok := u.choose("Change which key? ", writable)
	if !ok {
		return
	}
	if index == 0 {
		u.println("Cancelled.")
		return
	}
	key := writable[index-1]

	hint := "New value: "
	switch key {
	case "toolSearchEnabled":
		hint = "New value (true or false): "
	case "disabledToolGroups":
		hint = "New value (comma separated, empty to clear): "
	case "agentApprovalMode":
		hint = fmt.Sprintf("New value (%s): ", strings.Join(control.ApprovalModes, ", "))
	}
	raw, ok := u.line(hint)
	if !ok {
		return
	}
	if raw == "" && key != "disabledToolGroups" {
		u.println("Cancelled.")
		return
	}

	value, err := control.ParseSettingValue(key, raw)
	if err != nil {
		u.failed("read the value", err)
		return
	}
	// The approval mode is not just another setting: it decides whether an edit
	// runs unconfirmed, so it goes through the one function that says so.
	if key == "agentApprovalMode" {
		mode, text := value.(string)
		if !text {
			u.println("The approval mode has to be one of " + strings.Join(control.ApprovalModes, ", ") + ".")
			return
		}
		if err := session.SetApproval(mode); err != nil {
			u.failed("set the approval mode", err)
			return
		}
		u.printf("%s is now %s.\n", key, mode)
		return
	}
	if err := session.SetSetting(key, value); err != nil {
		u.failed("change the setting", err)
		return
	}
	u.printf("%s is now %s.\n", key, control.FormatSettingValue(value))
}

// approval shows and changes the agent approval mode.
func (u *ui) approval(session Session) {
	// The current mode is read first, and a failure to read it is reported
	// rather than treated as "unknown": without the app there is nothing to
	// change either, so the flow has to stop here with the real reason.
	view, err := session.Settings()
	if err != nil {
		u.failed("read the approval mode", err)
		u.offlineHint()
		return
	}
	current := view.Settings.AgentApprovalMode

	options := make([]string, 0, len(control.ApprovalModes))
	for _, mode := range control.ApprovalModes {
		label := mode
		switch mode {
		case "ask":
			label += "   every edit and command waits for you"
		case "edits":
			label += "   file edits run, commands wait"
		case "all":
			label += "   nothing waits (the default)"
		}
		if mode == current {
			label += "  [current]"
		}
		options = append(options, label)
	}
	u.printf("Approval mode: %s\n", fallback(current, "unknown"))
	index, ok := u.choose("Mode: ", options)
	if !ok {
		return
	}
	if index == 0 {
		u.println("Cancelled.")
		return
	}
	mode := control.ApprovalModes[index-1]
	if mode == current {
		u.printf("Already %s.\n", mode)
		return
	}
	if err := session.SetApproval(mode); err != nil {
		u.failed("set the approval mode", err)
		return
	}
	u.printf("Approval mode is now %s.\n", mode)
	if mode == "all" {
		u.println("Nothing will wait for confirmation from here on.")
	}
}

// status prints the running app's live state.
func (u *ui) status(session Session) {
	result, err := session.Status()
	if err != nil {
		u.failed("read the status", err)
		u.offlineHint()
		return
	}
	rows := []struct{ label, path string }{
		{"version", "app_version"},
		{"platform", "os"},
		{"arch", "arch"},
		{"agent", "ui.agent.status"},
		{"step", "ui.agent.step"},
		{"stop reason", "ui.agent.stopReason"},
		{"model", "ui.model.id"},
		{"workspace", "ui.workspace.root"},
		{"session", "ui.session.activeId"},
	}
	shown := 0
	for _, row := range rows {
		value := nestedString(result, row.path)
		if value == "" {
			continue
		}
		u.printf("  %-12s %s\n", row.label, value)
		shown++
	}
	if cost := nestedString(result, "ui.costTodayUsd"); cost != "" {
		u.printf("  %-12s $%s\n", "spend today", cost)
		shown++
	}
	if shown == 0 {
		u.println("The app answered without any state; it may still be starting up.")
	}
}

type modelChoice struct {
	id    string
	label string
}

// modelLabels describes each model, marking the one currently in use.
func modelLabels(models []control.Model, current string) []string {
	labels := make([]string, 0, len(models))
	for _, model := range models {
		label := model.Label
		if model.APIModelID != "" && model.APIModelID != model.ID {
			label += fmt.Sprintf(" (%s)", model.APIModelID)
		}
		if model.ID == current {
			label += "  [current]"
		}
		labels = append(labels, label)
	}
	return labels
}

// settingsOrder is the order the settings are shown in: the ones that change
// what the agent does first, the cosmetic one last.
var settingsOrder = []string{
	"defaultModelId",
	"agentApprovalMode",
	"toolSearchEnabled",
	"disabledToolGroups",
	"language",
}

func settingsValue(view *control.SettingsView, key string) string {
	settings := view.Settings
	switch key {
	case "defaultModelId":
		return fallback(settings.DefaultModelID, "not set")
	case "agentApprovalMode":
		return fallback(settings.AgentApprovalMode, "unknown")
	case "toolSearchEnabled":
		if settings.ToolSearchEnabled {
			return "true"
		}
		return "false"
	case "disabledToolGroups":
		if len(settings.DisabledToolGroups) == 0 {
			return "none"
		}
		return strings.Join(settings.DisabledToolGroups, ", ")
	case "language":
		return fallback(settings.Language, "unknown")
	default:
		return "unknown"
	}
}

// nestedString reads a dotted path out of a decoded JSON object, returning ""
// when any step is missing. The app's status payload is nested and optional, so
// every read has to tolerate an absent branch.
func nestedString(object map[string]interface{}, path string) string {
	var current interface{} = object
	for _, step := range strings.Split(path, ".") {
		asMap, ok := current.(map[string]interface{})
		if !ok {
			return ""
		}
		current, ok = asMap[step]
		if !ok || current == nil {
			return ""
		}
	}
	return strings.TrimSpace(fmt.Sprintf("%v", current))
}

func fallback(value, when string) string {
	if strings.TrimSpace(value) == "" {
		return when
	}
	return value
}
