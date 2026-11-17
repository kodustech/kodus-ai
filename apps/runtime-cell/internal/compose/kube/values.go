package kube

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// interpolate does what docker compose does to a value with an empty
// environment, which is the one the cell runs compose with on its hosts
// (dockergvisor passes no interpolation file and a minimal environment):
// "$$" is a literal "$", ${NAME:-default} and ${NAME-default} are the
// default (interpolated in turn), ${NAME:?msg} and ${NAME?msg} are an
// error, every other reference ($NAME, ${NAME}, ${NAME:+x}) is empty, and
// a "$" that starts none of these is an invalid template, as in compose.
func interpolate(s string) (string, error) {
	if !strings.Contains(s, "$") {
		return s, nil
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c != '$' {
			b.WriteByte(c)
			continue
		}
		if i+1 == len(s) {
			return "", fmt.Errorf("invalid template %q: a lone $ ends it (write $$ for a $)", s)
		}
		next := s[i+1]
		switch {
		case next == '$':
			b.WriteByte('$')
			i++
		case next == '{':
			end := matchingBrace(s, i+1)
			if end < 0 {
				return "", fmt.Errorf("unclosed ${ in %q", s)
			}
			v, err := braced(s[i+2 : end])
			if err != nil {
				return "", err
			}
			b.WriteString(v)
			i = end
		case isNameStart(next):
			j := i + 1
			for j < len(s) && isNameChar(s[j]) {
				j++
			}
			i = j - 1 // unset: empty
		default:
			return "", fmt.Errorf("invalid template %q: $%c (write $$ for a $)", s, next)
		}
	}
	return b.String(), nil
}

func matchingBrace(s string, open int) int {
	depth := 0
	for i := open; i < len(s); i++ {
		switch s[i] {
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				return i
			}
		}
	}
	return -1
}

var bracedName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*`)

// braced is one ${...} reference with every variable unset.
func braced(inner string) (string, error) {
	name := bracedName.FindString(inner)
	if name == "" {
		return "", fmt.Errorf("bad variable reference ${%s}", inner)
	}
	rest := inner[len(name):]
	switch {
	case rest == "":
		return "", nil
	case strings.HasPrefix(rest, ":-"):
		return interpolate(rest[2:])
	case strings.HasPrefix(rest, "-"):
		return interpolate(rest[1:])
	case strings.HasPrefix(rest, ":?"), strings.HasPrefix(rest, "?"):
		return "", fmt.Errorf("required variable %s is not set (the cell interpolates from an empty environment)", name)
	case strings.HasPrefix(rest, ":+"), strings.HasPrefix(rest, "+"):
		return "", nil
	}
	return "", fmt.Errorf("bad variable reference ${%s}", inner)
}

func isNameStart(c byte) bool { return c == '_' || (c|0x20 >= 'a' && c|0x20 <= 'z') }
func isNameChar(c byte) bool  { return isNameStart(c) || (c >= '0' && c <= '9') }

// interpolateTree interpolates every string scalar of a decoded YAML tree
// in place (compose interpolates values, never keys).
func interpolateTree(v any, path string, refuse func(path, reason string)) any {
	switch x := v.(type) {
	case string:
		out, err := interpolate(x)
		if err != nil {
			refuse(path, err.Error())
			return x
		}
		return out
	case map[string]any:
		for k, e := range x {
			x[k] = interpolateTree(e, path+"."+k, refuse)
		}
	case []any:
		for i, e := range x {
			x[i] = interpolateTree(e, fmt.Sprintf("%s[%d]", path, i), refuse)
		}
	}
	return v
}

// kubeLiteral escapes a value Kubernetes would expand: in a container's
// command, args and env values "$(NAME)" names another variable and "$$"
// is "$", so every "$" is doubled and the value reaches the process as
// compose would have handed it.
func kubeLiteral(s string) string { return strings.ReplaceAll(s, "$", "$$") }

// splitShell splits a compose string command the way compose does (shell
// words: blanks separate, quotes group, a backslash escapes), with no
// expansion.
func splitShell(s string) ([]string, error) {
	var out []string
	var cur strings.Builder
	inWord := false
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c == ' ' || c == '\t' || c == '\n':
			if inWord {
				out = append(out, cur.String())
				cur.Reset()
				inWord = false
			}
		case c == '\'':
			j := strings.IndexByte(s[i+1:], '\'')
			if j < 0 {
				return nil, errors.New("unclosed single quote")
			}
			cur.WriteString(s[i+1 : i+1+j])
			i += j + 1
			inWord = true
		case c == '"':
			i++
			for ; i < len(s) && s[i] != '"'; i++ {
				if s[i] == '\\' && i+1 < len(s) && strings.IndexByte("\"\\$`\n", s[i+1]) >= 0 {
					i++
				}
				cur.WriteByte(s[i])
			}
			if i >= len(s) {
				return nil, errors.New("unclosed double quote")
			}
			inWord = true
		case c == '\\' && i+1 < len(s):
			i++
			cur.WriteByte(s[i])
			inWord = true
		default:
			cur.WriteByte(c)
			inWord = true
		}
	}
	if inWord {
		out = append(out, cur.String())
	}
	return out, nil
}

