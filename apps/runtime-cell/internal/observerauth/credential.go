// Package observerauth holds claim-local SQL credentials and provisioning data.
// It has no driver, guest, product, filesystem or network dependency.
package observerauth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"strings"

	"golang.org/x/crypto/pbkdf2"
)

// Credential is private cell-to-observer configuration, never a public Run field.
// JSON encoding is intentional only on the authenticated observer control path.
type Credential struct {
	Service  string `json:"service"`
	Port     int    `json:"port"`
	Database string `json:"database"`
	Username string `json:"username"`
	Password string `json:"password"`
}

func (Credential) String() string         { return "observerauth.Credential{redacted}" }
func (c Credential) GoString() string     { return c.String() }
func (c Credential) LogValue() slog.Value { return slog.StringValue(c.String()) }

var (
	serviceName  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$`)
	databaseName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_-]{0,62}$`)
	accountName  = regexp.MustCompile(`^kody_observer_[a-f0-9]{32}$`)
)

func (c Credential) Validate() error {
	p, err := base64.RawURLEncoding.DecodeString(c.Password)
	if !serviceName.MatchString(c.Service) || c.Port < 1 || c.Port > 65535 || !databaseName.MatchString(c.Database) || !accountName.MatchString(c.Username) || err != nil || len(p) != 32 || len(c.Password) != 43 {
		return errors.New("observerauth: invalid credential")
	}
	return nil
}

func NewCredential(service string, port int, database string) (Credential, error) {
	var name [16]byte
	var password [32]byte
	if _, err := rand.Read(name[:]); err != nil {
		return Credential{}, errors.New("observerauth: credential generation failed")
	}
	if _, err := rand.Read(password[:]); err != nil {
		return Credential{}, errors.New("observerauth: credential generation failed")
	}
	c := Credential{Service: service, Port: port, Database: database, Username: "kody_observer_" + hex.EncodeToString(name[:]), Password: base64.RawURLEncoding.EncodeToString(password[:])}
	if err := c.Validate(); err != nil {
		return Credential{}, err
	}
	return c, nil
}

// SCRAMVerifier creates PostgreSQL's SCRAM-SHA-256 verifier without sending the
// plaintext password to the guest. Passwords are generated ASCII, not user text.
func SCRAMVerifier(c Credential) (string, error) {
	if err := c.Validate(); err != nil {
		return "", err
	}
	var salt [16]byte
	if _, err := rand.Read(salt[:]); err != nil {
		return "", errors.New("observerauth: verifier generation failed")
	}
	salted := pbkdf2.Key([]byte(c.Password), salt[:], 4096, sha256.Size, sha256.New)
	key := func(label string) []byte {
		h := hmac.New(sha256.New, salted)
		_, _ = h.Write([]byte(label))
		return h.Sum(nil)
	}
	stored := sha256.Sum256(key("Client Key"))
	enc := base64.StdEncoding.EncodeToString
	return fmt.Sprintf("SCRAM-SHA-256$4096:%s$%s:%s", enc(salt[:]), enc(stored[:]), enc(key("Server Key"))), nil
}

func validVerifier(v string) bool {
	parts := strings.Split(v, "$")
	if len(parts) != 3 || parts[0] != "SCRAM-SHA-256" {
		return false
	}
	salt := strings.Split(parts[1], ":")
	keys := strings.Split(parts[2], ":")
	if len(salt) != 2 || salt[0] != "4096" || len(keys) != 2 {
		return false
	}
	for i, s := range []string{salt[1], keys[0], keys[1]} {
		b, err := base64.StdEncoding.DecodeString(s)
		want := 32
		if i == 0 {
			want = 16
		}
		if err != nil || len(b) != want || base64.StdEncoding.EncodeToString(b) != s {
			return false
		}
	}
	return true
}
