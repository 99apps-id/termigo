// Package telegram implements the companion bot: a long-polling Telegram
// client that forwards operator messages to the same agent and reports
// progress back into the chat.
package telegram

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// apiBase is the Telegram Bot API root.
const apiBase = "https://api.telegram.org"

// messageLimit is Telegram's hard cap on a message body.
const messageLimit = 4096

// Client calls the Bot API for one token.
type Client struct {
	token   string
	baseURL string
	http    *http.Client
}

// NewClient builds a client for a bot token.
func NewClient(token string) *Client {
	return newClientAt(token, apiBase)
}

// newClientAt builds a client against a specific API root, which lets tests
// drive the bot without reaching Telegram.
func newClientAt(token, baseURL string) *Client {
	return &Client{
		token:   strings.TrimSpace(token),
		baseURL: strings.TrimRight(baseURL, "/"),
		http: &http.Client{
			Timeout: 0,
			Transport: &http.Transport{
				MaxIdleConns:        4,
				IdleConnTimeout:     90 * time.Second,
				TLSHandshakeTimeout: 15 * time.Second,
			},
		},
	}
}

// User is the bot identity.
type User struct {
	ID       int64  `json:"id"`
	Username string `json:"username"`
}

// Chat identifies a conversation.
type Chat struct {
	ID   int64  `json:"id"`
	Type string `json:"type"`
}

// PhotoSize is one resolution of a sent photo. Telegram sends several; the
// last is the largest.
type PhotoSize struct {
	FileID   string `json:"file_id"`
	Width    int    `json:"width"`
	Height   int    `json:"height"`
	FileSize int    `json:"file_size"`
}

// Document represents an incoming document file.
type Document struct {
	FileID   string `json:"file_id"`
	FileName string `json:"file_name"`
	MimeType string `json:"mime_type"`
	FileSize int    `json:"file_size"`
}

// Voice represents an incoming voice note.
type Voice struct {
	FileID   string `json:"file_id"`
	Duration int    `json:"duration"`
	MimeType string `json:"mime_type"`
	FileSize int    `json:"file_size"`
}

// Audio represents an incoming audio track.
type Audio struct {
	FileID   string `json:"file_id"`
	Duration int    `json:"duration"`
	FileName string `json:"file_name"`
	MimeType string `json:"mime_type"`
	FileSize int    `json:"file_size"`
}

// Message is an incoming or outgoing message.
type Message struct {
	MessageID int64       `json:"message_id"`
	From      *User       `json:"from"`
	Chat      Chat        `json:"chat"`
	Text      string      `json:"text"`
	Caption   string      `json:"caption"`
	Photo     []PhotoSize `json:"photo"`
	Document  *Document   `json:"document"`
	Voice     *Voice      `json:"voice"`
	Audio     *Audio      `json:"audio"`
}

// File is a downloadable Telegram file.
type File struct {
	FileID   string `json:"file_id"`
	FilePath string `json:"file_path"`
	FileSize int    `json:"file_size"`
}

// CallbackQuery is an inline-button press.
type CallbackQuery struct {
	ID      string   `json:"id"`
	From    *User    `json:"from"`
	Message *Message `json:"message"`
	Data    string   `json:"data"`
}

// Update is one polled update.
type Update struct {
	UpdateID      int64          `json:"update_id"`
	Message       *Message       `json:"message"`
	CallbackQuery *CallbackQuery `json:"callback_query"`
}

// InlineButton is one keyboard button.
type InlineButton struct {
	Text         string `json:"text"`
	CallbackData string `json:"callback_data,omitempty"`
}

// InlineKeyboard is a keyboard of buttons.
type InlineKeyboard struct {
	InlineKeyboard [][]InlineButton `json:"inline_keyboard"`
}

// BotCommand is one entry in the bot's command menu.
type BotCommand struct {
	Command     string `json:"command"`
	Description string `json:"description"`
}

type apiResponse struct {
	OK          bool            `json:"ok"`
	Result      json.RawMessage `json:"result"`
	Description string          `json:"description"`
	ErrorCode   int             `json:"error_code"`
	Parameters  *struct {
		RetryAfter int `json:"retry_after"`
	} `json:"parameters"`
}

// APIError is a non-ok Bot API reply.
type APIError struct {
	Code        int
	Description string
	RetryAfter  int
}

