package telegram

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// scriptedAPI is a Bot API stand-in that records every call and lets a test
// decide how an edit is answered.
type scriptedAPI struct {
	mu    sync.Mutex
	calls []apiCall
	// editReply decides the answer to the nth editMessageText; nil means ok.
	editReply func(n int) (code int, description string)
	edits     int
	nextID    int64
}

type apiCall struct {
	method string
	body   map[string]any
}

func (s *scriptedAPI) server(t *testing.T) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var body map[string]any
		_ = json.Unmarshal(raw, &body)
		method := r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]
		s.mu.Lock()
		s.calls = append(s.calls, apiCall{method: method, body: body})
		result := `true`
		failCode, failText := 0, ""
		switch method {
		case "sendMessage":
			s.nextID++
			result = `{"message_id":` + itoa(s.nextID) + `}`
		case "editMessageText":
			s.edits++
			if s.editReply != nil {
				failCode, failText = s.editReply(s.edits)
			}
		}
		s.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		if failCode != 0 {
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error_code": failCode, "description": failText})
			return
		}
		_, _ = w.Write([]byte(`{"ok":true,"result":` + result + `}`))
	}))
	t.Cleanup(server.Close)
	return server
}

func (s *scriptedAPI) count(method string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	total := 0
	for _, call := range s.calls {
		if call.method == method {
			total++
		}
	}
	return total
}

func (s *scriptedAPI) texts(method string) []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []string
	for _, call := range s.calls {
		if call.method == method {
			text, _ := call.body["text"].(string)
			out = append(out, text)
		}
	}
	return out
}

func itoa(value int64) string {
	data, _ := json.Marshal(value)
	return string(data)
}

type cardAgent struct {
	answer  string
	err     error
	steered []string
}

func (a *cardAgent) RunPrompt(_ context.Context, _ string, progress func(string)) (string, error) {
	if progress != nil {
		progress("tool: read_file")
	}
	return a.answer, a.err
}
func (a *cardAgent) RunPromptWithImage(ctx context.Context, prompt, _, _ string, progress func(string)) (string, error) {
	return a.RunPrompt(ctx, prompt, progress)
}
func (a *cardAgent) Stop()                           {}
func (a *cardAgent) NewSession()                     {}
func (a *cardAgent) Model() string                   { return "m" }
func (a *cardAgent) SetModel(string) (string, error) { return "m", nil }
func (a *cardAgent) Status() string                  { return "" }

type steerableAgent struct{ cardAgent }

func (a *steerableAgent) Steer(prompt string) bool {
	a.steered = append(a.steered, prompt)
	return true
}

func newCardBot(t *testing.T, api *scriptedAPI, agent Agent) *Bot {
	t.Helper()
	return &Bot{client: newClientAt("tok", api.server(t).URL), agent: agent}
}

// "message is not modified" means the message already shows the text, which is
// a successful edit.
func TestNotModifiedEditIsNotAFailure(t *testing.T) {
	api := &scriptedAPI{editReply: func(int) (int, string) {
		return http.StatusBadRequest, "Bad Request: message is not modified: specified new message content and reply markup are exactly the same"
	}}
	client := newClientAt("tok", api.server(t).URL)
	if err := client.EditMarkdown(context.Background(), 1, 5, "same", nil); err != nil {
		t.Fatalf("a not-modified edit should succeed, got %v", err)
	}
	// Any other 400 is still a failure.
	api2 := &scriptedAPI{editReply: func(int) (int, string) { return http.StatusBadRequest, "Bad Request: message to edit not found" }}
	client2 := newClientAt("tok", api2.server(t).URL)
	if err := client2.EditMarkdown(context.Background(), 1, 5, "x", nil); err == nil {
		t.Fatal("a different 400 must stay an error")
	}
}

// The answer is edited onto the progress card once. A final edit answered
// "not modified" used to fall through to a second copy as a new message.
func TestAnswerAppearsOnceWhenTheCardAlreadyShowsIt(t *testing.T) {
	api := &scriptedAPI{editReply: func(n int) (int, string) {
		if n >= 1 {
			return http.StatusBadRequest, "Bad Request: message is not modified"
		}
		return 0, ""
	}}
	bot := newCardBot(t, api, &cardAgent{answer: "all done"})
	bot.runPrompt(context.Background(), 1, "do it")
	if got := api.count("sendMessage"); got != 1 {
		t.Fatalf("only the progress card should be sent, got %d messages: %q", got, api.texts("sendMessage"))
	}
	if api.count("deleteMessage") != 0 {
		t.Fatalf("a card that shows the answer must stay")
	}
}

// When the card cannot be rewritten, the answer goes out as its own message and
// the stale card is removed rather than left above it.
func TestFailedFinalEditSendsTheAnswerOnceAndRemovesTheCard(t *testing.T) {
	api := &scriptedAPI{editReply: func(int) (int, string) {
		return http.StatusBadRequest, "Bad Request: message to edit not found"
	}}
	bot := newCardBot(t, api, &cardAgent{answer: "all done"})
	bot.runPrompt(context.Background(), 1, "do it")
	sent := api.texts("sendMessage")
	if len(sent) != 2 || !strings.Contains(sent[1], "all done") {
		t.Fatalf("want the card then the answer, got %q", sent)
	}
	if api.count("deleteMessage") != 1 {
		t.Fatalf("the stale card should be deleted, deletes = %d", api.count("deleteMessage"))
	}
}

func TestMessageWhileRunningSteersASteerableAgent(t *testing.T) {
	api := &scriptedAPI{}
	agent := &steerableAgent{}
	bot := newCardBot(t, api, agent)
	bot.running = true
	bot.runPrompt(context.Background(), 1, "also add tests")
	if len(agent.steered) != 1 || agent.steered[0] != "also add tests" {
		t.Fatalf("steered = %q", agent.steered)
	}
	sent := api.texts("sendMessage")
	if len(sent) != 1 || !strings.Contains(sent[0], "Steer message accepted") {
		t.Fatalf("the operator should be told the steer landed, got %q", sent)
	}
}

func TestMessageWhileRunningIsRefusedWithoutSteering(t *testing.T) {
	api := &scriptedAPI{}
	bot := newCardBot(t, api, &cardAgent{})
	bot.running = true
	bot.runPrompt(context.Background(), 1, "also add tests")
	sent := api.texts("sendMessage")
	if len(sent) != 1 || !strings.Contains(sent[0], "already in progress") {
		t.Fatalf("got %q", sent)
	}
}
