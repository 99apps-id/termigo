package tgbridge

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"math/big"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/99apps-id/termigo/cli/internal/config"
	"github.com/99apps-id/termigo/cli/internal/provider"
	"github.com/99apps-id/termigo/cli/internal/secrets"
	"github.com/99apps-id/termigo/cli/internal/telegram"
)

// secret keys the bridge keeps in the CLI's own store.
const (
	tokenKey   = "telegram:token"
	chatKey    = "telegram:chat"
	ownerKey   = "telegram:owner"
	pairingKey = "telegram:pairing"
)

// SaveToken stores the bot token.
func SaveToken(store *secrets.Store, token string) error {
	trimmed := strings.TrimSpace(token)
	if trimmed == "" {
		return errors.New("the bot token is empty")
	}
	return store.Set(tokenKey, trimmed)
}

// Status reports whether a token is stored, whether a chat is paired, and the
// active pairing code.
func Status(store *secrets.Store) string {
	token := store.Get(tokenKey)
	chat := store.Get(chatKey)
	code := store.Get(pairingKey)
	switch {
	case strings.TrimSpace(token) == "":
		return "telegram: no bot token; run 'termigo telegram <token>'"
	case strings.TrimSpace(chat) != "":
		return "telegram: paired to chat " + chat
	default:
		return "telegram: waiting for /pair (code " + code + ")"
	}
}

// FirstAvailableModel returns the first catalogue model whose provider has a
// usable credential, so the bot has something to run without a flag.
func FirstAvailableModel(store *secrets.Store) (provider.Model, bool) {
	for _, model := range provider.Models() {
		if provider.ResolveKey(store, model.Provider) != "" {
			return model, true
		}
	}
	return provider.Model{}, false
}

// Run starts the bot and blocks until ctx ends.
func Run(ctx context.Context, store *secrets.Store, workspace string, model provider.Model, stdout io.Writer) error {
	token := strings.TrimSpace(store.Get(tokenKey))
	if token == "" {
		return errors.New("no bot token; run 'termigo telegram <token>' first")
	}
	agent, err := NewAgent(store, workspace, model)
	if err != nil {
		return err
	}

	bot := telegram.New(token, agent)
	bot.Pair(pairingChat(store))
	code := ensurePairingCode(store)
	bot.SetPairingCode(code)
	if id := telegram.BotIDFromToken(token); id != "" {
		if home, err := config.EnsureHome(); err == nil {
			bot.SetCursorPath(filepath.Join(home, "telegram-offset-"+id+".txt"))
		}
	}
	bot.Log = func(line string) { fmt.Fprintln(stdout, "telegram:", line) }
	bot.OnPaired = func(chatID, ownerUserID int64) {
		_ = store.Set(chatKey, strconv.FormatInt(chatID, 10))
		_ = store.Set(ownerKey, strconv.FormatInt(ownerUserID, 10))
		if chatID != 0 {
			_ = store.Set(pairingKey, "")
		}
	}

	if _, err := bot.Verify(ctx); err != nil {
		return err
	}
	fmt.Fprintf(stdout, "Telegram bot running. Pairing code: %s\n", code)
	return bot.Run(ctx)
}

func pairingChat(store *secrets.Store) (int64, int64) {
	chat, _ := strconv.ParseInt(strings.TrimSpace(store.Get(chatKey)), 10, 64)
	owner, _ := strconv.ParseInt(strings.TrimSpace(store.Get(ownerKey)), 10, 64)
	return chat, owner
}

// ensurePairingCode returns the stored code, generating a six-digit one when
// none is active.
func ensurePairingCode(store *secrets.Store) string {
	if code := strings.TrimSpace(store.Get(pairingKey)); code != "" {
		return code
	}
	value, err := rand.Int(rand.Reader, big.NewInt(1000000))
	if err != nil {
		return "000000"
	}
	code := fmt.Sprintf("%06d", value.Int64())
	_ = store.Set(pairingKey, code)
	return code
}
