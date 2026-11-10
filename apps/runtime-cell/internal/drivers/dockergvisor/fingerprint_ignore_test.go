package dockergvisor

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose/sandbox"
)

// ignoreCase is a project, a change to it, and whether the change may
// reach the build (so must move the fingerprint).
type ignoreCase struct {
	name    string
	files   map[string]string // relative path: content, over project()'s
	setup   func(t *testing.T, dir string)
	build   sandbox.Build // Context is filled in
	change  func(t *testing.T, dir string)
	reaches bool
}

func (c ignoreCase) run(t *testing.T) {
	t.Helper()
	dir := project(t)
	for rel, body := range c.files {
		writeFile(t, filepath.Join(dir, rel), body)
	}
	if c.setup != nil {
		c.setup(t, dir)
	}
	b := c.build
	if b.Dockerfile == "" {
		b.Dockerfile = "Dockerfile"
	}
	b.Context = dir
	before := fp(t, b)
	c.change(t, dir)
	if moved := fp(t, b) != before; moved != c.reaches {
		if c.reaches {
			t.Errorf("%s: a change the build is sent kept the fingerprint (a stale image)", c.name)
		} else {
			t.Errorf("%s: a change the build is never sent moved the fingerprint", c.name)
		}
	}
}

func edit(rel, body string) func(*testing.T, string) {
	return func(t *testing.T, dir string) { writeFile(t, filepath.Join(dir, rel), body) }
}

func chmod(rel string, mode os.FileMode) func(*testing.T, string) {
	return func(t *testing.T, dir string) {
		if err := os.Chmod(filepath.Join(dir, rel), mode); err != nil {
			t.Fatal(err)
		}
	}
}

func symlink(target, rel string) func(*testing.T, string) {
	return func(t *testing.T, dir string) {
		if err := os.Symlink(target, filepath.Join(dir, rel)); err != nil {
			t.Fatal(err)
		}
	}
}

func TestFingerprintLeavesOutWhatTheIgnoreFileLeavesOut(t *testing.T) {
	ignore := map[string]string{
		".dockerignore": "# docs are not built\nREADME.md\ndocs\n**/*_test.go\n",
		"README.md":     "v1", "docs/guide.md": "v1", "src/main_test.go": "v1",
	}
	for _, c := range []ignoreCase{
		{name: "an ignored file's content", files: ignore, change: edit("README.md", "v2")},
		{name: "a file in an ignored directory", files: ignore, change: edit("docs/new/page.md", "x")},
		{name: "an ignored directory's mode", files: ignore, change: chmod("docs", 0o700)},
		{name: "an ignored test file", files: ignore, change: edit("src/main_test.go", "v2")},
		{name: "a source file", files: ignore, change: edit("src/main.go", "package main // pr\n"), reaches: true},
		{name: "a new source file", files: ignore, change: edit("src/README.txt", "x"), reaches: true},
		{name: "the ignore file itself", files: ignore, change: edit(".dockerignore", "README.md\n"), reaches: true},
		{name: "the Dockerfile", files: ignore, change: edit("Dockerfile", "FROM alpine:3.21\n"), reaches: true},
	} {
		c.run(t)
	}
}

// The Dockerfile and the ignore file decide the build even when the
// ignore file leaves them out.
func TestFingerprintAlwaysCoversTheDefinition(t *testing.T) {
	self := map[string]string{".dockerignore": "Dockerfile\n.dockerignore\n"}
	for _, c := range []ignoreCase{
		{name: "an ignored Dockerfile", files: self, change: edit("Dockerfile", "FROM alpine:3.21\n"), reaches: true},
		{name: "an ignore file that ignores itself", files: self, change: edit(".dockerignore", "Dockerfile\n.dockerignore\nsrc\n"), reaches: true},
	} {
		c.run(t)
	}
}

func TestFingerprintHonorsExceptions(t *testing.T) {
	keep := map[string]string{".dockerignore": "docs\n!docs/keep.txt\n", "docs/keep.txt": "v1", "docs/drop.txt": "v1"}
	for _, c := range []ignoreCase{
		{name: "a file put back by an exception", files: keep, change: edit("docs/keep.txt", "v2"), reaches: true},
		{name: "a file still left out", files: keep, change: edit("docs/drop.txt", "v2")},
		{name: "a left-out directory with nothing put back below", files: keep, change: edit("docs/sub/x.txt", "x")},
		// BuildKit sends a left-out directory along with what is put back below it.
		{name: "the mode of a directory above a put-back file", files: keep, change: chmod("docs", 0o700), reaches: true},
		{name: "a glob exception", files: map[string]string{".dockerignore": "*.md\n!README*.md\n", "README-x.md": "v1"}, change: edit("README-x.md", "v2"), reaches: true},
	} {
		c.run(t)
	}
}