var sizeRE = regexp.MustCompile(`^(?i)([0-9]+(?:\.[0-9]+)?)\s*([kmgt]?)i?b?$`)

// memoryMB reads a compose memory size ("512m", "1g", "1073741824", 1g as
// a number of bytes), in MiB rounded up.
func memoryMB(v any) (int, error) {
	var s string
	switch x := v.(type) {
	case int:
		s = strconv.Itoa(x)
	case float64:
		s = strconv.FormatFloat(x, 'f', -1, 64)
	case string:
		s = strings.TrimSpace(x)
	default:
		return 0, fmt.Errorf("%v is not a size", v)
	}
	m := sizeRE.FindStringSubmatch(s)
	if m == nil {
		return 0, fmt.Errorf("%q is not a size", s)
	}
	n, err := strconv.ParseFloat(m[1], 64)
	if err != nil || n <= 0 {
		return 0, fmt.Errorf("%q is not a size", s)
	}
	mult := map[string]float64{"": 1, "k": 1 << 10, "m": 1 << 20, "g": 1 << 30, "t": 1 << 40}[strings.ToLower(m[2])]
	mb := n * mult / (1 << 20)
	if mb != float64(int(mb)) {
		mb = float64(int(mb) + 1)
	}
	return max(int(mb), 1), nil
}

// milliCPUs reads compose cpus ("0.5", 2, 1.5) in millicores.
func milliCPUs(v any) (int, error) {
	var f float64
	switch x := v.(type) {
	case int:
		f = float64(x)
	case float64:
		f = x
	case string:
		p, err := strconv.ParseFloat(strings.TrimSpace(x), 64)
		if err != nil {
			return 0, fmt.Errorf("%q is not a CPU count", x)
		}
		f = p
	default:
		return 0, fmt.Errorf("%v is not a CPU count", v)
	}
	if f <= 0 {
		return 0, fmt.Errorf("%v is not a CPU count", v)
	}
	return max(int(f*1000), 1), nil
}

// duration reads a compose duration ("30s", "1m30s", "500ms").
func duration(v any) (time.Duration, error) {
	s, ok := v.(string)
	if !ok {
		return 0, fmt.Errorf("%v is not a duration", v)
	}
	d, err := time.ParseDuration(strings.TrimSpace(s))
	if err != nil || d < 0 {
		return 0, fmt.Errorf("%q is not a duration", s)
	}
	return d, nil
}

// seconds is d in whole seconds, at least min.
func seconds(d time.Duration, least int) int {
	s := int((d + time.Second - 1) / time.Second)
	return max(s, least)
}

// parseEnvFile reads a compose env file: KEY=VALUE lines, comments and
// blank lines skipped, an optional "export ", a value in single quotes kept
// as written, one in double quotes with \n, \t, \\ and \" read, and an
// unquoted one up to a " #" comment. Values are interpolated as compose
// does.
func parseEnvFile(b []byte) (map[string]string, error) {
	out := map[string]string{}
	sc := bufio.NewScanner(bytes.NewReader(b))
	sc.Buffer(make([]byte, 0, 64<<10), 1<<20)
	line := 0
	for sc.Scan() {
		line++
		l := strings.TrimSpace(sc.Text())
		if l == "" || strings.HasPrefix(l, "#") {
			continue
		}
		l = strings.TrimPrefix(l, "export ")
		k, v, ok := strings.Cut(l, "=")
		k = strings.TrimSpace(k)
		if !ok || !bracedName.MatchString(k) || bracedName.FindString(k) != k {
			return nil, fmt.Errorf("line %d is not KEY=VALUE", line)
		}
		v = strings.TrimSpace(v)
		switch {
		case len(v) >= 2 && v[0] == '\'' && v[len(v)-1] == '\'':
			v = v[1 : len(v)-1]
		case len(v) >= 2 && v[0] == '"' && v[len(v)-1] == '"':
			v = strings.NewReplacer(`\n`, "\n", `\t`, "\t", `\"`, `"`, `\\`, `\`).Replace(v[1 : len(v)-1])
			iv, err := interpolate(v)
			if err != nil {
				return nil, fmt.Errorf("line %d: %w", line, err)
			}
			v = iv
		default:
			if i := strings.Index(v, " #"); i >= 0 {
				v = strings.TrimSpace(v[:i])
			}
			iv, err := interpolate(v)
			if err != nil {
				return nil, fmt.Errorf("line %d: %w", line, err)
			}
			v = iv
		}
		out[k] = v
	}
	return out, sc.Err()
}

var dnsLabel = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`)

// slug is s as a DNS label part: lowercase letters, digits and '-', at
// most n bytes. A name it had to change or cut ends in a short hash of the
// original, so two compose names never meet in one slug.
func slug(s string, n int) string {
	var b strings.Builder
	for _, r := range strings.ToLower(s) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
		default:
			b.WriteByte('-')
		}
	}
	out := strings.Trim(b.String(), "-")
	if out == s && len(out) <= n && out != "" {
		return out
	}
	sum := sha256.Sum256([]byte(s))
	h := hex.EncodeToString(sum[:])[:6]
	keep := n - len(h) - 1
	if len(out) > keep {
		out = strings.Trim(out[:keep], "-")
	}
	if out == "" {
		return h
	}
	return out + "-" + h
}
