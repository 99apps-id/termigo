package control

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
)

type callRecord struct {
	method string
	params map[string]interface{}
}

// fakeCaller records the request and answers with result, or fails with err when
// one is set.
func fakeCaller(t *testing.T, result map[string]interface{}, err error, seen *[]callRecord) Caller {
	t.Helper()
	return func(method string, params map[string]interface{}, _ time.Duration) (map[string]interface{}, error) {
		if seen != nil {
			*seen = append(*seen, callRecord{method: method, params: params})
		}
		if err != nil {
			return nil, err
		}
		return result, nil
	}
}

const catalogueReply = `{
  "providers": [
    {"id": "openai", "label": "OpenAI", "needsKey": true, "consoleUrl": "https://platform.openai.com/api-keys"},
    {"id": "ollama", "label": "Ollama", "needsKey": false, "consoleUrl": ""},
    {"id": "deepseek", "label": "DeepSeek", "needsKey": true, "consoleUrl": "https://platform.deepseek.com/api_keys"}
  ],
  "models": [
    {"id": "deepseek-v4-pro", "provider": "deepseek", "label": "DeepSeek V4 Pro", "description": "flagship", "tags": ["coding"]},
    {"id": "deepseek-v4-flash", "provider": "deepseek", "label": "DeepSeek Flash", "description": "fast", "apiModelId": "deepseek-flash"},
    {"id": "gpt-5", "provider": "openai", "label": "GPT-5", "description": "general"}
  ],
  "current": {"defaultModelId": "deepseek-v4-pro", "configuredProviders": ["deepseek"]}
}`

func decodeReply(t *testing.T, raw string) map[string]interface{} {
	t.Helper()
	var out map[string]interface{}
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		t.Fatalf("decode reply fixture: %v", err)
	}
	return out
}

func TestModelsWithDecodesTheCatalogue(t *testing.T) {
	seen := []callRecord{}
	catalogue, err := ModelsWith(fakeCaller(t, decodeReply(t, catalogueReply), nil, &seen))
	if err != nil {
		t.Fatalf("ModelsWith: %v", err)
	}
	if len(seen) != 1 || seen[0].method != MethodModelsList {
		t.Fatalf("expected one models-list request, got: %+v", seen)
	}
	if len(catalogue.Providers) != 3 || len(catalogue.Models) != 3 {
		t.Fatalf("unexpected catalogue size: %d providers, %d models", len(catalogue.Providers), len(catalogue.Models))
	}
	if catalogue.Current.DefaultModelID != "deepseek-v4-pro" {
		t.Fatalf("unexpected default model: %q", catalogue.Current.DefaultModelID)
	}

	// The provider-side id has to survive decoding: a picker that shows only the
	// registry id misleads about what goes on the wire.
	flash, ok := catalogue.ModelByID("deepseek-v4-flash")
	if !ok || flash.APIModelID != "deepseek-flash" {
		t.Fatalf("expected apiModelId to be decoded, got: %+v", flash)
	}

	// Only key-based providers belong in an onboarding walk, sorted by label.
	needingKey := catalogue.ProvidersNeedingKey()
	if len(needingKey) != 2 {
		t.Fatalf("expected 2 key-based providers, got: %+v", needingKey)
	}
	if needingKey[0].ID != "deepseek" || needingKey[1].ID != "openai" {
		t.Fatalf("expected key providers sorted by label, got: %+v", needingKey)
	}

	if !catalogue.HasKey("deepseek") {
		t.Error("deepseek should be reported as configured")
	}
	if catalogue.HasKey("openai") {
		t.Error("openai should not be reported as configured")
	}
	if models := catalogue.ModelsFor("deepseek"); len(models) != 2 {
		t.Fatalf("expected 2 deepseek models, got: %d", len(models))
	}
	if _, ok := catalogue.ProviderByID("ollama"); !ok {
		t.Error("ollama should be in the catalogue")
	}
}

func TestModelsWithPropagatesAppErrors(t *testing.T) {
	_, err := ModelsWith(fakeCaller(t, nil, fmt.Errorf("unknown_method: unknown control method"), nil))
	if err == nil || !strings.Contains(err.Error(), "unknown_method") {
		t.Fatalf("expected the app error, got: %v", err)
	}
}

