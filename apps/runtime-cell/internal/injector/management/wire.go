// Package management exposes write-only vault administration to the injector's
// local OS owner. It is not a product RBAC API or a claim-control transport.
package management

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strconv"
	"time"
	"unicode/utf8"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/injector"
)

const MaxBodyBytes = 16 << 10
const MaxResponseBytes = 256 << 10

// Error intentionally carries only a closed code and HTTP status, never input,
// socket paths, provider errors or a credential's value.
type Error struct {
	Code   string
	Status int
}

func (e *Error) Error() string               { return "injector management: " + e.Code }
func failure(code string, status int) *Error { return &Error{Code: code, Status: status} }

// VersionInfo is the complete metadata allowlist returned by list. No value is
// readable through this package, including from an untrusted server response.
type VersionInfo struct {
	OrganizationID string    `json:"organizationId"`
	EnvironmentID  string    `json:"environmentId"`
	ID             string    `json:"id"`
	Version        uint64    `json:"version"`
	ExpiresAt      time.Time `json:"expiresAt"`
	Revoked        bool      `json:"revoked"`
}

type request struct {
	org, env, id, value, claim, secretID, host, header string
	version                                            uint64
	expires                                            time.Time
}

var fields = map[string][]string{
	"put":               {"organizationId", "environmentId", "id", "version", "value", "expiresAt"},
	"register-external": {"organizationId", "environmentId", "id", "version", "expiresAt"},
	"list":              {"organizationId", "environmentId"},
	"bind":              {"organizationId", "environmentId", "claimId", "secretId", "version", "host", "header", "expiresAt"},
	"revoke-version":    {"organizationId", "environmentId", "id", "version"},
	"revoke-claim":      {"organizationId", "environmentId", "claimId"},
}

