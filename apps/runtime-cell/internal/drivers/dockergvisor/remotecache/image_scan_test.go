package remotecache

import (
	"bytes"
	"compress/gzip"
	"errors"
	"io"
	"strings"
	"testing"
)

func gzipped(t *testing.T, s string) string {
	t.Helper()
	var b bytes.Buffer
	w := gzip.NewWriter(&b)
	_, _ = w.Write([]byte(s))
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return b.String()
}

// carries is the redactor's check, here a plain substring.
func carries(secret string) func(io.Reader) (bool, error) {
	return func(r io.Reader) (bool, error) {
		b, err := io.ReadAll(r)
		return strings.Contains(string(b), secret), err
	}
}

// Before a baked image leaves the cell every blob it pushes is read for the
// claim's secret values: a layer that holds one, plain or gzip, refuses the
// push; a layer the cell cannot read (zstd, which it cannot decompress) is
// refused too, since nothing proves it clean; a clean image passes.
func TestASavedImageCarryingASecretIsRefusedBeforePush(t *testing.T) {
	const secret = "db-password-0123"
	for name, c := range map[string]struct {
		layers []string
		want   error
	}{
		"clean":            {[]string{"layer one", gzipped(t, "layer two")}, nil},
		"plain layer":      {[]string{"layer one", "ENV=" + secret}, ErrSecretInImage},
		"gzip layer":       {[]string{gzipped(t, "x "+secret+" y")}, ErrSecretInImage},
		"zstd layer":       {[]string{"\x28\xb5\x2f\xfd unreadable"}, ErrUnscannedLayer},
		"secret in a name": {[]string{"etc/" + secret + "/conf"}, ErrSecretInImage},
	} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			writeSaved(t, dir, c.layers...)
			err := CheckImageSecrets(dir, carries(secret))
			if c.want == nil && err != nil || c.want != nil && !errors.Is(err, c.want) {
				t.Fatalf("got %v, want %v", err, c.want)
			}
		})
	}
	dir := t.TempDir()
	writeSaved(t, dir, "layer")
	boom := errors.New("read")
	if err := CheckImageSecrets(dir, func(io.Reader) (bool, error) { return false, boom }); !errors.Is(err, boom) {
		t.Fatalf("a failed read passed: %v", err)
	}
}