func TestModelsWithRejectsAnUnexpectedReply(t *testing.T) {
	// A reply of the wrong shape is a protocol problem, not a crash.
	catalogue, err := ModelsWith(fakeCaller(t, map[string]interface{}{"providers": "not a list"}, nil, nil))
	if err == nil {
		t.Fatalf("expected an error for a wrong-shaped reply, got: %+v", catalogue)
	}
	if !strings.Contains(err.Error(), "unexpected Termigo reply") {
		t.Fatalf("expected an unexpected-reply error, got: %v", err)
	}
}

func TestReadSettingsWithReadsTheWritableAllowlist(t *testing.T) {
	view, err := ReadSettingsWith(fakeCaller(t, map[string]interface{}{
		"config": map[string]interface{}{
			"defaultModelId":     "deepseek-v4-pro",
			"toolSearchEnabled":  true,
			"disabledToolGroups": []interface{}{"browser", "sql"},
			"agentApprovalMode":  "ask",
			"language":           "en",
		},
		"writableKeys": []interface{}{"defaultModelId", "toolSearchEnabled", "disabledToolGroups", "agentApprovalMode"},
	}, nil, nil))
	if err != nil {
		t.Fatalf("ReadSettingsWith: %v", err)
	}
	if view.Settings.DefaultModelID != "deepseek-v4-pro" || !view.Settings.ToolSearchEnabled {
		t.Fatalf("unexpected settings: %+v", view.Settings)
	}
	if len(view.Settings.DisabledToolGroups) != 2 || view.Settings.DisabledToolGroups[0] != "browser" {
		t.Fatalf("unexpected disabled groups: %+v", view.Settings.DisabledToolGroups)
	}
	if len(view.WritableKeys) != 4 {
		t.Fatalf("expected the app's own allowlist, got: %+v", view.WritableKeys)
	}
}

func TestReadSettingsWithToleratesANullDefaultModel(t *testing.T) {
	// The app answers null when no default model is set yet, which is the state
	// every fresh install is in.
	view, err := ReadSettingsWith(fakeCaller(t, map[string]interface{}{
		"config":       map[string]interface{}{"defaultModelId": nil, "agentApprovalMode": "all"},
		"writableKeys": []interface{}{},
	}, nil, nil))
	if err != nil {
		t.Fatalf("ReadSettingsWith: %v", err)
	}
	if view.Settings.DefaultModelID != "" {
		t.Fatalf("expected an empty default model, got: %q", view.Settings.DefaultModelID)
	}
}

func TestSetSettingWithSendsTheKeyAndValue(t *testing.T) {
	seen := []callRecord{}
	change, err := SetSettingWith(fakeCaller(t, map[string]interface{}{"key": "toolSearchEnabled", "value": true}, nil, &seen),
		"toolSearchEnabled", true)
	if err != nil {
		t.Fatalf("SetSettingWith: %v", err)
	}
	if len(seen) != 1 || seen[0].method != MethodConfigSet {
		t.Fatalf("expected one config-set request, got: %+v", seen)
	}
	if seen[0].params["key"] != "toolSearchEnabled" || seen[0].params["value"] != true {
		t.Fatalf("unexpected params: %+v", seen[0].params)
	}
	if change.Key != "toolSearchEnabled" || change.Value != true {
		t.Fatalf("unexpected change: %+v", change)
	}
}

func TestSetSettingWithRejectsAnEmptyKeyBeforeCallingTheApp(t *testing.T) {
	seen := []callRecord{}
	_, err := SetSettingWith(fakeCaller(t, map[string]interface{}{}, nil, &seen), "   ", true)
	if err == nil {
		t.Fatal("expected an empty key to be rejected")
	}
	if len(seen) != 0 {
		t.Fatalf("the app must not be called with an empty key, got: %+v", seen)
	}
}

func TestValidApprovalMode(t *testing.T) {
	for _, mode := range ApprovalModes {
		if !ValidApprovalMode(mode) {
			t.Errorf("%q should be a valid approval mode", mode)
		}
	}
	for _, mode := range []string{"", "never", "ASK", "read-only", "all "} {
		if ValidApprovalMode(mode) {
			t.Errorf("%q should not be a valid approval mode", mode)
		}
	}
}