func decoder(raw []byte) (*json.Decoder, error) {
	if len(raw) == 0 || !utf8.Valid(raw) {
		return nil, failure("invalid_request", 400)
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	return d, nil
}
func flat(d *json.Decoder, allowed []string) (map[string]any, error) {
	t, e := d.Token()
	if e != nil || t != json.Delim('{') {
		return nil, failure("invalid_request", 400)
	}
	m := make(map[string]any, len(allowed))
	for d.More() {
		k, e := d.Token()
		key, ok := k.(string)
		if e != nil || !ok {
			return nil, failure("invalid_request", 400)
		}
		valid := false
		for _, a := range allowed {
			if key == a {
				valid = true
				break
			}
		}
		if !valid {
			return nil, failure("invalid_request", 400)
		}
		if _, ok = m[key]; ok {
			return nil, failure("invalid_request", 400)
		}
		v, e := d.Token()
		if e != nil {
			return nil, failure("invalid_request", 400)
		}
		switch v.(type) {
		case string, json.Number, bool:
		default:
			return nil, failure("invalid_request", 400)
		}
		m[key] = v
	}
	t, e = d.Token()
	if e != nil || t != json.Delim('}') || len(m) != len(allowed) {
		return nil, failure("invalid_request", 400)
	}
	return m, nil
}
func end(d *json.Decoder) bool { _, e := d.Token(); return errors.Is(e, io.EOF) }
func stringField(m map[string]any, key string) (string, error) {
	s, ok := m[key].(string)
	if !ok || s == "" {
		return "", failure("invalid_request", 400)
	}
	return s, nil
}
func uintField(m map[string]any, key string) (uint64, error) {
	n, ok := m[key].(json.Number)
	if !ok {
		return 0, failure("invalid_request", 400)
	}
	s := n.String()
	for _, c := range s {
		if c < '0' || c > '9' {
			return 0, failure("invalid_request", 400)
		}
	}
	v, e := strconv.ParseUint(s, 10, 64)
	if e != nil || v == 0 || v > 1<<53 {
		return 0, failure("invalid_request", 400)
	}
	return v, nil
}
func parseRequest(operation string, raw []byte) (request, error) {
	var r request
	a, ok := fields[operation]
	if !ok {
		return r, failure("invalid_operation", 404)
	}
	if len(raw) > MaxBodyBytes {
		return r, failure("too_large", 413)
	}
	d, e := decoder(raw)
	if e != nil {
		return r, e
	}
	m, e := flat(d, a)
	if e != nil || !end(d) {
		return r, failure("invalid_request", 400)
	}
	dest := map[string]*string{"organizationId": &r.org, "environmentId": &r.env, "id": &r.id, "value": &r.value, "claimId": &r.claim, "secretId": &r.secretID, "host": &r.host, "header": &r.header}
	for _, k := range a {
		if ptr, ok := dest[k]; ok {
			*ptr, e = stringField(m, k)
		} else if k == "version" {
			r.version, e = uintField(m, k)
		} else if k == "expiresAt" {
			var s string
			s, e = stringField(m, k)
			if e == nil {
				r.expires, e = time.Parse(time.RFC3339Nano, s)
			}
		}
		if e != nil {
			return request{}, failure("invalid_request", 400)
		}
	}
	return r, nil
}
func (r request) scope() injector.SecretScope {
	return injector.SecretScope{OrganizationID: r.org, EnvironmentID: r.env}
}
func (r request) claimScope() injector.ClaimScope {
	return injector.ClaimScope{SecretScope: r.scope(), ClaimID: r.claim}
}

func sanitizeList(raw []byte, scope injector.SecretScope) ([]byte, error) {
	if len(raw) > MaxResponseBytes {
		return nil, failure("unavailable", 503)
	}
	d, e := decoder(raw)
	if e != nil {
		return nil, failure("unavailable", 503)
	}
	t, e := d.Token()
	if e != nil || t != json.Delim('{') {
		return nil, failure("unavailable", 503)
	}
	t, e = d.Token()
	if e != nil || t != "versions" {
		return nil, failure("unavailable", 503)
	}
	t, e = d.Token()
	if e != nil || t != json.Delim('[') {
		return nil, failure("unavailable", 503)
	}
	rows := make([]VersionInfo, 0)
	for d.More() {
		if len(rows) >= 256 {
			return nil, failure("unavailable", 503)
		}
		m, e := flat(d, []string{"organizationId", "environmentId", "id", "version", "expiresAt", "revoked"})
		if e != nil {
			return nil, failure("unavailable", 503)
		}
		var v VersionInfo
		v.OrganizationID, e = stringField(m, "organizationId")
		if e != nil || v.OrganizationID != scope.OrganizationID {
			return nil, failure("unavailable", 503)
		}
		v.EnvironmentID, e = stringField(m, "environmentId")
		if e != nil || v.EnvironmentID != scope.EnvironmentID {
			return nil, failure("unavailable", 503)
		}
		v.ID, e = stringField(m, "id")
		if e != nil || !validID(v.ID) {
			return nil, failure("unavailable", 503)
		}
		v.Version, e = uintField(m, "version")
		if e != nil {
			return nil, failure("unavailable", 503)
		}
		s, e := stringField(m, "expiresAt")
		if e != nil {
			return nil, failure("unavailable", 503)
		}
		v.ExpiresAt, e = time.Parse(time.RFC3339Nano, s)
		if e != nil || v.ExpiresAt.IsZero() {
			return nil, failure("unavailable", 503)
		}
		revoked, ok := m["revoked"].(bool)
		v.Revoked = revoked
		if !ok {
			return nil, failure("unavailable", 503)
		}
		rows = append(rows, v)
	}
	t, e = d.Token()
	if e != nil || t != json.Delim(']') {
		return nil, failure("unavailable", 503)
	}
	t, e = d.Token()
	if e != nil || t != json.Delim('}') || !end(d) {
		return nil, failure("unavailable", 503)
	}
	return json.Marshal(struct {
		Versions []VersionInfo `json:"versions"`
	}{rows})
}
func validID(s string) bool {
	if len(s) < 1 || len(s) > 96 {
		return false
	}
	for i, c := range s {
		if c > 127 || !(c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || i > 0 && (c == '_' || c == '.' || c == ':' || c == '-')) {
			return false
		}
	}
	return true
}
