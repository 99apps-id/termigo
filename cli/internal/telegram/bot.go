package telegram

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/99apps-id/termigo/cli/internal/provider"
	"github.com/99apps-id/termigo/cli/internal/version"
)

// Agent is the bridge the bot drives. The app implements it over the same
// runner and session the terminal uses.
type Agent interface {
	// RunPrompt runs one turn, calling progress with short status lines.
	RunPrompt(ctx context.Context, prompt string, progress func(string)) (string, error)
	// RunPromptWithImage runs one turn with an image attached for a vision model.
	// mediaType is a MIME type and data is base64.
	RunPromptWithImage(ctx context.Context, prompt, mediaType, data string, progress func(string)) (string, error)
	// Stop cancels the running turn.
	Stop()
	// NewSession starts a fresh conversation.
	NewSession()
	// Model returns the current model id.
	Model() string
	// SetModel switches model by id or search text and returns the new id.
	SetModel(query string) (string, error)
	// Status returns a short multi-line status block.
	Status() string
}

// DiffProvider is an optional interface an Agent can implement to surface git diffs.
type DiffProvider interface {
	GitDiff(ctx context.Context) (string, error)
}

// AudioTranscriber can transcribe voice notes and audio to text.
type AudioTranscriber interface {
	TranscribeAudio(ctx context.Context, data []byte, filename string) (string, error)
}

// WorkspaceProvider gives access to the workspace directory path.
type WorkspaceProvider interface {
	Workspace() string
}

// VoicePromptRunner can run a turn initiated from a voice note, with fallback to a voice model.
type VoicePromptRunner interface {
	RunVoicePrompt(ctx context.Context, prompt string, progress func(string)) (string, error)
}

// ProviderLister can return the providers currently active or usable.
type ProviderLister interface {
	ActiveProviders() []provider.Provider
}

// PendingApproval tracks one in-flight approval request waiting for a callback query.
type PendingApproval struct {
	ID       string
	Tool     string
	Detail   string
	Risk     string
	ChatID   int64
	MsgID    int64
	Decision chan string
}

// Bot long-polls Telegram and forwards operator messages to the agent.
type Bot struct {
	client *Client
	agent  Agent

	// pairMu guards the pairing state. Every update handler runs on its own
	// goroutine while the app mirrors a new pairing onto the running bot, so an
	// unguarded field here is read by one goroutine as another writes it, which
	// is a data race the detector reports. The state is reached only through
	// the methods below, so an unguarded access no longer compiles.
	pairMu      sync.RWMutex
	chatID      int64
	ownerUserID int64
	pairingCode string

	// OnPaired persists the pairing. It runs on the handler goroutine.
	OnPaired func(chatID, ownerUserID int64)
	// Log receives diagnostic lines; nil discards them.
	Log func(string)

	offset int64
	// cursorPath, when set, is where the last confirmed update id is kept so a
	// restart resumes instead of replaying the prompts Telegram still holds.
	cursorPath string

	// offsetMu guards offset, persisted and inflight. offset is the poll
	// cursor, advanced when an update is dispatched. persisted is the
	// contiguous watermark written to disk, advanced only once every earlier
	// update has finished, so a crash replays an in-flight prompt instead of
	// dropping it. inflight is the set of dispatched updates not yet done.
	offsetMu  sync.Mutex
	persisted int64
	inflight  map[int64]bool

	// handlers tracks in-flight update handlers so shutdown waits for them
	// instead of leaving a goroutine writing to a dead client.
	handlers sync.WaitGroup
	// runMu guards the single agent turn this bot may start. Commands that do
	// not run the agent are deliberately outside it, so /stop and /status are
	// answered while a turn is in flight.
	runMu   sync.Mutex
	running bool

	approvalsMu sync.Mutex
	approvals   map[string]*PendingApproval
	nextApprID  int64
}

// New builds a bot for a token and agent.
func New(token string, agent Agent) *Bot {
	return &Bot{client: NewClient(token), agent: agent}
}

// Paired reports whether the bot is bound to a chat.
func (b *Bot) Paired() bool {
	b.pairMu.RLock()
	defer b.pairMu.RUnlock()
	return b.chatID != 0
}

// Pairing reports the paired chat and owner. A chat of 0 means unpaired.
func (b *Bot) Pairing() (chatID, ownerUserID int64) {
	b.pairMu.RLock()
	defer b.pairMu.RUnlock()
	return b.chatID, b.ownerUserID
}