func (e *APIError) Error() string {
	if e.Description != "" {
		return fmt.Sprintf("telegram: %s (%d)", e.Description, e.Code)
	}
	return fmt.Sprintf("telegram returned %d", e.Code)
}

// call performs one Bot API method.
func (c *Client) call(ctx context.Context, method string, payload any, result any) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	url := fmt.Sprintf("%s/bot%s/%s", c.baseURL, c.token, method)
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := c.http.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 4*1024*1024))
	if err != nil {
		return err
	}
	var decoded apiResponse
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return fmt.Errorf("telegram: unreadable reply (%s)", response.Status)
	}
	if !decoded.OK {
		apiErr := &APIError{Code: decoded.ErrorCode, Description: decoded.Description}
		if decoded.Parameters != nil {
			apiErr.RetryAfter = decoded.Parameters.RetryAfter
		}
		return apiErr
	}
	if result != nil && len(decoded.Result) > 0 {
		return json.Unmarshal(decoded.Result, result)
	}
	return nil
}

// GetMe validates the token and returns the bot identity.
func (c *Client) GetMe(ctx context.Context) (User, error) {
	var user User
	err := c.call(ctx, "getMe", map[string]any{}, &user)
	return user, err
}

// GetUpdates long-polls for updates. A timeout of 0 returns immediately.
//
// The poll runs under its own deadline so a network stall cannot hang the
// caller's context, which is what keeps the loop recoverable.
func (c *Client) GetUpdates(ctx context.Context, offset int64, timeoutSeconds int) ([]Update, error) {
	payload := map[string]any{"timeout": timeoutSeconds, "allowed_updates": []string{"message", "callback_query"}}
	if offset > 0 {
		payload["offset"] = offset
	}
	pollCtx, cancel := context.WithTimeout(ctx, time.Duration(timeoutSeconds+15)*time.Second)
	defer cancel()
	var updates []Update
	err := c.call(pollCtx, "getUpdates", payload, &updates)
	return updates, err
}

// SendMessage posts a plain message, optionally with an inline keyboard.
func (c *Client) SendMessage(ctx context.Context, chatID int64, text string, keyboard *InlineKeyboard) (Message, error) {
	return c.sendMessage(ctx, chatID, text, keyboard, "")
}

// SendMarkdown posts a message rendered from Markdown.
//
// The Markdown is converted to Telegram's HTML subset, which escapes every
// character that is not turned into a tag. If the API still rejects the entities
// the message is resent as plain text, so a formatting bug can never swallow an
// answer.
func (c *Client) SendMarkdown(ctx context.Context, chatID int64, markdown string, keyboard *InlineKeyboard) (Message, error) {
	message, err := c.sendMessage(ctx, chatID, markdownToTelegramHTML(markdown), keyboard, "HTML")
	if err != nil && isParseError(err) {
		return c.sendMessage(ctx, chatID, markdown, keyboard, "")
	}
	return message, err
}

func (c *Client) sendMessage(ctx context.Context, chatID int64, text string, keyboard *InlineKeyboard, parseMode string) (Message, error) {
	payload := map[string]any{
		"chat_id":                  chatID,
		"text":                     clampText(text),
		"disable_web_page_preview": true,
	}
	if parseMode != "" {
		payload["parse_mode"] = parseMode
	}
	if keyboard != nil && len(keyboard.InlineKeyboard) > 0 {
		payload["reply_markup"] = keyboard
	}
	var message Message
	err := c.call(ctx, "sendMessage", payload, &message)
	return message, err
}

