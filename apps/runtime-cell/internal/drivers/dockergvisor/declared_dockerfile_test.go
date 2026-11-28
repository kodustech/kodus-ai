package dockergvisor

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose/sandbox"
)

// The build reads a copy of the context's Dockerfile with the mirror's args declared; the checkout stays as it is, the
// project's own args are not redeclared, and a Dockerfile outside the context is never read.
func TestTheBuildReadsTheDockerfileWithTheMirrorsArgsDeclared(t *testing.T) {
	ctx := t.TempDir()
	if err := os.MkdirAll(filepath.Join(ctx, "docker"), 0o755); err != nil {
		t.Fatal(err)
	}
	orig := "FROM node:22\nRUN npm ci && npx prisma generate\n"
	if err := os.WriteFile(filepath.Join(ctx, "docker", "api.Dockerfile"), []byte(orig), 0o644); err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(t.TempDir(), "api")
	b := sandbox.Build{Service: "api", Context: ctx, Dockerfile: "docker/api.Dockerfile", Args: map[string]string{"NODE_ENV": "test"}}
	dir, err := declaredDockerfile(b, map[string]string{"NODE_ENV": "test", "PRISMA_ENGINES_MIRROR": "http://m/artifacts/prisma"}, out)
	if err != nil || dir != out+dockerfileSuffix {
		t.Fatalf("dir %q err %v", dir, err)
	}
	got, _ := os.ReadFile(filepath.Join(dir, "api.Dockerfile"))
	if !strings.Contains(string(got), "FROM node:22\nARG PRISMA_ENGINES_MIRROR\n") || strings.Contains(string(got), "ARG NODE_ENV") {
		t.Fatalf("%s", got)
	}
	if still, _ := os.ReadFile(filepath.Join(ctx, "docker", "api.Dockerfile")); string(still) != orig {
		t.Fatal("the checkout's Dockerfile changed")
	}
	if dir, _ := declaredDockerfile(sandbox.Build{Service: "x", Context: ctx, Dockerfile: "../etc/Dockerfile"}, map[string]string{"CI": "true"}, out); dir != "" {
		t.Fatal("a Dockerfile outside the context was read")
	}
}
