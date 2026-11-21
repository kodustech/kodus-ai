package policy

import (
	"crypto/rand"
	"encoding/base32"
	"fmt"
	"regexp"
	"slices"
	"strings"
)

// Secret is one org secret a claim's machines see only as a placeholder
// (docs/runtime/sandbox.md "Secrets: OpenBao"). The machine holds
// Placeholder; the injector swaps it for the value it reads from the secret
// store, on requests to Hosts only. The value never enters the machine, the
// policy or a frame.
type Secret struct {
	// ID names the secret in the store (orgs/<org>/secrets/<id>).
	ID string `json:"id"`
	// Placeholder is random per claim (NewPlaceholder): worthless outside it.
	Placeholder string `json:"placeholder"`
	// Hosts are the exact hosts the value may go to, each on CredentialHosts.
	Hosts []string `json:"hosts"`
}

// PlaceholderPrefix starts every placeholder, so a placeholder is
// recognizable in any traffic the cell can read.
const PlaceholderPrefix = "kph_"

var (
	placeholderPattern = regexp.MustCompile(`^kph_[a-z2-7]{32}$`)
	secretIDPattern    = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)
	placeholderAlpha   = base32.NewEncoding("abcdefghijklmnopqrstuvwxyz234567").WithPadding(base32.NoPadding)
)

// NewPlaceholder is kph_ and 160 random bits in lowercase base32: a value
// tools accept as a token, a password or a header.
func NewPlaceholder() (string, error) {
	b := make([]byte, 20)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("policy: placeholder: %w", err)
	}
	return PlaceholderPrefix + placeholderAlpha.EncodeToString(b), nil
}

// ValidPlaceholder reports whether s has the placeholder's exact form.
func ValidPlaceholder(s string) bool { return placeholderPattern.MatchString(s) }

// ValidSecretID reports whether s is a secret id the store layout accepts.
func ValidSecretID(s string) bool { return secretIDPattern.MatchString(s) }

// SecretsFor are the claim's secrets whose value may go to host.
func (p ClaimPolicy) SecretsFor(host string) []Secret {
	var out []Secret
	for _, s := range p.Secrets {
		if slices.Contains(s.Hosts, host) {
			out = append(out, s)
		}
	}
	return out
}

// Placeholders are every placeholder the claim's machines hold.
func (p ClaimPolicy) Placeholders() []string {
	out := make([]string, 0, len(p.Secrets))
	for _, s := range p.Secrets {
		out = append(out, s.Placeholder)
	}
	return out
}

// withSecrets adds the secrets' hosts to the allowlist (the admin who wrote
// the secret named them) and to CredentialHosts, after the deny list: a
// denied host never carries a value, and a secret left with no host is
// dropped. It returns the hosts it refused.
func withSecrets(p *ClaimPolicy, secrets []Secret, denied func(string) bool) ([]string, error) {
	var refused []string
	allow := slices.Clone(p.Allow)
	credential := map[string]bool{}
	for _, s := range secrets {
		kept := s
		kept.Hosts = nil
		for _, h := range s.Hosts {
			n, err := NormalizeHost(h)
			if err != nil || strings.Contains(h, "*") {
				return nil, fmt.Errorf("policy: secret %q host %q is not an exact host", s.ID, h)
			}
			if denied != nil && denied(n) {
				refused = append(refused, n)
				continue
			}
			kept.Hosts = append(kept.Hosts, n)
			credential[n] = true
			if !slices.Contains(allow, n) {
				allow = append(allow, n)
			}
		}
		if len(kept.Hosts) == 0 {
			continue
		}
		slices.Sort(kept.Hosts)
		kept.Hosts = slices.Compact(kept.Hosts)
		p.Secrets = append(p.Secrets, kept)
	}
	slices.Sort(allow)
	p.Allow = allow
	for h := range credential {
		if !slices.Contains(p.CredentialHosts, h) {
			p.CredentialHosts = append(p.CredentialHosts, h)
		}
	}
	slices.Sort(p.CredentialHosts)
	return refused, nil
}

func (p ClaimPolicy) validateSecrets() error {
	ids := map[string]bool{}
	placeholders := map[string]bool{}
	for _, s := range p.Secrets {
		if !ValidSecretID(s.ID) || ids[s.ID] {
			return fmt.Errorf("policy: secret id %q is invalid or repeated", s.ID)
		}
		if !ValidPlaceholder(s.Placeholder) || placeholders[s.Placeholder] {
			return fmt.Errorf("policy: secret %q has an invalid or repeated placeholder", s.ID)
		}
		ids[s.ID], placeholders[s.Placeholder] = true, true
		if len(s.Hosts) == 0 {
			return fmt.Errorf("policy: secret %q has no host", s.ID)
		}
		for _, h := range s.Hosts {
			if !p.Injects(h) {
				return fmt.Errorf("policy: secret %q host %q is not a credential host", s.ID, h)
			}
		}
	}
	return nil
}
