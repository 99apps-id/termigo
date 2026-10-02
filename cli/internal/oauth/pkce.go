package oauth

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
)

// PKCEFlow is an OAuth 2.0 authorization-code flow with PKCE and a loopback
// redirect. Claude and Google Antigravity use it.
type PKCEFlow struct {
	ClientID     string
	ClientSecret string
	AuthorizeURL string
	TokenURL     string
	Scopes       []string
	RedirectHost string
	RedirectPort int
	RedirectPath string
	ExtraAuth    map[string]string
	// ExchangeJSON and RefreshJSON send the token request as JSON instead of a
	// form, which the Anthropic endpoint expects.
	ExchangeJSON bool
	RefreshJSON  bool
	// RefreshScope is included on the refresh grant when a vendor requires it.
	RefreshScope string
}

type pkceSession struct {
	flow        PKCEFlow
	verifier    string
	state       string
	redirectURI string
	server      *http.Server
	listener    net.Listener
	codeCh      chan string
	errCh       chan error
	once        sync.Once
}

func randomURLSafe(bytes int) (string, error) {
	buffer := make([]byte, bytes)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buffer), nil
}

func pkceChallenge(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

// StartPKCE opens the loopback listener and returns the URL to visit.
func StartPKCE(flow PKCEFlow) (*pkceSession, string, error) {
	host := strings.TrimSpace(flow.RedirectHost)
	if host == "" {
		host = "127.0.0.1"
	}
	path := strings.TrimSpace(flow.RedirectPath)
	if path == "" {
		path = "/callback"
	}
	verifier, err := randomURLSafe(32)
	if err != nil {
		return nil, "", err
	}
	state, err := randomURLSafe(16)
	if err != nil {
		return nil, "", err
	}
	listener, err := net.Listen("tcp", fmt.Sprintf("%s:%d", host, flow.RedirectPort))
	if err != nil {
		return nil, "", fmt.Errorf("open the login callback port: %w", err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	session := &pkceSession{
		flow:        flow,
		verifier:    verifier,
		state:       state,
		redirectURI: fmt.Sprintf("http://%s:%d%s", host, port, path),
		listener:    listener,
		codeCh:      make(chan string, 1),
		errCh:       make(chan error, 1),
	}
	mux := http.NewServeMux()
	mux.HandleFunc(path, session.handle)
	session.server = &http.Server{Handler: mux}
	go func() {
		if err := session.server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			select {
			case session.errCh <- err:
			default:
			}
		}
	}()
	authURL, err := session.authorizeURL()
	if err != nil {
		session.Close()
		return nil, "", err
	}
	return session, authURL, nil
}

func (s *pkceSession) handle(writer http.ResponseWriter, request *http.Request) {
	query := request.URL.Query()
	if value := query.Get("error"); value != "" {
		fmt.Fprintf(writer, "Login failed: %s", value)
		select {
		case s.errCh <- fmt.Errorf("login was denied: %s", value):
		default:
		}
		return
	}
	if query.Get("state") != s.state {
		fmt.Fprint(writer, "Login failed: state mismatch.")
		select {
		case s.errCh <- errors.New("the login callback state does not match"):
		default:
		}
		return
	}
	code := query.Get("code")
	if code == "" {
		fmt.Fprint(writer, "Login failed: no code was returned.")
		select {
		case s.errCh <- errors.New("the login callback had no code"):
		default:
		}
		return
	}
	fmt.Fprint(writer, "Login complete. You can close this window and return to Termixgo.")
	select {
	case s.codeCh <- code:
	default:
	}
}

func (s *pkceSession) authorizeURL() (string, error) {
	endpoint, err := url.Parse(s.flow.AuthorizeURL)
	if err != nil {
		return "", err
	}
	query := endpoint.Query()
	query.Set("response_type", "code")
	query.Set("client_id", s.flow.ClientID)
	query.Set("redirect_uri", s.redirectURI)
	query.Set("state", s.state)
	query.Set("code_challenge", pkceChallenge(s.verifier))
	query.Set("code_challenge_method", "S256")
	if len(s.flow.Scopes) > 0 {
		query.Set("scope", strings.Join(s.flow.Scopes, " "))
	}
	for key, value := range s.flow.ExtraAuth {
		query.Set(key, value)
	}
	endpoint.RawQuery = strings.ReplaceAll(query.Encode(), "+", "%20")
	return endpoint.String(), nil
}

// Wait blocks for the callback and exchanges the code for a token. When in is
// not nil the operator can instead open the URL on another machine and paste the
// redirect URL (or the code) back, which is how a headless server logs in.
func (s *pkceSession) Wait(ctx context.Context, clock Clock, in io.Reader) (Token, error) {
	defer s.Close()
	pasted := make(chan string, 1)
	if in != nil {
		go func() {
			scanner := bufio.NewScanner(in)
			for scanner.Scan() {
				line := strings.TrimSpace(scanner.Text())
				if !looksLikePastedCode(line) {
					continue
				}
				select {
				case pasted <- line:
				default:
				}
				return
			}
		}()
	}
	var code string
	select {
	case code = <-s.codeCh:
	case input := <-pasted:
		parsedCode, state, ok := extractPastedCode(input)
		if !ok {
			return Token{}, errors.New("the pasted value did not contain a code")
		}
		if state != "" && state != s.state {
			return Token{}, errors.New("the pasted login state does not match")
		}
		code = parsedCode
	case err := <-s.errCh:
		return Token{}, err
	case <-ctx.Done():
		return Token{}, ctx.Err()
	}
	return s.exchange(ctx, code, clock)
}

// looksLikePastedCode keeps a stray keypress from being mistaken for a code:
// only a redirect URL, a query string, a code#state pair, or a long tokenless
// string is accepted.
func looksLikePastedCode(line string) bool {
	if line == "" {
		return false
	}
	if strings.Contains(line, "code=") || strings.Contains(line, "://") || strings.Contains(line, "#") {
		return true
	}
	return !strings.ContainsAny(line, " \t") && len(line) >= 16
}

// extractPastedCode accepts the redirect URL, its query string, a code#state
// pair, or a bare code, and returns the code and the state when one is present.
func extractPastedCode(input string) (string, string, bool) {
	trimmed := strings.TrimSpace(input)
	if trimmed == "" {
		return "", "", false
	}
	if parsed, err := url.Parse(trimmed); err == nil {
		if code := parsed.Query().Get("code"); code != "" {
			return code, parsed.Query().Get("state"), true
		}
	}
	if strings.Contains(trimmed, "code=") {
		if values, err := url.ParseQuery(trimmed); err == nil {
			if code := values.Get("code"); code != "" {
				return code, values.Get("state"), true
			}
		}
	}
	if idx := strings.Index(trimmed, "#"); idx >= 0 {
		return trimmed[:idx], trimmed[idx+1:], trimmed[:idx] != ""
	}
	return trimmed, "", true
}

func (s *pkceSession) exchange(ctx context.Context, code string, clock Clock) (Token, error) {
	authCode := code
	codeState := s.state
	if idx := strings.Index(authCode, "#"); idx >= 0 {
		if fragmentState := authCode[idx+1:]; fragmentState != "" {
			codeState = fragmentState
		}
		authCode = authCode[:idx]
	}
	payload := map[string]string{
		"grant_type":    "authorization_code",
		"code":          authCode,
		"redirect_uri":  s.redirectURI,
		"client_id":     s.flow.ClientID,
		"code_verifier": s.verifier,
	}
	if codeState != "" {
		payload["state"] = codeState
	}
	if s.flow.ClientSecret != "" {
		payload["client_secret"] = s.flow.ClientSecret
	}
	return tokenRequest(ctx, s.flow.TokenURL, payload, s.flow.ExchangeJSON, clock)
}

// Close stops the callback server.
func (s *pkceSession) Close() {
	s.once.Do(func() {
		if s.server != nil {
			_ = s.server.Close()
		}
	})
}

// RefreshPKCE renews a PKCE token.
func RefreshPKCE(ctx context.Context, flow PKCEFlow, refreshToken string, clock Clock) (Token, error) {
	payload := map[string]string{
		"grant_type":    "refresh_token",
		"refresh_token": refreshToken,
		"client_id":     flow.ClientID,
	}
	if flow.ClientSecret != "" {
		payload["client_secret"] = flow.ClientSecret
	}
	if strings.TrimSpace(flow.RefreshScope) != "" {
		payload["scope"] = flow.RefreshScope
	}
	token, err := tokenRequest(ctx, flow.TokenURL, payload, flow.RefreshJSON, clock)
	if err != nil {
		return Token{}, err
	}
	if token.Refresh == "" {
		token.Refresh = refreshToken
	}
	return token, nil
}

func tokenRequest(ctx context.Context, endpoint string, payload map[string]string, asJSON bool, clock Clock) (Token, error) {
	var body []byte
	var status int
	var err error
	if asJSON {
		object := make(map[string]any, len(payload))
		for key, value := range payload {
			object[key] = value
		}
		body, status, err = requestJSON(ctx, http.MethodPost, endpoint, nil, object)
	} else {
		body, status, err = requestForm(ctx, endpoint, payload)
	}
	if err != nil {
		return Token{}, err
	}
	if status >= 300 {
		return Token{}, statusError(endpoint, status, body)
	}
	var parsed tokenResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		return Token{}, err
	}
	if parsed.AccessToken == "" {
		return Token{}, fmt.Errorf("the token response had no access_token")
	}
	return tokenFrom(parsed, clock.now()), nil
}
