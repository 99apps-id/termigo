package telegram

import (
	"context"
	"sort"

	"github.com/99apps-id/termigo/cli/internal/provider"
)

// The model picker is two levels of inline buttons: one per provider, then one
// per model. Callback data carries the choice, so a press needs no chat state:
// "mp:<provider id>" lists a provider's models and "mm:<model id>" selects one.
const (
	modelProviderPrefix = "mp:"
	modelSelectPrefix   = "mm:"
)

// maxModelButtons bounds one keyboard, under Telegram's 100-button ceiling.
const maxModelButtons = 90

// providersWithModels lists the providers that have a catalogue, sorted by
// label, which is what the picker offers in order.
func providersWithModels() []provider.Provider {
	var out []provider.Provider
	for _, info := range provider.Providers() {
		if len(provider.ModelsFor(info.ID)) > 0 {
			out = append(out, info)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Label < out[j].Label })
	return out
}

// activeProviders returns the providers that are currently usable: if the agent
// implements ProviderLister, it filters down to providers with valid credentials
// or local access. Otherwise it falls back to all providers with models.
func (b *Bot) activeProviders() []provider.Provider {
	if lister, ok := b.agent.(ProviderLister); ok {
		active := lister.ActiveProviders()
		if len(active) > 0 {
			sort.Slice(active, func(i, j int) bool { return active[i].Label < active[j].Label })
			return active
		}
	}
	return providersWithModels()
}

// buttonsKeyboard pairs labels with callback values, two buttons per row.
func buttonsKeyboard(prefix string, labels, values []string) *InlineKeyboard {
	keyboard := &InlineKeyboard{InlineKeyboard: [][]InlineButton{}}
	row := []InlineButton{}
	for index := range values {
		row = append(row, InlineButton{Text: labels[index], CallbackData: prefix + values[index]})
		if len(row) == 2 {
			keyboard.InlineKeyboard = append(keyboard.InlineKeyboard, row)
			row = []InlineButton{}
		}
	}
	if len(row) > 0 {
		keyboard.InlineKeyboard = append(keyboard.InlineKeyboard, row)
	}
	return keyboard
}

// sendModelMenu opens the picker: the current model, then one button per
// active provider that has a catalogue.
func (b *Bot) sendModelMenu(ctx context.Context, chatID int64) {
	providers := b.activeProviders()
	if len(providers) == 0 {
		b.reply(ctx, chatID, "No active models or providers are available.")
		return
	}
	labels := make([]string, 0, len(providers))
	values := make([]string, 0, len(providers))
	for _, info := range providers {
		labels = append(labels, info.Label)
		values = append(values, info.ID)
	}
	text := "Current model: " + b.agent.Model() + "\nChoose an active provider to select a model:"
	if _, err := b.client.SendMessage(ctx, chatID, text, buttonsKeyboard(modelProviderPrefix, labels, values)); err != nil {
		b.logf("could not send the model menu: %v", err)
	}
}

// showProviderModels replaces the picker with one provider's models.
func (b *Bot) showProviderModels(ctx context.Context, query *CallbackQuery, providerID string) {
	if query.Message == nil {
		return
	}
	models := provider.ModelsFor(providerID)
	if len(models) == 0 {
		_ = b.client.AnswerCallbackQuery(ctx, query.ID, "No models for that provider.")
		return
	}
	if len(models) > maxModelButtons {
		models = models[:maxModelButtons]
	}
	currentModel := b.agent.Model()
	labels := make([]string, 0, len(models))
	values := make([]string, 0, len(models))
	for _, model := range models {
		label := model.Label
		if label == "" {
			label = model.ID
		}
		if model.ID == currentModel || providerID+":"+model.ID == currentModel {
			label = "✓ " + label
		}
		labels = append(labels, label)
		values = append(values, model.ID)
	}
	info, _ := provider.ByID(providerID)
	text := "Choose a model (" + info.Label + "):"
	if err := b.client.EditMessageTextWithKeyboard(ctx, query.Message.Chat.ID, query.Message.MessageID, text, buttonsKeyboard(modelSelectPrefix, labels, values)); err != nil {
		b.logf("could not edit the model menu: %v", err)
	}
	_ = b.client.AnswerCallbackQuery(ctx, query.ID, "")
}

// selectModel switches to the model a button named and confirms in place,
// dropping the keyboard because the choice is made.
func (b *Bot) selectModel(ctx context.Context, query *CallbackQuery, modelID string) {
	label, err := b.agent.SetModel(modelID)
	if err != nil {
		_ = b.client.AnswerCallbackQuery(ctx, query.ID, err.Error())
		return
	}
	if query.Message != nil {
		_ = b.client.EditMessageTextWithKeyboard(ctx, query.Message.Chat.ID, query.Message.MessageID, "Model is now "+label+".", &InlineKeyboard{})
	}
	_ = b.client.AnswerCallbackQuery(ctx, query.ID, "Model: "+label)
}
