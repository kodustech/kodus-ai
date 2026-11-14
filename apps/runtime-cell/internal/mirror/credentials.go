package mirror

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
)

// Credentials are a Docker Hub account the mirror pulls as (a higher rate
// limit than anonymous). They go only to the token service, never to a
// claim, and print as redacted whatever formats them.
type Credentials struct {
	Username string
	Token    string
}

func (Credentials) String() string               { return "mirror.Credentials{redacted}" }
func (c Credentials) GoString() string           { return c.String() }
func (Credentials) LogValue() slog.Value         { return slog.StringValue("redacted") }
func (c Credentials) Format(f fmt.State, _ rune) { _, _ = io.WriteString(f, c.String()) }

// LoadCredentials reads {"username": "...", "token": "..."} (a Docker Hub
// access token) from a file the operator provides. Its errors never quote
// the file's content.
func LoadCredentials(path string) (*Credentials, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("mirror: read the registry credentials: %w", err)
	}
	var v struct {
		Username string `json:"username"`
		Token    string `json:"token"`
	}
	if json.Unmarshal(b, &v) != nil || v.Username == "" || v.Token == "" {
		return nil, errors.New(`mirror: the registry credentials file is not {"username": ..., "token": ...}`)
	}
	return &Credentials{Username: v.Username, Token: v.Token}, nil
}
