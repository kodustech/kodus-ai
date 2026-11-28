package toollayer

import (
	"archive/tar"
	"bytes"
	"testing"
)

func buildTinyTar(t *testing.T) []byte {
	t.Helper()
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	add := func(h *tar.Header, body string) {
		h.Format = tar.FormatPAX
		h.Size = int64(len(body))
		if err := tw.WriteHeader(h); err != nil {
			t.Fatal(err)
		}
		if body != "" {
			if _, err := tw.Write([]byte(body)); err != nil {
				t.Fatal(err)
			}
		}
	}
	add(&tar.Header{Name: "node_modules/", Typeflag: tar.TypeDir, Mode: 0o755}, "")
	add(&tar.Header{Name: "node_modules/foo/", Typeflag: tar.TypeDir, Mode: 0o755}, "")
	add(&tar.Header{Name: "node_modules/foo/package.json", Typeflag: tar.TypeReg, Mode: 0o644}, "{\"name\":\"foo\"}")
	add(&tar.Header{Name: "node_modules/foo/cli.js", Typeflag: tar.TypeReg, Mode: 0o755}, "#!/usr/bin/env node\nconsole.log(1)\n")
	add(&tar.Header{Name: "node_modules/.bin/", Typeflag: tar.TypeDir, Mode: 0o755}, "")
	add(&tar.Header{Name: "node_modules/.bin/foo", Typeflag: tar.TypeSymlink, Linkname: "../foo/cli.js", Mode: 0o777}, "")
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}