func TestSetApprovalNormalisesAndSendsTheMode(t *testing.T) {
	seen := []callRecord{}
	change, err := SetApprovalWith(
		fakeCaller(t, map[string]interface{}{"key": "agentApprovalMode", "value": "ask"}, nil, &seen),
		" ASK ",
	)
	if err != nil {
		t.Fatalf("SetApprovalWith: %v", err)
	}
	if seen[0].params["key"] != "agentApprovalMode" || seen[0].params["value"] != "ask" {
		t.Fatalf("expected a normalised mode, got: %+v", seen[0].params)
	}
	if change.Value != "ask" {
		t.Fatalf("unexpected change: %+v", change)
	}
}

func TestSetApprovalRejectsAnUnknownModeWithoutCallingTheApp(t *testing.T) {
	// SetApproval is the only path that reaches agentApprovalMode, so its
	// validation has to be the one the app would apply.
	seen := []callRecord{}
	_, err := SetApprovalWith(fakeCaller(t, map[string]interface{}{}, nil, &seen), "never")
	if err == nil {
		t.Fatal("expected an unknown approval mode to be rejected")
	}
	if !strings.Contains(err.Error(), "ask") {
		t.Fatalf("the error should name the accepted modes, got: %v", err)
	}
	if len(seen) != 0 {
		t.Fatalf("an invalid mode must not reach the app, got: %+v", seen)
	}
}

func TestSetSecretWithSendsTheProviderAndKey(t *testing.T) {
	seen := []callRecord{}
	if err := SetSecretWith(
		fakeCaller(t, map[string]interface{}{"provider": "deepseek"}, nil, &seen),
		"deepseek", "sk-test",
	); err != nil {
		t.Fatalf("SetSecretWith: %v", err)
	}
	if len(seen) != 1 || seen[0].method != MethodSecretSet {
		t.Fatalf("expected one secret-set request, got: %+v", seen)
	}
	if seen[0].params["provider"] != "deepseek" || seen[0].params["value"] != "sk-test" {
		t.Fatalf("the request must carry the provider and key: %+v", seen[0].params)
	}
}

func TestSetSecretWithRejectsEmptyInputBeforeCallingTheApp(t *testing.T) {
	seen := []callRecord{}
	call := fakeCaller(t, map[string]interface{}{}, nil, &seen)
	if err := SetSecretWith(call, "deepseek", "   "); err == nil {
		t.Fatal("expected an empty key to be rejected")
	}
	if err := SetSecretWith(call, "  ", "sk-test"); err == nil {
		t.Fatal("expected an empty provider to be rejected")
	}
	if len(seen) != 0 {
		t.Fatalf("the app must not be called with empty input, got: %+v", seen)
	}
}

func TestParseSettingValue(t *testing.T) {
	cases := []struct {
		key  string
		raw  string
		want interface{}
	}{
		{"toolSearchEnabled", "true", true},
		{"toolSearchEnabled", "0", false},
		{"disabledToolGroups", "browser, sql", []string{"browser", "sql"}},
		{"disabledToolGroups", "", []string{}},
		{"defaultModelId", "deepseek-v4-pro", "deepseek-v4-pro"},
		{"agentApprovalMode", "edits", "edits"},
	}
	for _, tc := range cases {
		got, err := ParseSettingValue(tc.key, tc.raw)
		if err != nil {
			t.Errorf("ParseSettingValue(%q, %q): %v", tc.key, tc.raw, err)
			continue
		}
		if fmt.Sprintf("%v", got) != fmt.Sprintf("%v", tc.want) {
			t.Errorf("ParseSettingValue(%q, %q) = %v, want %v", tc.key, tc.raw, got, tc.want)
		}
	}

	if _, err := ParseSettingValue("toolSearchEnabled", "maybe"); err == nil {
		t.Error("expected a non-boolean to be rejected")
	}
}

func TestSettingKeysForHelpIsSortedAndListsTheApprovalMode(t *testing.T) {
	keys := SettingKeysForHelp()
	// This list is help text only; the app replies with its own. Keeping the two
	// in step is what the count assertion is for.
	if len(keys) != 4 {
		t.Fatalf("expected 4 writable keys, got: %+v", keys)
	}
	for i := 1; i < len(keys); i++ {
		if keys[i-1] > keys[i] {
			t.Fatalf("keys must be sorted for stable help output: %+v", keys)
		}
	}
	found := false
	for _, key := range keys {
		if key == "agentApprovalMode" {
			found = true
		}
	}
	if !found {
		t.Fatalf("the approval mode must be advertised as writable: %+v", keys)
	}
}