// Pair binds the bot to a chat and its owner.
func (b *Bot) Pair(chatID, ownerUserID int64) {
	b.pairMu.Lock()
	b.chatID = chatID
	b.ownerUserID = ownerUserID
	b.pairMu.Unlock()
}

// Unpair drops the pairing.
func (b *Bot) Unpair() {
	b.Pair(0, 0)
}

// PairingCode returns the code a /pair message must present.
func (b *Bot) PairingCode() string {
	b.pairMu.RLock()
	defer b.pairMu.RUnlock()
	return b.pairingCode
}

// SetPairingCode records the active pairing code.
func (b *Bot) SetPairingCode(code string) {
	b.pairMu.Lock()
	b.pairingCode = code
	b.pairMu.Unlock()
}

// tryStartRun reserves the single agent turn, reporting false when one is
// already in flight from this bot.
func (b *Bot) tryStartRun() bool {
	b.runMu.Lock()
	defer b.runMu.Unlock()
	if b.running {
		return false
	}
	b.running = true
	return true
}

func (b *Bot) endRun() {
	b.runMu.Lock()
	b.running = false
	b.runMu.Unlock()
}

func (b *Bot) logf(format string, args ...any) {
	if b.Log != nil {
		b.Log(fmt.Sprintf(format, args...))
	}
}

// SetCursorPath records where the confirmed update id is persisted. The file is
// scoped to one bot by the caller, so two bots never share a cursor.
func (b *Bot) SetCursorPath(path string) { b.cursorPath = path }

// loadOffset reads the last confirmed update id. A missing or unreadable file
// yields zero, which is the current behaviour, so a broken cursor never wedges
// the loop on a stale offset.
func (b *Bot) loadOffset() int64 {
	if b.cursorPath == "" {
		return 0
	}
	data, err := os.ReadFile(b.cursorPath)
	if err != nil {
		return 0
	}
	value, err := strconv.ParseInt(strings.TrimSpace(string(data)), 10, 64)
	if err != nil || value < 0 {
		return 0
	}
	return value
}

// saveOffset persists the confirmed update id through a temporary file, so an
// interrupted write leaves the old value rather than a half-written one.
func (b *Bot) saveOffset(offset int64) {
	if b.cursorPath == "" {
		return
	}
	tmp := b.cursorPath + ".tmp"
	if err := os.WriteFile(tmp, []byte(strconv.FormatInt(offset, 10)), 0o600); err != nil {
		return
	}
	_ = os.Rename(tmp, b.cursorPath)
}

// Verify checks the token and returns the bot identity.
func (b *Bot) Verify(ctx context.Context) (User, error) {
	return b.client.GetMe(ctx)
}

// Run polls until the context is cancelled.
func (b *Bot) Run(ctx context.Context) error {
	// Handlers may outlive a poll iteration; wait for them on the way out so
	// a stopping bot does not keep working in the background.
	defer b.handlers.Wait()

	// Resume from the last confirmed update so a restart does not replay the
	// prompts Telegram still holds.
	b.offsetMu.Lock()
	if b.offset == 0 {
		b.offset = b.loadOffset()
	}
	b.persisted = b.offset
	if b.inflight == nil {
		b.inflight = map[int64]bool{}
	}
	b.offsetMu.Unlock()

	commands := []BotCommand{
		{Command: "run", Description: "Run a prompt with live progress"},
		{Command: "diff", Description: "Show current git diff or file changes"},
		{Command: "stop", Description: "Stop the running turn"},
		{Command: "new", Description: "Start a new session"},
		{Command: "status", Description: "Show status"},
		{Command: "model", Description: "Choose or switch the model"},
		{Command: "unpair", Description: "Detach this chat"},
		{Command: "help", Description: "List commands"},
	}
	if err := b.client.SetMyCommands(ctx, commands); err != nil {
		b.logf("could not publish the command menu: %v", err)
	}

	backoff := 3 * time.Second
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		b.offsetMu.Lock()
		offset := b.offset
		b.offsetMu.Unlock()
		updates, err := b.client.GetUpdates(ctx, offset, 30)
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			backoff = b.handlePollError(ctx, err, backoff)
			continue
		}
		backoff = 3 * time.Second
		for _, update := range updates {
			// Telegram returns updates from the current offset onwards, so an
			// id below it has already been handled. It must be skipped rather
			// than dispatched: running it again would repeat the command.
			// The offset is "the first update to return", not "the last one
			// seen", which is why the comparison is below rather than at.
			b.offsetMu.Lock()
			if update.UpdateID < b.offset {
				b.offsetMu.Unlock()
				continue
			}
			// Mark it in flight before the cursor moves past it, so the
			// persisted watermark can never step over an unfinished update.
			b.inflight[update.UpdateID] = true
			b.offset = update.UpdateID + 1
			b.offsetMu.Unlock()
			b.dispatch(ctx, update)
		}
	}
}

