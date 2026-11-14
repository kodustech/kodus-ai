// Package redact is the cell's last pass over everything that leaves it
// (docs §10, S-51): exact values the cell knows, in every spelling, then a
// token-pattern net for the values it never knew. The replacement is one
// way, "[redacted:<rule>]": nothing downstream needs the value, because
// credentials reach the app through the injector, never through output.
package redact

import (
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

// minEncodedCore is the shortest base64 run worth masking: shorter cores
// would blank unrelated text.
const minEncodedCore = 8

// Variants is a faithful port of secretVariants in
// libs/code-review/infrastructure/agents/custom-agent-cli/cli-output-mask.ts:
// the value, its base64 / base64url, the base64 core it keeps when embedded
// in a longer encoded string at any of the three byte alignments, its
// percent encoding (either hex case), hex (both cases, plain and byte
// pairs) and JSON string escapes (JSON.stringify and \u-escaped).
func Variants(secret string) []string {
	if secret == "" {
		return nil
	}
	var order []string
	seen := map[string]bool{}
	add := func(v string) {
		if v != "" && !seen[v] {
			seen[v] = true
			order = append(order, v)
		}
	}
	add(secret)
	b := []byte(secret)
	for offset := 0; offset < 3; offset++ {
		padded := append(make([]byte, offset), b...)
		full := base64.StdEncoding.EncodeToString(padded)
		encoded := strings.TrimRight(full, "=")
		// Characters that also carry bits of the unknown neighbours are
		// not part of the secret's fixed encoding: drop them at both ends.
		head := (offset*8 + 5) / 6 // Math.ceil(offset*8/6)
		tail := 0
		if (len(padded)*8)%6 != 0 {
			tail = 1
		}
		core := ""
		if end := len(encoded) - tail; end > head {
			core = encoded[head:end]
		}
		if offset == 0 {
			add(full)
			add(encoded)
		}
		if len(core) >= minEncodedCore {
			add(core)
		}
	}
	for _, v := range append([]string(nil), order...) {
		u := strings.TrimRight(strings.NewReplacer("+", "-", "/", "_").Replace(v), "=")
		if len(u) >= minEncodedCore || u == secret {
			add(u)
		}
	}
	percent := EncodeURIComponent(secret)
	add(percent)
	add(lowerPercent(percent))
	h := hex.EncodeToString(b)
	pairs := make([]string, 0, len(h)/2)
	for i := 0; i+1 < len(h); i += 2 {
		pairs = append(pairs, h[i:i+2])
	}
	for _, v := range []string{h, strings.Join(pairs, " ")} {
		add(v)
		add(strings.ToUpper(v))
	}
	add(jsonStringBody(secret))
	add(unicodeEscaped(secret))
	return order
}

// EncodeURIComponent is ECMAScript's encodeURIComponent: every byte of the
// UTF-8 form is %XX (upper case) except A-Z a-z 0-9 - _ . ! ~ * ' ( ).
func EncodeURIComponent(s string) string {
	var out strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || strings.IndexByte("-_.!~*'()", c) >= 0 {
			out.WriteByte(c)
			continue
		}
		fmt.Fprintf(&out, "%%%02X", c)
	}
	return out.String()
}

func lowerPercent(s string) string {
	b := []byte(s)
	for i := 0; i+2 < len(b); i++ {
		if b[i] == '%' && isUpperHex(b[i+1]) && isUpperHex(b[i+2]) {
			b[i+1], b[i+2] = lowerHex(b[i+1]), lowerHex(b[i+2])
			i += 2
		}
	}
	return string(b)
}

func isUpperHex(c byte) bool { return c >= '0' && c <= '9' || c >= 'A' && c <= 'F' }
func lowerHex(c byte) byte {
	if c >= 'A' && c <= 'F' {
		return c + ('a' - 'A')
	}
	return c
}

// jsonStringBody is JSON.stringify(s).slice(1, -1): only " and \ and the
// control characters are escaped; < > & / and non-ASCII stay as they are
// (Go's encoding/json would escape <, > and & by default).
func jsonStringBody(s string) string {
	var out strings.Builder
	for _, r := range s {
		switch r {
		case '"':
			out.WriteString(`\"`)
		case '\\':
			out.WriteString(`\\`)
		case '\b':
			out.WriteString(`\b`)
		case '\f':
			out.WriteString(`\f`)
		case '\n':
			out.WriteString(`\n`)
		case '\r':
			out.WriteString(`\r`)
		case '\t':
			out.WriteString(`\t`)
		default:
			if r < 0x20 {
				fmt.Fprintf(&out, `\u%04x`, r)
			} else {
				out.WriteRune(r)
			}
		}
	}
	return out.String()
}

// unicodeEscaped \u-escapes every character outside printable ASCII and
// each of "\/<>&' per UTF-16 code unit, as String.prototype.replace with
// /[^\x20-\x7e]|["\\/<>&']/g and charCodeAt does (a character outside the
// BMP becomes its surrogate pair).
func unicodeEscaped(s string) string {
	var out strings.Builder
	for len(s) > 0 {
		r, size := utf8.DecodeRuneInString(s)
		s = s[size:]
		if r >= 0x20 && r <= 0x7e && !strings.ContainsRune("\"\\/<>&'", r) {
			out.WriteRune(r)
			continue
		}
		if r > 0xFFFF {
			hi, lo := utf16.EncodeRune(r)
			fmt.Fprintf(&out, `\u%04x\u%04x`, hi, lo)
			continue
		}
		fmt.Fprintf(&out, `\u%04x`, r)
	}
	return out.String()
}
