package redact

import (
	"encoding/base64"
	"errors"
	"io"
	"strings"
	"testing"
	"testing/iotest"
)

// A stream carries a secret wherever it is: across the boundary of two
// reads, in another spelling (base64), and not at all when only a value
// shorter than MinKnownLen appears. A read error is the caller's, never "clean".
func TestReaderContainsFindsASecretAcrossReadsAndSpellings(t *testing.T) {
	const secret = "s3cr3t-db-password-0123"
	filler := strings.Repeat("x", 3*readerChunk-7)
	for name, c := range map[string]struct {
		text string
		want bool
	}{
		"at a chunk boundary": {filler + secret + filler, true},
		"in base64":           {filler + base64.StdEncoding.EncodeToString([]byte(secret)) + filler, true},
		"absent":              {filler + "s3cr3t-db" + filler, false},
	} {
		t.Run(name, func(t *testing.T) {
			got, err := ReaderContains(iotest.HalfReader(strings.NewReader(c.text)), []string{secret, "ab"})
			if err != nil || got != c.want {
				t.Fatalf("found %v, err %v", got, err)
			}
		})
	}
	if got, _ := ReaderContains(strings.NewReader("ab ab ab"), []string{"ab"}); got {
		t.Fatal("a value shorter than MinKnownLen matched")
	}
	boom := errors.New("disk")
	if _, err := ReaderContains(io.MultiReader(strings.NewReader("clean"), iotest.ErrReader(boom)), []string{secret}); !errors.Is(err, boom) {
		t.Fatalf("a read error read as clean: %v", err)
	}
}
