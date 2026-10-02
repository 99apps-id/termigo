package provider

import (
	"context"
	"os"
	"strings"

	"github.com/99apps-id/termigo/cli/internal/oauth"
	"github.com/99apps-id/termigo/cli/internal/secrets"
)

// OAuthStore returns the token store bound to a secret store.
func OAuthStore(store *secrets.Store) *oauth.Store { return oauth.NewStore(store) }

// UsesOAuth reports whether a provider logs in with OAuth instead of a key.
func UsesOAuth(id string) bool {
	info, ok := ByID(id)
	return ok && info.OAuth
}

// EnvKey returns a provider key from the environment, which lets CI and shell
// profiles work without touching the local store.
func EnvKey(id string) string {
	info, ok := ByID(id)
	if !ok {
		return ""
	}
	for _, name := range info.EnvKeys {
		if value := strings.TrimSpace(os.Getenv(name)); value != "" {
			return value
		}
	}
	return ""
}

// ResolveKey returns the credential for a provider: an OAuth access token for
// a login provider, otherwise the stored secret, then the environment.
func ResolveKey(store *secrets.Store, id string) string {
	if UsesOAuth(id) {
		return oauth.AccessToken(context.Background(), oauth.NewStore(store), id)
	}
	if store != nil {
		if value := strings.TrimSpace(store.Get(secrets.ProviderKey(id))); value != "" {
			return value
		}
	}
	return EnvKey(id)
}

// ResolverFor returns a KeyResolver bound to a secret store.
func ResolverFor(store *secrets.Store) KeyResolver {
	return func(id string) string { return ResolveKey(store, id) }
}
