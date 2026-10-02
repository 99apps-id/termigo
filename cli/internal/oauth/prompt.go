package oauth

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"strings"

	"golang.org/x/term"
)

// promptClientCredentials asks for the public installed-app OAuth pair a
// vendor's own CLI ships. The pair is stored in the secret file, not the
// repository, so secret scanning never sees it. The secret is hidden when the
// input is a terminal.
// knownID and knownSecret skip a question when the value is already resolved,
// so a login that only lost its secret asks for the secret alone.
func promptClientCredentials(in io.Reader, out io.Writer, provider, knownID, knownSecret string) (string, string, error) {
	id := strings.TrimSpace(knownID)
	secret := strings.TrimSpace(knownSecret)
	reader := bufio.NewReader(in)
	if id == "" {
		fmt.Fprintf(out, "%s needs the public OAuth client id and secret its own CLI ships.\n", provider)
		fmt.Fprint(out, "Client id: ")
		line, err := readPromptLine(reader)
		if err != nil {
			return "", "", err
		}
		id = line
	}
	if secret == "" {
		fmt.Fprint(out, "Client secret: ")
		line, err := readPromptSecret(in, reader)
		if err != nil {
			return "", "", err
		}
		secret = line
	}
	if id == "" {
		return "", "", fmt.Errorf("the client id is required")
	}
	if secret == "" {
		return "", "", fmt.Errorf("the client secret is required")
	}
	return id, secret, nil
}

func readPromptLine(reader *bufio.Reader) (string, error) {
	line, err := reader.ReadString('\n')
	if err != nil && line == "" {
		return "", err
	}
	return strings.TrimSpace(line), nil
}

func readPromptSecret(in io.Reader, reader *bufio.Reader) (string, error) {
	if file, ok := in.(*os.File); ok && term.IsTerminal(int(file.Fd())) {
		raw, err := term.ReadPassword(int(file.Fd()))
		fmt.Fprintln(io.Discard)
		if err != nil {
			return "", err
		}
		return strings.TrimSpace(string(raw)), nil
	}
	return readPromptLine(reader)
}