func TestFingerprintPrefersTheDockerfileSpecificIgnoreFile(t *testing.T) {
	files := map[string]string{
		"build/api.Dockerfile":              "FROM alpine:3.20\n",
		"build/api.Dockerfile.dockerignore": "notes.txt\n",
		".dockerignore":                     "src\n",
		"notes.txt":                         "v1",
	}
	api := sandbox.Build{Dockerfile: "build/api.Dockerfile"}
	for _, c := range []ignoreCase{
		{name: "a file the specific file ignores", files: files, build: api, change: edit("notes.txt", "v2")},
		{name: "a file only the context's .dockerignore ignores", files: files, build: api, change: edit("src/main.go", "package main // pr\n"), reaches: true},
		{name: "the specific ignore file", files: files, build: api, change: edit("build/api.Dockerfile.dockerignore", "x\n"), reaches: true},
		// Another Dockerfile of the same context reads the context's file.
		{name: "the root ignore file for the default Dockerfile", files: files, change: edit("src/main.go", "package main // pr\n")},
	} {
		c.run(t)
	}
}

// When the cell cannot be sure what BuildKit leaves out, it leaves out
// nothing: a change to any entry moves the fingerprint.
func TestFingerprintLeavesOutNothingWhenUnsure(t *testing.T) {
	with := func(extra map[string]string) map[string]string {
		m := map[string]string{"docs/guide.md": "v1"}
		for k, v := range extra {
			m[k] = v
		}
		return m
	}
	ignoreDocs := map[string]string{".dockerignore": "docs\n"}
	change := edit("docs/guide.md", "v2")
	for _, c := range []ignoreCase{
		{name: "a malformed pattern", files: with(map[string]string{".dockerignore": "docs\n[\n"})},
		{name: "a lone exception mark", files: with(map[string]string{".dockerignore": "docs\n!\n"})},
		{name: "a pinned frontend", files: with(map[string]string{".dockerignore": "docs\n", "Dockerfile": "# syntax=docker/dockerfile:1.2\nFROM alpine\n"})},
		{name: "a third-party frontend", files: with(map[string]string{".dockerignore": "docs\n", "Dockerfile": "#Syntax = example.com/frontend\nFROM alpine\n"})},
		{name: "a frontend after a blank line", files: with(map[string]string{".dockerignore": "docs\n", "Dockerfile": "# check=error=true\n\n// syntax=example.com/frontend\nFROM alpine\n"})},
		{name: "a JSON directive header", files: with(map[string]string{".dockerignore": "docs\n", "Dockerfile": "{\"syntax\": \"x\"}\nFROM alpine\n"})},
		{name: "a frontend set by build arg", files: with(ignoreDocs), build: sandbox.Build{Args: map[string]string{"BUILDKIT_SYNTAX": "docker/dockerfile:1"}}},
		{name: "a linked ignore file", files: with(map[string]string{"ignore.txt": "docs\n"}), setup: symlink("ignore.txt", ".dockerignore")},
		{name: "a FIFO ignore file", files: with(nil), setup: func(t *testing.T, dir string) {
			if err := syscall.Mkfifo(filepath.Join(dir, ".dockerignore"), 0o644); err != nil {
				t.Fatal(err)
			}
		}},
		// BuildKit reads a linked Dockerfile through the link; the file it
		// reads must not sit in a left-out part of the context unseen.
		{name: "a linked Dockerfile", files: with(map[string]string{".dockerignore": "docs\n", "docs/real.Dockerfile": "FROM alpine\n"}), build: sandbox.Build{Dockerfile: "app.Dockerfile"},
			setup: symlink("docs/real.Dockerfile", "app.Dockerfile"), change: edit("docs/real.Dockerfile", "FROM alpine:3.21\n")},
		{name: "a Dockerfile under a linked directory", files: with(map[string]string{".dockerignore": "docs\n", "docs/Dockerfile": "FROM alpine\n"}), build: sandbox.Build{Dockerfile: "linked/Dockerfile"},
			setup: symlink("docs", "linked"), change: edit("docs/Dockerfile", "FROM alpine:3.21\n")},
	} {
		if c.change == nil {
			c.change = change
		}
		c.reaches = true
		c.run(t)
	}
	// The official frontend at a floating tag reads ignore files as the builder does.
	for _, syntax := range []string{"docker/dockerfile:1", "docker.io/docker/dockerfile", "docker/dockerfile:1-labs"} {
		ignoreCase{name: syntax, files: with(map[string]string{".dockerignore": "docs\n", "Dockerfile": "# syntax=" + syntax + "\nFROM alpine\n"}), change: change}.run(t)
	}
}

// Leaving entries out keeps fingerprint.go's guarantees: a left-out FIFO
// is never opened, and a link is still its target string.
func TestFingerprintIgnoringKeepsTheWalkSafe(t *testing.T) {
	dir := project(t)
	writeFile(t, filepath.Join(dir, ".dockerignore"), "pipes\n!pipes/keep\n")
	for _, name := range []string{"pipes/keep", "pipes/drop"} {
		if err := os.MkdirAll(filepath.Join(dir, "pipes"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := syscall.Mkfifo(filepath.Join(dir, name), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	outside := filepath.Join(t.TempDir(), "secret")
	writeFile(t, outside, "one")
	if err := os.Symlink(outside, filepath.Join(dir, "link")); err != nil {
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