// SendDocument uploads and posts a file as a document via multipart/form-data.
func (c *Client) SendDocument(ctx context.Context, chatID int64, filename string, data []byte, caption string) (Message, error) {
	var buf bytes.Buffer
	writer := multipart.NewWriter(&buf)
	if err := writer.WriteField("chat_id", strconv.FormatInt(chatID, 10)); err != nil {
		return Message{}, err
	}
	if caption != "" {
		if err := writer.WriteField("caption", clampText(caption)); err != nil {
			return Message{}, err
		}
	}
	part, err := writer.CreateFormFile("document", filename)
	if err != nil {
		return Message{}, err
	}
	if _, err := part.Write(data); err != nil {
		return Message{}, err
	}
	if err := writer.Close(); err != nil {
		return Message{}, err
	}

	url := fmt.Sprintf("%s/bot%s/sendDocument", c.baseURL, c.token)
	ctx, cancel := context.WithTimeout(ctx, downloadUploadTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, url, &buf)
	if err != nil {
		return Message{}, err
	}
	request.Header.Set("Content-Type", writer.FormDataContentType())
	response, err := c.http.Do(request)
	if err != nil {
		return Message{}, err
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 4*1024*1024))
	if err != nil {
		return Message{}, err
	}
	var decoded apiResponse
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return Message{}, fmt.Errorf("telegram: unreadable reply (%s)", response.Status)
	}
	if !decoded.OK {
		apiErr := &APIError{Code: decoded.ErrorCode, Description: decoded.Description}
		if decoded.Parameters != nil {
			apiErr.RetryAfter = decoded.Parameters.RetryAfter
		}
		return Message{}, apiErr
	}
	var message Message
	if len(decoded.Result) > 0 {
		_ = json.Unmarshal(decoded.Result, &message)
	}
	return message, nil
}

// EditMessageText updates a message in place, which is how the progress card
// avoids flooding the chat.
func (c *Client) EditMessageText(ctx context.Context, chatID int64, messageID int64, text string) error {
	return c.EditMessageTextWithKeyboard(ctx, chatID, messageID, text, nil)
}

// EditMessageTextWithKeyboard edits a message and replaces its inline keyboard
// at the same time. A nil keyboard leaves the current markup untouched; an empty
// keyboard removes the buttons, which is what a picker does once a choice is
// made.
func (c *Client) EditMessageTextWithKeyboard(ctx context.Context, chatID int64, messageID int64, text string, keyboard *InlineKeyboard) error {
	return c.editMessage(ctx, chatID, messageID, text, keyboard, "")
}

// EditMarkdown edits a message from Markdown, with the same safe-HTML and
// plain-text fallback as SendMarkdown.
func (c *Client) EditMarkdown(ctx context.Context, chatID int64, messageID int64, markdown string, keyboard *InlineKeyboard) error {
	err := c.editMessage(ctx, chatID, messageID, markdownToTelegramHTML(markdown), keyboard, "HTML")
	if err != nil && isParseError(err) {
		return c.editMessage(ctx, chatID, messageID, markdown, keyboard, "")
	}
	return err
}

func (c *Client) editMessage(ctx context.Context, chatID int64, messageID int64, text string, keyboard *InlineKeyboard, parseMode string) error {
	payload := map[string]any{
		"chat_id":                  chatID,
		"message_id":               messageID,
		"text":                     clampText(text),
		"disable_web_page_preview": true,
	}
	if parseMode != "" {
		payload["parse_mode"] = parseMode
	}
	if keyboard != nil {
		if keyboard.InlineKeyboard == nil {
			keyboard.InlineKeyboard = [][]InlineButton{}
		}
		payload["reply_markup"] = keyboard
	}
	return c.call(ctx, "editMessageText", payload, nil)
}

// isParseError reports whether the API rejected the message body's entities,
// which is the one send failure that retrying as plain text repairs.
func isParseError(err error) bool {
	apiErr, ok := err.(*APIError)
	if !ok || apiErr.Code != http.StatusBadRequest {
		return false
	}
	lowered := strings.ToLower(apiErr.Description)
	return strings.Contains(lowered, "parse") || strings.Contains(lowered, "entities")
}

// maxDownloadBytes bounds one file download so a large upload cannot exhaust
// memory.
const maxDownloadBytes = 12 * 1024 * 1024

// downloadUploadTimeout bounds one file transfer (a download or a document
// upload) that is not a long-poll. The shared client keeps Timeout 0 because
// getUpdates legitimately runs for the whole poll window; a bounded request
// context instead bounds each transfer, so a stalled connection fails in a
// minute instead of hanging the update handler until the bot stops. It is a
// variable so a test can shorten it rather than wait out the real minute.
var downloadUploadTimeout = 60 * time.Second

// GetFile resolves a file id to a downloadable path.
func (c *Client) GetFile(ctx context.Context, fileID string) (File, error) {
	var file File
	err := c.call(ctx, "getFile", map[string]any{"file_id": fileID}, &file)
	return file, err
}

