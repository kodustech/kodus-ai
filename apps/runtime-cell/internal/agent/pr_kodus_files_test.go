package agent

import (
	"archive/tar"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// dirComposer is a ComposeBooter that keeps the compose file it was handed
// and, read at Up time from the project directory the driver builds in,
// the Dockerfile that file names.
type dirComposer struct {
	mu         sync.Mutex
	file       []byte
	dockerfile string
}

func (c *dirComposer) Up(_ context.Context, _ driver.MachineRef, file []byte, dir string) ([]string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.file = file
	b, _ := os.ReadFile(filepath.Join(dir, ".kodus/Dockerfile.backend"))
	c.dockerfile = string(b)
	return []string{"172.30.0.2"}, nil
}

// kr-grafana: the default branch commits .kodus/workspace.yaml, which names
// .kodus/compose.yaml, which builds .kodus/Dockerfile.backend. The PR side
// boots with the claim's (the setup's) workspace.yaml, but with the PR's
// own compose and Dockerfile: applyRecipe replaces only the workspace file,
// and the setup recorded no authored files (the repository has its recipe).
// So a PR that edits .kodus/compose.yaml or a Dockerfile there is booted
// and built with its edit; only the workspace file is the base's.
func TestThePRSideBootsThePRsComposeAndDockerfileUnderKodus(t *testing.T) {
	const prWorkspace = "version: 1\nservices: { compose: { files: [.kodus/other.yaml], public: api } }\n"
	const prCompose = "services:\n  api:\n    build: { context: ., dockerfile: .kodus/Dockerfile.backend }\n    environment: { GF_LOG_LEVEL: debug }\n"
	const prDockerfile = "FROM alpine:3.20 # the PR's\n"
	file := func(tw *tar.Writer, name, content string) {
		_ = tw.WriteHeader(&tar.Header{Name: "o-r-0123/" + name, Typeflag: tar.TypeReg, Mode: 0o644, Size: int64(len(content))})
		_, _ = tw.Write([]byte(content))
	}
	srv := repoServerWith(t, func(tw *tar.Writer) {
		_ = tw.WriteHeader(&tar.Header{Name: "o-r-0123/.kodus/", Typeflag: tar.TypeDir, Mode: 0o755})
		file(tw, ".kodus/workspace.yaml", prWorkspace)
		file(tw, ".kodus/compose.yaml", prCompose)
		file(tw, ".kodus/Dockerfile.backend", prDockerfile)
	})
	cp := &dirComposer{}
	h := newHarness(t, func(c *Config) {
		c.Composer = cp
		c.Repo = func(protocol.ClaimAcquireBody) (string, error) { return srv + "/tarball", nil }
	})
	// The base's workspace file, as the setup recorded it from the default branch.
	baseWorkspace, _ := json.Marshal("version: 1\nservices: { compose: { files: [.kodus/compose.yaml], public: api } }\n")
	h.ready("claim-pr", func(b *protocol.ClaimAcquireBody) {
		b.Side = protocol.SidePr
		b.Expose = []protocol.Expose{{Service: "api", Port: 3000, Kind: protocol.ExposeKindHTTP}}
		b.Recipe = &protocol.ClaimAcquireBodyRecipe{Path: ".kodus/workspace.yaml", Content: baseWorkspace}
	})
	cp.mu.Lock()
	defer cp.mu.Unlock()
	// The workspace is the base's: it named .kodus/compose.yaml, not the PR's .kodus/other.yaml (which would fail to load).
	if !strings.Contains(string(cp.file), "GF_LOG_LEVEL: debug") {
		t.Fatalf("the PR side did not boot the PR's .kodus/compose.yaml: %s", cp.file)
	}
	if cp.dockerfile != prDockerfile {
		t.Fatalf("the PR side builds with %q, not the PR's .kodus/Dockerfile.backend", cp.dockerfile)
	}
}
