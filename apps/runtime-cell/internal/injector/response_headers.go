package injector

import (
	"net/http"
	"strings"
)

// Header names are case-insensitive. Canonicalization must not turn a known
// credential reflected in a name into an unmasked value visible to the guest.
// Refuse the whole response; renaming a field would change HTTP semantics.
func sensitiveResponseHeaderName(headers http.Header, secrets []string) bool {
	folded := make([]string, len(secrets))
	for i, secret := range secrets {
		folded[i] = strings.ToLower(secret)
	}
	for name := range headers {
		name = strings.ToLower(name)
		for _, secret := range folded {
			if secret != "" && strings.Contains(name, secret) {
				return true
			}
		}
	}
	return false
}