// DownloadFile fetches a file's bytes. The path comes from GetFile.
func (c *Client) DownloadFile(ctx context.Context, filePath string) ([]byte, error) {
	if strings.TrimSpace(filePath) == "" {
		return nil, fmt.Errorf("telegram: empty file path")
	}
	url := fmt.Sprintf("%s/file/bot%s/%s", c.baseURL, c.token, filePath)
	ctx, cancel := context.WithTimeout(ctx, downloadUploadTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	response, err := c.http.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Errorf("telegram: file download returned %s", response.Status)
	}
	return io.ReadAll(io.LimitReader(response.Body, maxDownloadBytes))
}

// SendChatAction shows a typing indicator.
func (c *Client) SendChatAction(ctx context.Context, chatID int64, action string) error {
	return c.call(ctx, "sendChatAction", map[string]any{"chat_id": chatID, "action": action}, nil)
}

// AnswerCallbackQuery clears an inline button's spinner.
func (c *Client) AnswerCallbackQuery(ctx context.Context, id, text string) error {
	payload := map[string]any{"callback_query_id": id}
	if text != "" {
		payload["text"] = text
	}
	return c.call(ctx, "answerCallbackQuery", payload, nil)
}

// SetMyCommands publishes the command menu.
func (c *Client) SetMyCommands(ctx context.Context, commands []BotCommand) error {
	return c.call(ctx, "setMyCommands", map[string]any{"commands": commands}, nil)
}

// clampText trims a body to Telegram's limit on a line boundary.
//
// The cut lands on a rune boundary as well as a line one. A Telegram body is
// free text and often holds emoji or non-Latin script, and a byte slice through
// the middle of one makes the body invalid UTF-8, which the Bot API rejects
// outright, so the message would never arrive.
func clampText(text string) string {
	if len(text) <= messageLimit {
		return text
	}
	cut := messageLimit - 32
	if index := strings.LastIndex(clipBytes(text, cut), "\n"); index > cut/2 {
		cut = index
	}
	return clipBytes(text, cut) + "\n... [truncated]"
}

// clipBytes returns the first limit bytes of text, moved back to a rune boundary.
func clipBytes(text string, limit int) string {
	if limit <= 0 || len(text) <= limit {
		return text
	}
	cut := limit
	for cut > 0 && !utf8.RuneStart(text[cut]) {
		cut--
	}
	return text[:cut]
}

// markdownChunks splits raw Markdown into parts whose converted Telegram HTML
// bodies fit within limit bytes.
//
// The Bot API refuses a body past its cap and clampText is a lossy last
// resort, so the split is measured on the CONVERSION, not the raw text: an
// entity-dense answer (a code block full of angle brackets and ampersands)
// grows when converted and must be cut shorter than its raw size suggests.
// Chunks rejoin into the original with no separator: a newline cut keeps the
// newline with the part that follows it.
func markdownChunks(markdown string, limit int) []string {
	if len(markdown) == 0 {
		return nil
	}
	var chunks []string
	rest := markdown
	for len(rest) > 0 {
		converted := len(markdownToTelegramHTML(rest))
		if converted <= limit {
			chunks = append(chunks, rest)
			break
		}
		target := len(rest) * limit / converted
		if target > telegramChunkLimit {
			target = telegramChunkLimit
		}
		// A stretch denser than the average needs a smaller cut than the
		// whole-text ratio suggests: re-measure the part and shrink until it
		// fits. The floor bounds the loop and always fits - 256 bytes cannot
		// expand past the cap even at the worst escaping ratio.
		for {
			part, remainder := nextChunk(rest, target)
			partHTML := len(markdownToTelegramHTML(part))
			if partHTML <= limit || target <= 256 {
				chunks = append(chunks, part)
				rest = remainder
				break
			}
			target = len(part) * limit / (partHTML + 1)
			if target > telegramChunkLimit {
				target = telegramChunkLimit
			}
			if target < 256 {
				target = 256
			}
		}
	}
	return chunks
}

// IsPrivate reports whether a chat id is a one-to-one chat.
func (chat Chat) IsPrivate() bool { return chat.Type == "private" }

// RetryAfterSeconds extracts the retry hint from an API error.
func RetryAfterSeconds(err error) int {
	if apiErr, ok := err.(*APIError); ok {
		return apiErr.RetryAfter
	}
	return 0
}

// BotIDFromToken reads the numeric bot id, which scopes the update offset so
// two bots never share a cursor.
func BotIDFromToken(token string) string {
	if index := strings.Index(token, ":"); index > 0 {
		return token[:index]
	}
	return ""
}