// dispatch runs one update handler on its own goroutine.
//
// This is what keeps the bot responsive: a prompt runs for minutes, and while
// it held the poll loop the operator could not send /stop, /status or a
// correction, which is precisely when those are needed.
func (b *Bot) dispatch(ctx context.Context, update Update) {
	b.handlers.Add(1)
	go func() {
		defer b.handlers.Done()
		defer b.finishUpdate(update.UpdateID)
		b.handleUpdate(ctx, update)
	}()
}

// finishUpdate marks an update done and persists the contiguous watermark: the
// highest offset below which every update has finished. Persisting only here,
// and not when the update is dispatched, means a crash during handling replays
// the prompt on the next start instead of losing it.
func (b *Bot) finishUpdate(updateID int64) {
	b.offsetMu.Lock()
	delete(b.inflight, updateID)
	for b.persisted < b.offset {
		if b.inflight[b.persisted] {
			break
		}
		b.persisted++
	}
	persisted := b.persisted
	b.offsetMu.Unlock()
	b.saveOffset(persisted)
}

// handlePollError backs off after a failed poll, honouring Telegram's own
// retry hint and treating a 409 (another poller holds the token) as fatal for
// this loop's cadence.
func (b *Bot) handlePollError(ctx context.Context, err error, backoff time.Duration) time.Duration {
	wait := backoff
	if retry := RetryAfterSeconds(err); retry > 0 {
		wait = time.Duration(retry) * time.Second
	}
	b.logf("poll failed: %v (retrying in %s)", err, wait)
	select {
	case <-ctx.Done():
	case <-time.After(wait):
	}
	next := backoff * 2
	if next > 60*time.Second {
		next = 60 * time.Second
	}
	return next
}

// handleUpdate dispatches one update. A failure is reported to the chat and
// never stops the loop.
func (b *Bot) handleUpdate(ctx context.Context, update Update) {
	defer func() {
		if recovered := recover(); recovered != nil {
			b.logf("recovered from panic while handling an update: %v", recovered)
		}
	}()
	switch {
	case update.CallbackQuery != nil:
		b.handleCallback(ctx, update.CallbackQuery)
	case update.Message != nil:
		b.handleMessage(ctx, update.Message)
	}
}

func (b *Bot) handleCallback(ctx context.Context, query *CallbackQuery) {
	chat := Chat{}
	if query.Message != nil {
		chat = query.Message.Chat
	}
	if !b.isOwner(chat, query.From) {
		_ = b.client.AnswerCallbackQuery(ctx, query.ID, "Not allowed.")
		return
	}
	switch {
	case strings.HasPrefix(query.Data, "appr:"):
		b.handleApprovalCallback(ctx, query)
	case strings.HasPrefix(query.Data, modelProviderPrefix):
		b.showProviderModels(ctx, query, strings.TrimPrefix(query.Data, modelProviderPrefix))
	case strings.HasPrefix(query.Data, modelSelectPrefix):
		b.selectModel(ctx, query, strings.TrimPrefix(query.Data, modelSelectPrefix))
	default:
		_ = b.client.AnswerCallbackQuery(ctx, query.ID, "")
	}
}

