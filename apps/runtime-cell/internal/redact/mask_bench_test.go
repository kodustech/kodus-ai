package redact

import (
	"bytes"
	"fmt"
	"io"
	"math/rand"
	"testing"
)

// streamText is n bytes of source-like text.
func streamText(n int) []byte {
	r := rand.New(rand.NewSource(1))
	const al = "abcdefghijklmnopqrstuvwxyz0123456789 \n{}();=._-/ABCDEFGHIJKLMNOPQRSTUVWXYZ"
	b := make([]byte, n)
	for i := range b {
		b[i] = al[r.Intn(len(al))]
	}
	return b
}

func benchSecrets(n int) []string {
	out := make([]string, n)
	for i := range out {
		out[i] = fmt.Sprintf("sk_live_%032x", i*7919+12345)
	}
	return out
}

// chunked writes in the 32 KiB reads io.Copy makes from a response body.
type chunked struct{ r io.Reader }

func (c chunked) Read(p []byte) (int, error) { return c.r.Read(p) }

// Measured on an Apple M4 (go test -run X -bench . -benchtime 5x), 16 MiB of
// text in 32 KiB writes, before and after the one-pass matcher (G2, G10):
//
//	MaskingWriter,  1 secret:  107 MB/s, 37 MB allocated -> 489 MB/s, 3.5 MB
//	MaskingWriter, 10 secrets:  89 MB/s                  -> 249 MB/s
//	ReaderContains, 1 secret:  372 MB/s                  -> 506 MB/s
//	ReaderContains, 10 secrets: 67 MB/s                  -> 250 MB/s
func BenchmarkMaskingWriter(b *testing.B) {
	for _, n := range []int{1, 10} {
		b.Run(fmt.Sprintf("%d secrets", n), func(b *testing.B) {
			d, s := streamText(16<<20), benchSecrets(n)
			b.SetBytes(int64(len(d)))
			b.ReportAllocs()
			for i := 0; i < b.N; i++ {
				mw := NewMaskingWriter(io.Discard, s, "[masked]")
				_, _ = io.Copy(mw, chunked{bytes.NewReader(d)})
				_ = mw.Close()
			}
		})
	}
}

func BenchmarkReaderContains(b *testing.B) {
	for _, n := range []int{1, 10} {
		b.Run(fmt.Sprintf("%d secrets", n), func(b *testing.B) {
			d, s := streamText(16<<20), benchSecrets(n)
			b.SetBytes(int64(len(d)))
			for i := 0; i < b.N; i++ {
				_, _ = ReaderContains(bytes.NewReader(d), s)
			}
		})
	}
}

// Whatever the chunks, the stream comes out as Mask would print the whole
// text, and ReaderContains sees a secret wherever it sits: three secrets
// (with their other spellings) at random places in random text.
func TestTheStreamMasksAsTheWholeTextWhateverTheChunks(t *testing.T) {
	r := rand.New(rand.NewSource(7))
	secrets := benchSecrets(3)
	for round := 0; round < 200; round++ {
		var text bytes.Buffer
		for k := 0; k < 8; k++ {
			text.Write(streamText(r.Intn(200)))
			if r.Intn(2) == 0 {
				vs := spellings(secrets[r.Intn(len(secrets)):][:1])
				text.WriteString(vs[r.Intn(len(vs))])
			}
		}
		var out bytes.Buffer
		w := NewMaskingWriter(&out, secrets, "***")
		for b := text.Bytes(); len(b) > 0; {
			n := min(len(b), 1+r.Intn(64))
			_, _ = w.Write(b[:n])
			b = b[n:]
		}
		_ = w.Close()
		if want := Mask(text.String(), secrets, "***"); out.String() != want {
			t.Fatalf("round %d: stream %q, whole %q", round, out.String(), want)
		}
		got, err := ReaderContains(bytes.NewReader(text.Bytes()), secrets)
		if want := Contains(text.Bytes(), secrets); err != nil || got != want {
			t.Fatalf("round %d: ReaderContains %v %v, Contains %v", round, got, err, want)
		}
	}
}
