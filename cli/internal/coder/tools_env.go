package coder

import (
	"context"
	"fmt"
	"os"
	"strings"
)

type envGetTool struct{}

func (t *envGetTool) Name() string      { return "env_get" }
func (t *envGetTool) Aliases() []string { return []string{"get_env"} }
func (t *envGetTool) Mutating() bool    { return false }
func (t *envGetTool) Risk() Risk        { return RiskCommand }
func (t *envGetTool) Label(a map[string]any) string {
	return "Reading environment " + Shorten(argString(a, "name"), 30)
}
func (t *envGetTool) DoneLabel(a map[string]any) string {
	return "Read environment " + Shorten(argString(a, "name"), 30)
}
func (t *envGetTool) Description() string {
	return "Read the value of an environment variable. Sensitive credentials such as API keys, tokens, and passwords are automatically masked unless unmask is explicitly requested."
}
func (t *envGetTool) Schema() map[string]any {
	return object(map[string]any{
		"name":   strProp("Environment variable name to read (e.g. PATH, GOPATH, NODE_ENV)."),
		"unmask": boolProp("Display the full value even if the name indicates a sensitive credential."),
	}, "name")
}

func isSensitiveEnvName(name string) bool {
	upper := strings.ToUpper(name)
	sensitivePatterns := []string{
		"KEY", "SECRET", "TOKEN", "PASSWORD", "PASSWD",
		"AUTH", "CREDENTIAL", "PRIVATE", "SIGNING", "APIKEY",
	}
	for _, pattern := range sensitivePatterns {
		if strings.Contains(upper, pattern) {
			return true
		}
	}
	return false
}

func (t *envGetTool) Run(ctx context.Context, env *Env, args map[string]any) (Result, error) {
	name := strings.TrimSpace(argString(args, "name", "variable"))
	if name == "" {
		return Result{Output: "Environment variable name is required.", IsError: true}, nil
	}

	val, set := os.LookupEnv(name)
	if !set {
		return Result{Output: fmt.Sprintf("Environment variable %s is not set.", name)}, nil
	}

	unmask := argBool(args, "unmask", false)
	if isSensitiveEnvName(name) && !unmask {
		if val == "" {
			return Result{Output: fmt.Sprintf("%s is set to an empty string.", name)}, nil
		}
		// Mask value
		return Result{
			Output: fmt.Sprintf("%s=[REDACTED: value masked because name indicates a sensitive credential. Pass unmask=true to reveal]", name),
		}, nil
	}

	return Result{Output: fmt.Sprintf("%s=%s", name, val)}, nil
}