// RequestApproval posts an interactive inline confirmation dialog and blocks
// until the operator selects Allow Once, Allow Always, or Deny (or timeout).
func (b *Bot) RequestApproval(ctx context.Context, tool, detail, risk string) (string, error) {
	chatID, _ := b.Pairing()
	if chatID == 0 {
		return "deny", errors.New("bot is not paired")
	}

	b.approvalsMu.Lock()
	if b.approvals == nil {
		b.approvals = make(map[string]*PendingApproval)
	}
	b.nextApprID++
	id := strconv.FormatInt(b.nextApprID, 10)
	ch := make(chan string, 1)
	approval := &PendingApproval{
		ID:       id,
		Tool:     tool,
		Detail:   detail,
		Risk:     risk,
		ChatID:   chatID,
		Decision: ch,
	}
	b.approvals[id] = approval
	b.approvalsMu.Unlock()

	defer func() {
		b.approvalsMu.Lock()
		delete(b.approvals, id)
		b.approvalsMu.Unlock()
	}()

	keyboard := &InlineKeyboard{
		InlineKeyboard: [][]InlineButton{
			{
				{Text: "Allow Once", CallbackData: "appr:once:" + id},
				{Text: "Always", CallbackData: "appr:always:" + id},
				{Text: "Deny", CallbackData: "appr:deny:" + id},
			},
		},
	}
	header := fmt.Sprintf("Approval required for %s", tool)
	if risk != "" {
		header = fmt.Sprintf("Approval required (%s) for %s", risk, tool)
	}
	text := header
	if strings.TrimSpace(detail) != "" {
		text += "\n\n" + detail
	}
	msg, err := b.client.SendMessage(ctx, chatID, text, keyboard)
	if err != nil {
		return "deny", err
	}
	approval.MsgID = msg.MessageID

	select {
	case decision := <-ch:
		return decision, nil
	case <-time.After(3 * time.Minute):
		_ = b.client.EditMessageText(ctx, chatID, msg.MessageID, fmt.Sprintf("Approval for %s timed out (denied).", tool))
		return "deny", nil
	case <-ctx.Done():
		return "deny", ctx.Err()
	}
}

func (b *Bot) handleApprovalCallback(ctx context.Context, query *CallbackQuery) {
	parts := strings.Split(query.Data, ":")
	if len(parts) != 3 {
		_ = b.client.AnswerCallbackQuery(ctx, query.ID, "Invalid action.")
		return
	}
	action := parts[1] // once, always, deny
	id := parts[2]

	b.approvalsMu.Lock()
	appr, ok := b.approvals[id]
	b.approvalsMu.Unlock()

	if !ok {
		_ = b.client.AnswerCallbackQuery(ctx, query.ID, "Approval request expired or already answered.")
		return
	}

	_ = b.client.AnswerCallbackQuery(ctx, query.ID, "Recorded: "+action)
	statusText := fmt.Sprintf("Decision: %s for %s", action, appr.Tool)
	if query.Message != nil {
		_ = b.client.EditMessageTextWithKeyboard(ctx, query.Message.Chat.ID, query.Message.MessageID, statusText, &InlineKeyboard{InlineKeyboard: [][]InlineButton{}})
	}

	select {
	case appr.Decision <- action:
	default:
	}
}

func (b *Bot) handleMessage(ctx context.Context, message *Message) {
	chatID := message.Chat.ID
	text := strings.TrimSpace(message.Text)
	// A command is only a command when a slash introduces it. splitCommand
	// happily reads the first word of any message, so without this guard a
	// plain sentence beginning with "run", "new" or "stop" was routed as that
	// command and either lost its first word or reset the session.
	isCommand := strings.HasPrefix(text, "/")

	if !b.Paired() {
		// Unpaired: only /pair is accepted, which is what stops a stranger
		// who finds the bot from running the agent.
		if isCommand {
			if command, argument := splitCommand(text); command == "pair" {
				b.tryPair(ctx, message, argument)
				return
			}
		}
		b.reply(ctx, chatID, "This bot is not paired yet. Send /pair <code> with the code shown in Termixgo.")
		return
	}

	if !b.isOwner(message.Chat, message.From) {
		return
	}

	// A photo is a vision prompt: the caption is the instruction, or a default
	// asks the model to describe it. It runs before the command switch because
	// an image message carries no text.
	if len(message.Photo) > 0 {
		b.runPhoto(ctx, chatID, message)
		return
	}

	// Voice notes and audio tracks are transcribed and run as prompts.
	if message.Voice != nil {
		b.runVoice(ctx, chatID, message.Voice.FileID, "voice.ogg", message.Caption)
		return
	}
	if message.Audio != nil {
		name := message.Audio.FileName
		if name == "" {
			name = "audio.mp3"
		}
		b.runVoice(ctx, chatID, message.Audio.FileID, name, message.Caption)
		return
	}

	// Documents (files, patches, logs, images sent as documents) are saved or inspected.
	if message.Document != nil {
		b.runDocument(ctx, chatID, message)
		return
	}

	// No text means there is nothing to ask.
	if text == "" {
		return
	}

	if !isCommand {
		// Plain text is a prompt, which is the natural way to use the bot.
		b.runPrompt(ctx, chatID, text)
		return
	}

	command, argument := splitCommand(text)
	switch command {
	case "help", "start":
		b.reply(ctx, chatID, helpText())
	case "status":
		b.reply(ctx, chatID, b.agent.Status())
	case "pair":
		b.reply(ctx, chatID, "Already paired. Use /unpair first to move to another chat.")
	case "unpair":
		b.Unpair()
		if b.OnPaired != nil {
			b.OnPaired(0, 0)
		}
		b.reply(ctx, chatID, "Unpaired.")
	case "new":
		b.agent.NewSession()
		b.reply(ctx, chatID, "Started a new session.")
	case "stop":
		b.agent.Stop()
		b.reply(ctx, chatID, "Stopping the running turn.")
	case "model":
		if strings.TrimSpace(argument) == "" {
			// Open the picker rather than only reporting the active model: the
			// operator asked to choose one.
			b.sendModelMenu(ctx, chatID)
			return
		}
		updated, err := b.agent.SetModel(argument)
		if err != nil {
			b.reply(ctx, chatID, err.Error())
			return
		}
		b.reply(ctx, chatID, "Model is now "+updated+".")
	case "diff":
		diffProv, ok := b.agent.(DiffProvider)
		if !ok {
			b.reply(ctx, chatID, "Diff is not supported by this agent.")
			return
		}
		diff, err := diffProv.GitDiff(ctx)
		if err != nil {
			b.reply(ctx, chatID, "git diff error: "+err.Error())
			return
		}
		trimmed := strings.TrimSpace(diff)
		if trimmed == "" {
			b.reply(ctx, chatID, "No git changes in the workspace.")
			return
		}
		if len(trimmed) > 3000 {
			_, sendErr := b.client.SendDocument(ctx, chatID, "changes.diff", []byte(trimmed), "Current git diff")
			if sendErr != nil {
				b.reply(ctx, chatID, "Could not send diff file: "+sendErr.Error())
			}
			return
		}
		b.reply(ctx, chatID, "```diff\n"+trimmed+"\n```")
	case "run", "query":
		prompt := strings.TrimSpace(argument)
		if prompt == "" {
			b.reply(ctx, chatID, "Usage: /run <prompt>")
			return
		}
		b.runPrompt(ctx, chatID, prompt)
	default:
		b.reply(ctx, chatID, "Unknown command. Send /help.")
	}
}

