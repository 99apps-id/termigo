package control

import (
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Method names, mirroring termigo_control_protocol. A method that is not
// advertised by the running app comes back as an `unknown_method` error, so
// these are names to try, not a guarantee of the app's build.
const (
	MethodPing         = "ping"
	MethodCapabilities = "capabilities"
	MethodStatus       = "status"
	MethodIdentify     = "identify"
	MethodOpen         = "open"
	MethodFocus        = "focus"
	MethodAgentRun     = "run"
	MethodQuery        = "query"
	MethodRunCommand   = "run-command"
	MethodModelsList   = "models-list"
	MethodConfigGet    = "config-get"
	MethodConfigSet    = "config-set"
	MethodSecretSet    = "secret-set"
)

// ApprovalModes mirrors APPROVAL_MODES in the app's approvalPolicy.ts. It is
// duplicated here only so the CLI can validate an argument and print the
// options without a round trip; the app is the authority and re-validates.
var ApprovalModes = []string{"ask", "edits", "all"}

// DefaultApprovalMode mirrors DEFAULT_APPROVAL_MODE.
const DefaultApprovalMode = "all"

// Caller performs one control request and returns its raw result. The typed
// helpers below take one so they can be driven without a running app.
type Caller func(method string, params map[string]interface{}, timeout time.Duration) (map[string]interface{}, error)

// Live is the Caller that talks to the running app.
func Live() Caller { return CallResult }

// Provider is one provider in the app's registry.
type Provider struct {
	ID         string `json:"id"`
	Label      string `json:"label"`
	NeedsKey   bool   `json:"needsKey"`
	ConsoleURL string `json:"consoleUrl"`
}

// Model is one model the running build ships.
type Model struct {
	ID           string                 `json:"id"`
	Provider     string                 `json:"provider"`
	Label        string                 `json:"label"`
	Hint         string                 `json:"hint"`
	Description  string                 `json:"description"`
	APIModelID   string                 `json:"apiModelId"`
	Capabilities map[string]interface{} `json:"capabilities"`
	Tags         []string               `json:"tags"`
}

// ModelState is what the app currently has configured. ConfiguredProviders
// names providers that already hold a key; the key itself is never sent.
type ModelState struct {
	DefaultModelID      string   `json:"defaultModelId"`
	ConfiguredProviders []string `json:"configuredProviders"`
}

// Catalogue is the app's provider and model registry plus its current state.
type Catalogue struct {
	Providers []Provider `json:"providers"`
	Models    []Model    `json:"models"`
	Current   ModelState `json:"current"`
}

// Settings are the app settings a terminal may read.
type Settings struct {
	DefaultModelID     string   `json:"defaultModelId"`
	ToolSearchEnabled  bool     `json:"toolSearchEnabled"`
	DisabledToolGroups []string `json:"disabledToolGroups"`
	AgentApprovalMode  string   `json:"agentApprovalMode"`
	Language           string   `json:"language"`
}

// SettingsView is the `config-get` reply. WritableKeys is the app's own
// allowlist, so the CLI never has to keep a copy that can drift.
type SettingsView struct {
	Settings     Settings `json:"config"`
	WritableKeys []string `json:"writableKeys"`
}

// SettingChange is the `config-set` reply.
type SettingChange struct {
	Key   string      `json:"key"`
	Value interface{} `json:"value"`
}

func decode[T any](result map[string]interface{}, target *T) error {
	raw, err := json.Marshal(result)
	if err != nil {
		return fmt.Errorf("could not read Termigo reply: %w", err)
	}
	if err := json.Unmarshal(raw, target); err != nil {
		return fmt.Errorf("unexpected Termigo reply: %w", err)
	}
	return nil
}

// ModelsWith lists the providers and models of the running build.
func ModelsWith(call Caller) (*Catalogue, error) {
	result, err := call(MethodModelsList, nil, ReadTimeout)
	if err != nil {
		return nil, err
	}
	var catalogue Catalogue
	if err := decode(result, &catalogue); err != nil {
		return nil, err
	}
	return &catalogue, nil
}

// Models lists the catalogue from the running app.
func Models() (*Catalogue, error) { return ModelsWith(Live()) }

// ReadSettingsWith reads the settings a terminal may see, plus the writable keys.
func ReadSettingsWith(call Caller) (*SettingsView, error) {
	result, err := call(MethodConfigGet, map[string]interface{}{}, ReadTimeout)
	if err != nil {
		return nil, err
	}
	var view SettingsView
	if err := decode(result, &view); err != nil {
		return nil, err
	}
	return &view, nil
}

// ReadSettings reads the app settings from the running app.
func ReadSettings() (*SettingsView, error) { return ReadSettingsWith(Live()) }

// Setting reads one setting by key. An unreadable key is rejected by the app,
// so the error already names the allowed set.
func Setting(key string) (interface{}, error) {
	result, err := CallResult(MethodConfigGet, map[string]interface{}{"key": key}, ReadTimeout)
	if err != nil {
		return nil, err
	}
	return result["value"], nil
}

// SetSettingWith writes one allowlisted setting. Only keys the app lists as
// writable are accepted; anything else is rejected before the settings store is
// touched.
func SetSettingWith(call Caller, key string, value interface{}) (*SettingChange, error) {
	if strings.TrimSpace(key) == "" {
		return nil, fmt.Errorf("a setting key is required")
	}
	result, err := call(MethodConfigSet, map[string]interface{}{"key": key, "value": value}, ReadTimeout)
	if err != nil {
		return nil, err
	}
	var change SettingChange
	if err := decode(result, &change); err != nil {
		return nil, err
	}
	return &change, nil
}

// SetSetting writes one allowlisted setting through the running app.
func SetSetting(key string, value interface{}) (*SettingChange, error) {
	return SetSettingWith(Live(), key, value)
}

// SetApproval switches the agent approval mode.
//
// Deliberately its own function rather than a call to SetSetting: this is a real
// loosening of the approval gate (with nobody at the window, `ask` blocks every
// edit), so the surface that reaches it says so in its name.
func SetApproval(mode string) (*SettingChange, error) {
	return SetApprovalWith(Live(), mode)
}

// SetApprovalWith is SetApproval against an injected caller.
func SetApprovalWith(call Caller, mode string) (*SettingChange, error) {
	normalised := strings.ToLower(strings.TrimSpace(mode))
	if !ValidApprovalMode(normalised) {
		return nil, fmt.Errorf("approval mode must be one of %s", strings.Join(ApprovalModes, ", "))
	}
	return SetSettingWith(call, "agentApprovalMode", normalised)
}

// ValidApprovalMode reports whether mode is one the app accepts.
func ValidApprovalMode(mode string) bool {
	for _, known := range ApprovalModes {
		if known == mode {
			return true
		}
	}
	return false
}

// SetSecret stores a provider API key through the app, which owns the
// platform-correct store: the OS keychain on macOS and Windows, and a 0600
// secrets.json in the app data dir on Linux. The key is never returned, logged
// or echoed back.
func SetSecret(provider, key string) error {
	return SetSecretWith(Live(), provider, key)
}

// SetSecretWith is SetSecret against an injected caller.
func SetSecretWith(call Caller, provider, key string) error {
	if strings.TrimSpace(provider) == "" {
		return fmt.Errorf("a provider id is required")
	}
	if strings.TrimSpace(key) == "" {
		return fmt.Errorf("the API key is empty")
	}
	_, err := call(MethodSecretSet, map[string]interface{}{
		"provider": strings.TrimSpace(provider),
		"value":    key,
	}, ReadTimeout)
	return err
}

// AppStatus reports the running app's version, platform and live agent state.
func AppStatus() (map[string]interface{}, error) {
	return CallResult(MethodStatus, nil, ReadTimeout)
}

// ParseSettingValue turns one command-line argument into the value the app
// expects for that key.
//
// Everything after the key arrives as text, so the CLI has to decide how to read
// it: a flag is a bool, a group list is comma-separated, anything else is text.
// The app type-checks the result again, so a wrong guess is a clear rejection
// rather than a bad write.
func ParseSettingValue(key, raw string) (interface{}, error) {
	switch key {
	case "toolSearchEnabled":
		value, err := strconv.ParseBool(strings.TrimSpace(raw))
		if err != nil {
			return nil, fmt.Errorf("toolSearchEnabled must be true or false")
		}
		return value, nil
	case "disabledToolGroups":
		groups := []string{}
		for _, group := range strings.Split(raw, ",") {
			if trimmed := strings.TrimSpace(group); trimmed != "" {
				groups = append(groups, trimmed)
			}
		}
		return groups, nil
	default:
		return raw, nil
	}
}

// SettingKeysForHelp is the writable set as of this build, for usage text only.
// The app replies with its own list at runtime; this exists so `--help` does not
// require a running app.
func SettingKeysForHelp() []string {
	keys := []string{"defaultModelId", "toolSearchEnabled", "disabledToolGroups", "agentApprovalMode"}
	sort.Strings(keys)
	return keys
}

// FormatSettingValue renders a setting value for a terminal.
//
// The same setting arrives in two shapes: decoded into structs (an array is
// `[]string`) or read raw from JSON by `Setting`, where it is `[]interface{}`.
// Both have to read the same, because a change and the listing that follows it
// print the same value. A list joins with ", " and an empty one reads "none",
// which is what "no groups disabled" means.
func FormatSettingValue(value interface{}) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case []string:
		if len(typed) == 0 {
			return "none"
		}
		return strings.Join(typed, ", ")
	case []interface{}:
		if len(typed) == 0 {
			return "none"
		}
		parts := make([]string, 0, len(typed))
		for _, item := range typed {
			parts = append(parts, fmt.Sprintf("%v", item))
		}
		return strings.Join(parts, ", ")
	case bool:
		if typed {
			return "true"
		}
		return "false"
	case string:
		return typed
	default:
		return fmt.Sprintf("%v", value)
	}
}

