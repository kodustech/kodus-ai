package dockercli

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestBuildkitdMirrorConfig(t *testing.T) {
	conf, err := buildkitdMirrorConfig("mirror.cell.internal:8080")
	if err != nil {
		t.Fatal(err)
	}
	want := "[registry.\"docker.io\"]\n  mirrors = [\"mirror.cell.internal:8080\"]\n\n[registry.\"mirror.cell.internal:8080\"]\n  http = true\n"
	if string(conf) != want {
		t.Fatalf("config:\n%s\nwant:\n%s", conf, want)
	}
	for _, bad := range []string{"", "mirror", "http://mirror:8080", "m:8080\"]\n[x]", "a b:1"} {
		if _, err := buildkitdMirrorConfig(bad); err == nil || !strings.Contains(err.Error(), "host:port") {
			t.Errorf("%q accepted", bad)
		}
	}
}

// A persisted state is mounted at the rootless daemon's root and bounded by
// BuildKit's own GC; a bad bound never reaches the config.
func TestRunBuildMountsThePersistedState(t *testing.T) {
	var got []string
	c := CLI{Run: func(_ context.Context, _ []byte, _ string, args ...string) ([]byte, error) {
		got = args
		return nil, nil
	}}
	out := t.TempDir()
	b := BuildRun{Image: "buildkit", Runtime: "runsc", Network: "n", Address: "10.0.0.9", Resolv: "/r", Context: "/c", Dockerfile: "Dockerfile",
		Tag: "t:claim", Out: out, StateDir: "/state/env-1", GCKeepStorage: "20GB"}
	if err := c.RunBuild(context.Background(), b); err != nil {
		t.Fatal(err)
	}
	if j := strings.Join(got, " "); !strings.Contains(j, "-v /state/env-1:"+BuildkitStateRoot) || !strings.Contains(j, "--config /out/"+BuildkitdConfig) {
		t.Fatalf("args: %s", j)
	}
	conf, err := os.ReadFile(filepath.Join(out, BuildkitdConfig))
	if err != nil || !strings.Contains(string(conf), "[worker.oci]\n  gc = true\n  gckeepstorage = \"20GB\"") {
		t.Fatalf("config %q %v", conf, err)
	}
	b.GCKeepStorage = "20GB\"\n[x]"
	if err := c.RunBuild(context.Background(), b); err == nil {
		t.Fatal("a bad keep storage reached the config")
	}
}

// The build's progress is BuildKit's plain one, whatever buildctl would
// pick without a TTY: build.steps reads its "#N ... DONE 1.2s" lines.
func TestRunBuildAsksForPlainProgress(t *testing.T) {
	var got []string
	c := CLI{Run: func(_ context.Context, _ []byte, _ string, args ...string) ([]byte, error) {
		got = args
		return nil, nil
	}}
	b := BuildRun{Image: "buildkit", Runtime: "runsc", Network: "n", Address: "10.0.0.9", Resolv: "/r", Context: "/c", Dockerfile: "Dockerfile", Tag: "t", Out: t.TempDir()}
	if err := c.RunBuild(context.Background(), b); err != nil {
		t.Fatal(err)
	}
	if j := strings.Join(got, " "); !strings.Contains(j, "buildkit build --progress plain --frontend dockerfile.v0") {
		t.Fatalf("args: %s", j)
	}
}