// runPrompt runs one text turn and mirrors progress into a single edited card.
func (b *Bot) runPrompt(ctx context.Context, chatID int64, prompt string) {
	b.runWithCard(ctx, chatID, func(runCtx context.Context, progress func(string)) (string, error) {
		return b.agent.RunPrompt(runCtx, prompt, progress)
	})
}

// runPhoto downloads a photo the operator sent and runs the agent with it
// attached, so a vision model can see it. The message caption is the prompt.
func (b *Bot) runPhoto(ctx context.Context, chatID int64, message *Message) {
	prompt := strings.TrimSpace(message.Caption)
	if prompt == "" {
		prompt = "Describe this image and act on anything notable in it."
	}
	// Telegram sends several sizes; the last is the largest.
	photo := message.Photo[len(message.Photo)-1]
	file, err := b.client.GetFile(ctx, photo.FileID)
	if err != nil {
		b.reply(ctx, chatID, "Could not fetch the image: "+err.Error())
		return
	}
	data, err := b.client.DownloadFile(ctx, file.FilePath)
	if err != nil {
		b.reply(ctx, chatID, "Could not download the image: "+err.Error())
		return
	}
	encoded := base64.StdEncoding.EncodeToString(data)
	mediaType := imageMediaType(file.FilePath)
	b.runWithCard(ctx, chatID, func(runCtx context.Context, progress func(string)) (string, error) {
		return b.agent.RunPromptWithImage(runCtx, prompt, mediaType, encoded, progress)
	})
}

func isImageExtension(name string) bool {
	ext := strings.ToLower(filepath.Ext(name))
	switch ext {
	case ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp":
		return true
	}
	return false
}

