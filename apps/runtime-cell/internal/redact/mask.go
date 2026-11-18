package redact

import (
	"bytes"
	"errors"
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

// matcher finds spellings in bytes in one pass: a table of the bytes a
// spelling starts with, so a byte that starts none costs one lookup, and
// the spellings by first byte, longest first.
type matcher struct {
	first   [256]bool
	byFirst [256][][]byte
	longest int
	// firsts is the distinct first bytes; with few, the scan jumps between
	// them with bytes.IndexByte instead of looking at every byte.
	firsts []byte
}

func newMatcher(vs []string) *matcher { // vs longest first
	m := &matcher{}
	for _, v := range vs {
		if !m.first[v[0]] {
			m.firsts = append(m.firsts, v[0])
		}
		m.first[v[0]] = true
		m.byFirst[v[0]] = append(m.byFirst[v[0]], []byte(v))
		m.longest = max(m.longest, len(v))
	}
	return m
}

// next is the first index in p[from:to] where a spelling may start, or to.
func (m *matcher) next(p []byte, from, to int) int {
	if len(m.firsts) <= 2 {
		best := to
		for _, c := range m.firsts {
			if j := bytes.IndexByte(p[from:best], c); j >= 0 {
				best = from + j
			}
		}
		return best
	}
	for i := from; i < to; i++ {
		if m.first[p[i]] {
			return i
		}
	}
	return to
}

// at is the length of the longest spelling p[i:] starts with, or 0.
func (m *matcher) at(p []byte, i int) int {
	for _, v := range m.byFirst[p[i]] {
		if bytes.HasPrefix(p[i:], v) {
			return len(v)
		}
	}
	return 0
}

// MaskingWriter masks secrets in a stream it passes on to w without holding
// the whole stream: it keeps back only the last (longest spelling - 1)
// bytes, the most a spelling cut by a chunk boundary can have shown. At each
// position the longest spelling that starts there is replaced, so every
// occurrence is either replaced or inside a replaced one. The bytes between
// spellings go out in runs, through one buffer reused across writes (G2).
type MaskingWriter struct {
	w       io.Writer
	repl    []byte
	m       *matcher
	pending []byte
	out     []byte
}

func NewMaskingWriter(w io.Writer, secrets []string, repl string) *MaskingWriter {
	return &MaskingWriter{w: w, repl: []byte(repl), m: newMatcher(spellings(secrets))}
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
	// With nothing to mask (longest == 0) nothing is kept back; otherwise
	// keep back the most a spelling cut by a chunk boundary can have shown.
	if !final && m.m.longest > 0 {
		cut = len(m.pending) - (m.m.longest - 1)
	}
	if cut <= 0 {
		return nil
	}
	out := m.out[:0]
	i, run := 0, 0
	for i < cut {
		if m.m.longest == 0 {
			i = cut
			break
		}
		i = m.m.next(m.pending, i, cut)
		if i >= cut {
			break
		}
		if n := m.m.at(m.pending, i); n > 0 {
			out = append(out, m.pending[run:i]...)
			out = append(out, m.repl...)
			i += n
			run = i
			continue
		}
		i++
	}
	i = max(i, cut)
	out = append(out, m.pending[run:i]...)
	m.pending = append(m.pending[:0], m.pending[i:]...)
	m.out = out
	_, err := m.w.Write(out)
	return err
}

// readerChunk is how much ReaderContains reads at a time.
const readerChunk = 1 << 20

// ReaderContains reports whether r carries any spelling of any secret (each
// at least MinKnownLen long), reading it once and holding at most a chunk
// and the longest spelling's length: a layer of an image is gigabytes. A read
// error is returned, never taken for a clean stream.
func ReaderContains(r io.Reader, secrets []string) (bool, error) {
	vs := spellings(secrets)
	if len(vs) == 0 {
		_, err := io.Copy(io.Discard, r)
		return false, err
	}
	m := newMatcher(vs)
	keep := m.longest - 1
	buf := make([]byte, 0, readerChunk+keep)
	chunk := make([]byte, readerChunk)
	for {
		n, err := r.Read(chunk)
		buf = append(buf, chunk[:n]...)
		for i := m.next(buf, 0, len(buf)); i < len(buf); i = m.next(buf, i+1, len(buf)) {
			if m.at(buf, i) > 0 {
				return true, nil
			}
		}
		if errors.Is(err, io.EOF) {
			return false, nil
		}
		if err != nil {
			return false, err
		}
		if len(buf) > keep {
			buf = append(buf[:0], buf[len(buf)-keep:]...)
		}
	}
}
