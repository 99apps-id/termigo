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
	return "Read one environment variable. A value that is a stored credential, or whose name looks like one, is masked and cannot be revealed."
}
func (t *envGetTool) Schema() map[string]any {
	return object(map[string]any{
		"name": strProp("Environment variable name to read (e.g. PATH, GOPATH, NODE_ENV)."),
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
	if val == "" {
		return Result{Output: fmt.Sprintf("%s is set to an empty string.", name)}, nil
	}

	// The name test misses a credential stored under a plain name, and a value
	// test is what catches one the secret store already holds. Neither can be
	// overridden: a reveal flag would hand the model every stored key.
	if isSensitiveEnvName(name) || isStoredSecret(env, val) {
		return Result{Output: fmt.Sprintf("%s=[REDACTED]", name)}, nil
	}

	return Result{Output: fmt.Sprintf("%s=%s", name, val)}, nil
}

// isStoredSecret reports whether a value is one of the credentials the secret
// store holds. A short value is not compared: too many ordinary variables
// collide with a two-character secret.
func isStoredSecret(env *Env, value string) bool {
	if env == nil || env.Secrets == nil || len(value) < 8 {
		return false
	}
	for _, key := range env.Secrets.Keys() {
		if candidate := env.Secrets.Get(key); candidate != "" && candidate == value {
			return true
		}
	}
	return false
}