// runDocument downloads a document file. If it is an image, it is passed to
// vision; otherwise text files are displayed inline and all files are saved
// to the workspace uploads directory when available.
func (b *Bot) runDocument(ctx context.Context, chatID int64, message *Message) {
	doc := message.Document
	if doc == nil {
		return
	}
	prompt := strings.TrimSpace(message.Caption)

	file, err := b.client.GetFile(ctx, doc.FileID)
	if err != nil {
		b.reply(ctx, chatID, "Could not fetch document: "+err.Error())
		return
	}
	data, err := b.client.DownloadFile(ctx, file.FilePath)
	if err != nil {
		b.reply(ctx, chatID, "Could not download document: "+err.Error())
		return
	}

	if strings.HasPrefix(strings.ToLower(doc.MimeType), "image/") || isImageExtension(doc.FileName) {
		if prompt == "" {
			prompt = "Describe this image and act on anything notable in it."
		}
		encoded := base64.StdEncoding.EncodeToString(data)
		mediaType := doc.MimeType
		if mediaType == "" {
			mediaType = imageMediaType(doc.FileName)
		}
		b.runWithCard(ctx, chatID, func(runCtx context.Context, progress func(string)) (string, error) {
			return b.agent.RunPromptWithImage(runCtx, prompt, mediaType, encoded, progress)
		})
		return
	}

	fileName := filepath.Base(doc.FileName)
	if fileName == "." || fileName == "/" || fileName == "" {
		fileName = "uploaded_document"
	}

	uploadRelPath := filepath.Join(".termixgo", "uploads", fileName)
	savedToWorkspace := false
	if wp, ok := b.agent.(WorkspaceProvider); ok && wp.Workspace() != "" {
		uploadDir := filepath.Join(wp.Workspace(), ".termixgo", "uploads")
		if err := os.MkdirAll(uploadDir, 0o755); err == nil {
			fullPath := filepath.Join(uploadDir, fileName)
			if err := os.WriteFile(fullPath, data, 0o644); err == nil {
				savedToWorkspace = true
			}
		}
	}

	var builder strings.Builder
	if savedToWorkspace {
		fmt.Fprintf(&builder, "[Document uploaded: %s saved to %s]\n\n", fileName, filepath.ToSlash(uploadRelPath))
	} else {
		fmt.Fprintf(&builder, "[Document uploaded: %s (%d bytes)]\n\n", fileName, len(data))
	}

	if utf8.Valid(data) && len(data) <= 64*1024 {
		builder.WriteString("File content:\n```\n")
		builder.WriteString(string(data))
		builder.WriteString("\n```\n\n")
	}

	if prompt != "" {
		builder.WriteString(prompt)
	} else {
		builder.WriteString("Please inspect the uploaded document and proceed.")
	}

	b.runPrompt(ctx, chatID, builder.String())
}

// runVoice downloads an incoming voice note or audio file, transcribes it to
// text, and runs the agent with the transcribed prompt.
func (b *Bot) runVoice(ctx context.Context, chatID int64, fileID, filename, caption string) {
	transcriber, ok := b.agent.(AudioTranscriber)
	if !ok {
		b.reply(ctx, chatID, "Voice transcription is not supported by this agent.")
		return
	}

	file, err := b.client.GetFile(ctx, fileID)
	if err != nil {
		b.reply(ctx, chatID, "Could not fetch voice message: "+err.Error())
		return
	}
	data, err := b.client.DownloadFile(ctx, file.FilePath)
	if err != nil {
		b.reply(ctx, chatID, "Could not download voice message: "+err.Error())
		return
	}

	text, err := transcriber.TranscribeAudio(ctx, data, filename)
	if err != nil {
		b.reply(ctx, chatID, "Transcription failed: "+err.Error())
		return
	}
	text = strings.TrimSpace(text)
	if text == "" {
		b.reply(ctx, chatID, "No speech detected in audio.")
		return
	}

	b.reply(ctx, chatID, "Transcribed: <i>\""+escapeHTML(text)+"\"</i>")

	prompt := text
	if caption = strings.TrimSpace(caption); caption != "" {
		prompt = caption + "\n\n" + text
	}

	if runner, ok := b.agent.(VoicePromptRunner); ok {
		b.runWithCard(ctx, chatID, func(runCtx context.Context, progress func(string)) (string, error) {
			return runner.RunVoicePrompt(runCtx, prompt, progress)
		})
		return
	}

	b.runPrompt(ctx, chatID, prompt)
}

// typingRefresh is how often the typing action is renewed while a turn runs.
// Telegram clears the indicator after about five seconds, so four keeps it
// continuous without sending a request the API would ignore anyway. It is a
// variable so a test can exercise the keepalive without waiting out the real
// interval.
var typingRefresh = 4 * time.Second

// keepTyping renews the chat's typing indicator until done is closed or the
// bot's context ends. It runs off the run's own goroutine so a slow network
// call cannot delay the turn.
func (b *Bot) keepTyping(ctx context.Context, chatID int64, done <-chan struct{}) {
	ticker := time.NewTicker(typingRefresh)
	defer ticker.Stop()
	for {
		select {
		case <-done:
			return
		case <-ctx.Done():
			return
		case <-ticker.C:
			_ = b.client.SendChatAction(ctx, chatID, "typing")
		}
	}
}

