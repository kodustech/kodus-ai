package dockergvisor

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose/sandbox"
)

func writeFile(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func project(t *testing.T) string {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "Dockerfile"), "FROM alpine:3.20\nCOPY . /app\n")
	writeFile(t, filepath.Join(dir, "src", "main.go"), "package main\n")
	return dir
}

func fp(t *testing.T, b sandbox.Build) string {
	t.Helper()
	f, err := fingerprint(b, "buildkit@sha256:abc")
	if err != nil {
		t.Fatal(err)
	}
	return f
}

// The same input is the same fingerprint; any change to what the build
// reads or how it is asked is another.
func TestFingerprintFollowsEveryInputOfTheBuild(t *testing.T) {
	dir := project(t)
	base := sandbox.Build{Service: "api", Context: dir, Dockerfile: "Dockerfile", Args: map[string]string{"A": "1", "B": "2"}}
	want := fp(t, base)
	if again := fp(t, sandbox.Build{Service: "web", Context: dir, Dockerfile: "Dockerfile", Args: map[string]string{"B": "2", "A": "1"}}); again != want {
		t.Fatal("same input, another fingerprint (service name or arg order changed it)")
	}
	changed := map[string]func(){
		"a file's content": func() { writeFile(t, filepath.Join(dir, "src", "main.go"), "package main // pr\n") },
		"a new file":       func() { writeFile(t, filepath.Join(dir, "src", "extra.go"), "x") },
		"a file's mode":    func() { _ = os.Chmod(filepath.Join(dir, "src", "main.go"), 0o755) },
	}
	for name, change := range changed {
		dir = project(t)
		base.Context = dir
		before := fp(t, base)
		change()
		if fp(t, base) == before {
			t.Errorf("%s did not change the fingerprint", name)
		}
	}
	for name, b := range map[string]sandbox.Build{
		"target":     {Context: dir, Dockerfile: "Dockerfile", Target: "prod"},
		"dockerfile": {Context: dir, Dockerfile: "other.Dockerfile"},
		"an arg":     {Context: dir, Dockerfile: "Dockerfile", Args: map[string]string{"A": "2"}},
	} {
		if fp(t, b) == fp(t, sandbox.Build{Context: dir, Dockerfile: "Dockerfile"}) {
			t.Errorf("%s did not change the fingerprint", name)
		}
	}
	other, _ := fingerprint(sandbox.Build{Context: dir, Dockerfile: "Dockerfile"}, "buildkit@sha256:def")
	if other == fp(t, sandbox.Build{Context: dir, Dockerfile: "Dockerfile"}) {
		t.Error("another builder image did not change the fingerprint")
	}
}

// The context is the PR's: a symlink is its target string, never what it
// points at, and a FIFO is never opened.
func TestFingerprintNeverFollowsOrBlocks(t *testing.T) {
	dir := project(t)
	outside := filepath.Join(t.TempDir(), "secret")
	writeFile(t, outside, "one")
	if err := os.Symlink(outside, filepath.Join(dir, "link")); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Mkfifo(filepath.Join(dir, "pipe"), 0o644); err != nil {
		t.Fatal(err)
	}
	b := sandbox.Build{Context: dir, Dockerfile: "Dockerfile"}
	done := make(chan string, 1)
	go func() { done <- fp(t, b) }()
	var before string
	select {
	case before = <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("fingerprint blocked on a FIFO")
	}
	writeFile(t, outside, "two")
	if fp(t, b) != before {
		t.Fatal("the fingerprint read through a symlink")
	}
}

func TestAnUnreadableContextHasNoFingerprint(t *testing.T) {
	if _, err := fingerprint(sandbox.Build{Context: filepath.Join(t.TempDir(), "missing")}, ""); err == nil {
		t.Fatal("a missing context got a fingerprint")
	}
}