// ProvidersNeedingKey are the providers the app reports as key-based, sorted by
// label. This is what an onboarding wizard walks through.
func (c *Catalogue) ProvidersNeedingKey() []Provider {
	out := make([]Provider, 0, len(c.Providers))
	for _, provider := range c.Providers {
		if provider.NeedsKey {
			out = append(out, provider)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Label < out[j].Label })
	return out
}

// ModelsFor returns the models of one provider, in registry order.
func (c *Catalogue) ModelsFor(provider string) []Model {
	out := make([]Model, 0, len(c.Models))
	for _, model := range c.Models {
		if model.Provider == provider {
			out = append(out, model)
		}
	}
	return out
}

// HasKey reports whether the app already holds a key for the provider.
func (c *Catalogue) HasKey(provider string) bool {
	for _, id := range c.Current.ConfiguredProviders {
		if id == provider {
			return true
		}
	}
	return false
}

// ProviderByID finds one provider in the catalogue.
func (c *Catalogue) ProviderByID(id string) (Provider, bool) {
	for _, provider := range c.Providers {
		if provider.ID == id {
			return provider, true
		}
	}
	return Provider{}, false
}

// ModelByID finds one model in the catalogue.
func (c *Catalogue) ModelByID(id string) (Model, bool) {
	for _, model := range c.Models {
		if model.ID == id {
			return model, true
		}
	}
	return Model{}, false
}