// runWithCard runs one turn behind the single-run gate and mirrors progress
// into one message that is edited in place instead of flooding the chat.
func (b *Bot) runWithCard(ctx context.Context, chatID int64, run func(context.Context, func(string)) (string, error)) {
	if !b.tryStartRun() {
		b.reply(ctx, chatID, "A run is already in progress. Send /stop to stop it, then retry.")
		return
	}
	defer b.endRun()

	statusMessage, err := b.client.SendMessage(ctx, chatID, "Working...", nil)
	if err != nil {
		b.logf("could not send the progress message: %v", err)
	}
	_ = b.client.SendChatAction(ctx, chatID, "typing")
	// Telegram clears a typing action after a few seconds, so a long turn
	// showed no sign of life for most of its run and read as stuck. The
	// keepalive renews the indicator until the turn returns, which is what
	// tells the operator the agent is still working.
	typingDone := make(chan struct{})
	go b.keepTyping(ctx, chatID, typingDone)
	defer close(typingDone)

	// The card grows with the turn instead of being replaced by the newest line.
	// Replacing lost every earlier step: the operator saw one tool at a time and
	// the task itself scrolled away. An edit the throttle skips is not lost
	// either, because the next edit carries the whole list.
	var lines []string
	var lastEdit time.Time
	flush := func(force bool) {
		if statusMessage.MessageID == 0 {
			return
		}
		// Throttle edits: Telegram rate-limits rapid edits to one message.
		if !force && time.Since(lastEdit) < 2*time.Second {
			return
		}
		lastEdit = time.Now()
		_ = b.client.EditMarkdown(ctx, chatID, statusMessage.MessageID, strings.Join(lines, "\n"), nil)
	}
	progress := func(line string) {
		line = strings.TrimSpace(line)
		if line == "" {
			return
		}
		if len(lines) > 0 && lines[len(lines)-1] == line {
			return
		}
		lines = append(lines, line)
		lines = capCardLines(lines, telegramChunkLimit)
		flush(false)
	}

	answer, runErr := run(ctx, progress)

	if statusMessage.MessageID == 0 {
		// No card to edit: deliver the failure or the answer directly.
		if runErr != nil {
			b.replyMarkdown(ctx, chatID, "Run failed: "+runErr.Error())
			return
		}
		if strings.TrimSpace(answer) == "" {
			answer = "(no output)"
		}
		b.replyMarkdown(ctx, chatID, answer)
		return
	}

	if runErr != nil {
		progress("Run failed: " + runErr.Error())
		flush(true)
		return
	}
	if strings.TrimSpace(answer) == "" {
		answer = "(no output)"
	}

	// The card carried the tool activity while the turn ran. Once the turn is
	// done that activity has served its purpose, so the card is replaced by the
	// answer alone: the chat is left with the conversation (the prompt, the
	// agent's reply) instead of the backend steps behind it. When the answer is
	// too long for one message the card carries its first part and the rest
	// follow as new messages, because an edit past the limit is truncated.
	// Chunks are measured on the converted body, so the part that lands in
	// the card and every follow-up fit Telegram's cap before they are sent:
	// a long answer arrives whole, not clamped with a "[truncated]" tail.
	parts := markdownChunks(answer, messageLimit)
	if err := b.client.EditMarkdown(ctx, chatID, statusMessage.MessageID, parts[0], nil); err != nil {
		// The card could not be rewritten, so deliver the whole answer as its
		// own message rather than lose it.
		b.replyMarkdown(ctx, chatID, answer)
		return
	}
	for _, part := range parts[1:] {
		b.replyMarkdown(ctx, chatID, part)
	}
}

// telegramChunkLimit is the body size the bot targets, under Telegram's 4096
// byte cap so a converted Markdown body never trips it.
const telegramChunkLimit = 3800

// replyMarkdown sends Markdown text, split into messages whose CONVERTED
// bodies fit Telegram's cap, so a long answer arrives whole instead of being
// truncated at the limit. Splitting on the conversion is what keeps an
// entity-dense answer (code fences full of angle brackets) off the lossy
// clampText path.
func (b *Bot) replyMarkdown(ctx context.Context, chatID int64, text string) {
	for _, part := range markdownChunks(text, messageLimit) {
		if _, err := b.client.SendMarkdown(ctx, chatID, part, nil); err != nil {
			b.logf("send failed: %v", err)
		}
	}
}

