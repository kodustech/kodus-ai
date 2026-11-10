package redact

import (
	"bytes"
	"io"
	"sort"
	"strings"
)

// spellings is every variant of every secret at least MinKnownLen long,
// longest first, without repeats.
func spellings(secrets []string) []string {
	set := map[string]bool{}
	for _, s := range secrets {
		if len(s) < MinKnownLen {
			continue
		}
		for _, v := range Variants(s) {
			set[v] = true
		}
	}
	out := make([]string, 0, len(set))
	for v := range set {
		out = append(out, v)
	}
	sort.Slice(out, func(i, j int) bool {
		if len(out[i]) != len(out[j]) {
			return len(out[i]) > len(out[j])
		}
		return out[i] < out[j]
	})
	return out
}

// Mask replaces every spelling of every secret with repl, longest first.
func Mask(text string, secrets []string, repl string) string {
	if text == "" {
		return text
	}
	for _, v := range spellings(secrets) {
		text = strings.ReplaceAll(text, v, repl)
	}
	return text
}

// Contains reports whether data carries any spelling of any secret.
func Contains(data []byte, secrets []string) bool {
	for _, v := range spellings(secrets) {
		if bytes.Contains(data, []byte(v)) {
			return true
		}
	}
	return false
}

// MaskingWriter masks secrets in a stream it passes on to w without holding
// the whole stream: it keeps back only the last (longest spelling - 1)
// bytes, the most a spelling cut by a chunk boundary can have shown. At each
// position the longest spelling that starts there is replaced, so every
// occurrence is either replaced or inside a replaced one.
type MaskingWriter struct {
	w       io.Writer
	repl    []byte
	byFirst map[byte][][]byte
	longest int
	pending []byte
}

func NewMaskingWriter(w io.Writer, secrets []string, repl string) *MaskingWriter {
	m := &MaskingWriter{w: w, repl: []byte(repl), byFirst: map[byte][][]byte{}}
	for _, v := range spellings(secrets) { // longest first
		m.byFirst[v[0]] = append(m.byFirst[v[0]], []byte(v))
		m.longest = max(m.longest, len(v))
	}
	return m
}

func (m *MaskingWriter) Write(p []byte) (int, error) {
	m.pending = append(m.pending, p...)
	if err := m.flush(false); err != nil {
		return 0, err
	}
	return len(p), nil
}

// Close masks and writes what it kept back.
func (m *MaskingWriter) Close() error { return m.flush(true) }

func (m *MaskingWriter) flush(final bool) error {
	cut := len(m.pending)
	if !final {
		cut = len(m.pending) - (m.longest - 1)
	}
	if cut <= 0 {
		return nil
	}
	var out bytes.Buffer
	i := 0
	for i < cut {
		matched := 0
		for _, v := range m.byFirst[m.pending[i]] {
			if bytes.HasPrefix(m.pending[i:], v) {
				matched = len(v)
				break
			}
		}
		if matched > 0 {
			out.Write(m.repl)
			i += matched
			continue
		}
		out.WriteByte(m.pending[i])
		i++
	}
	m.pending = append(m.pending[:0], m.pending[i:]...)
	_, err := m.w.Write(out.Bytes())
	return err
}
