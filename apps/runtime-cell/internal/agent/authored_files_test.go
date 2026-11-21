package agent

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

const dockerfile = "FROM node:22-bookworm-slim\nWORKDIR /app\nCOPY . .\nCMD [\"npm\", \"start\"]\n"

func authoredRecipe(files ...protocol.AuthoredFile) *protocol.ClaimAcquireBodyRecipe {
	return &protocol.ClaimAcquireBodyRecipe{Path: ".kodus/workspace.yaml", Content: []byte(`"version: 1\n"`), Files: files}
}

func kody(path, content string) protocol.AuthoredFile {
	return protocol.AuthoredFile{Path: path, Content: content}
}

// repoServerWith serves a tarball of the given entries under one top directory.
func repoServerWith(t *testing.T, entries func(tw *tar.Writer)) string {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	_ = tw.WriteHeader(&tar.Header{Name: "o-r-0123/README.md", Typeflag: tar.TypeReg, Mode: 0o644, Size: 5})
	_, _ = tw.Write([]byte("hello"))
	entries(tw)
	_ = tw.Close()
	_ = gz.Close()
	body := buf.Bytes()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(body) }))
	t.Cleanup(srv.Close)
	return srv.URL
}

// End to end on the agent: a PR checkout with its own .kodus/Dockerfile.kody,
// or a .kodus link, fails the claim with the authored_files blocker before
// anything boots; a clean checkout boots with the files.
func TestClaimWithAuthoredFilesInAPlantedCheckout(t *testing.T) {
	for _, tc := range []struct {
		name    string
		entries func(tw *tar.Writer)
		reason  string
	}{
		{"existing file", func(tw *tar.Writer) {
			_ = tw.WriteHeader(&tar.Header{Name: "o-r-0123/.kodus/", Typeflag: tar.TypeDir, Mode: 0o755})
			_ = tw.WriteHeader(&tar.Header{Name: "o-r-0123/.kodus/Dockerfile.kody", Typeflag: tar.TypeReg, Mode: 0o644, Size: 4})
			_, _ = tw.Write([]byte("FROM"))
		}, ".kodus/Dockerfile.kody: is already in the checkout"},
		{"kodus link", func(tw *tar.Writer) {
			_ = tw.WriteHeader(&tar.Header{Name: "o-r-0123/src/", Typeflag: tar.TypeDir, Mode: 0o755})
			_ = tw.WriteHeader(&tar.Header{Name: "o-r-0123/.kodus", Typeflag: tar.TypeSymlink, Linkname: "src"})
		}, ".kodus: is a symbolic link"},
	} {
		srv := repoServerWith(t, tc.entries)
		h := newHarness(t, func(c *Config) {
			c.Repo = func(protocol.ClaimAcquireBody) (string, error) { return srv + "/tarball", nil }
		})
		body := h.acquireBody()
		body.Side = protocol.SidePr
		body.Recipe = authoredRecipe(kody(".kodus/Dockerfile.kody", dockerfile))
		if err := h.handle("claim-"+strings.ReplaceAll(tc.name, " ", "-"), protocol.MessageTypeClaimAcquire, body); err != nil {
			t.Fatal(err)
		}
		f := h.conn.next(t, isFailed).(*protocol.ClaimFailedBody)
		if f.Kind != protocol.BlockerKindToolchain || f.Signature != "authored_files" || !strings.Contains(f.Reason, tc.reason) {
			t.Fatalf("%s: %+v", tc.name, f)
		}
	}
	h := newHarness(t)
	h.ready("claim-clean", func(b *protocol.ClaimAcquireBody) {
		b.Recipe = authoredRecipe(kody(".kodus/Dockerfile.kody", dockerfile))
	})
}