// nextChunk splits text into a part under limit bytes and the remainder. The
// cut lands on a rune boundary, which Telegram requires, and prefers a line
// boundary near the limit so a sentence is not split mid-line when a newline is
// close. The newline itself stays with the next part: the renderer trims a
// trailing newline, so keeping it here would drop it.
func nextChunk(text string, limit int) (string, string) {
	if len(text) <= limit {
		return text, ""
	}
	cut := limit
	for cut > 0 && !utf8.RuneStart(text[cut]) {
		cut--
	}
	if index := strings.LastIndexByte(text[:cut], '\n'); index > 0 && index > cut/2 {
		cut = index
	}
	return text[:cut], text[cut:]
}

// capCardLines keeps the newest lines within limit bytes, dropping the oldest so
// the growing card never exceeds the Telegram message limit.
func capCardLines(lines []string, limit int) []string {
	total := 0
	for _, line := range lines {
		total += len(line) + 1
	}
	if len(lines) > 0 {
		total--
	}
	kept := lines
	for len(kept) > 1 && total > limit {
		total -= len(kept[0]) + 1
		kept = kept[1:]
	}
	return kept
}

// imageMediaType maps a Telegram file path to a media type; photos it sends are
// jpeg, but an uploaded png or webp keeps its own suffix.
func imageMediaType(path string) string {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".png":
		return "image/png"
	case ".webp":
		return "image/webp"
	case ".gif":
		return "image/gif"
	default:
		return "image/jpeg"
	}
}

func (b *Bot) tryPair(ctx context.Context, message *Message, code string) {
	expected := b.PairingCode()
	if strings.TrimSpace(expected) == "" {
		b.reply(ctx, message.Chat.ID, "No pairing code is active. Run /setup in Termixgo.")
		return
	}
	if strings.TrimSpace(code) != strings.TrimSpace(expected) {
		b.reply(ctx, message.Chat.ID, "Wrong pairing code.")
		return
	}
	ownerUserID := int64(0)
	if message.From != nil {
		ownerUserID = message.From.ID
	}
	b.Pair(message.Chat.ID, ownerUserID)
	if b.OnPaired != nil {
		b.OnPaired(message.Chat.ID, ownerUserID)
	}
	b.reply(ctx, message.Chat.ID, fmt.Sprintf("Paired. Send any message to run the agent.\n%s", helpText()))
}

// isOwner gates a message. A group chat with no pinned owner fails closed.
func (b *Bot) isOwner(chat Chat, from *User) bool {
	pairedChat, owner := b.Pairing()
	if pairedChat == 0 {
		return false
	}
	if chat.ID != pairedChat {
		return false
	}
	if owner == 0 {
		return chat.IsPrivate()
	}
	return from != nil && from.ID == owner
}

func (b *Bot) reply(ctx context.Context, chatID int64, text string) {
	if _, err := b.client.SendMessage(ctx, chatID, text, nil); err != nil {
		b.logf("send failed: %v", err)
	}
}

// Send posts a message to the paired chat, whether or not the bot is polling.
// It is how a scheduled job reaches the operator outside a turn.
func (b *Bot) Send(ctx context.Context, text string) error {
	chatID, _ := b.Pairing()
	if chatID == 0 {
		return errors.New("the bot is not paired")
	}
	_, err := b.client.SendMarkdown(ctx, chatID, text, nil)
	return err
}

// splitCommand parses "/name argument" or "name argument", tolerating the
// "@botname" suffix Telegram adds to group commands.
func splitCommand(text string) (string, string) {
	trimmed := strings.TrimPrefix(strings.TrimSpace(text), "/")
	command := trimmed
	rest := ""
	if index := strings.IndexAny(trimmed, " \n\t"); index >= 0 {
		command = trimmed[:index]
		rest = strings.TrimSpace(trimmed[index+1:])
	}
	if index := strings.Index(command, "@"); index > 0 {
		command = command[:index]
	}
	return strings.ToLower(command), rest
}

func helpText() string {
	return strings.Join([]string{
		version.Name + " companion bot",
		"",
		"Send any text to run it as a prompt.",
		"Send a photo (with a caption) to ask about an image.",
		"/run <prompt>  run with a live progress card",
		"/diff          show current git diff",
		"/stop          stop the running turn",
		"/new           start a new session",
		"/model [id]    choose a model, or switch by id",
		"/status        show status",
		"/unpair        detach this chat",
		"/help          this list",
	}, "\n")
}
