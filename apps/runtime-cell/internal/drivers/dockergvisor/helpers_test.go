package dockergvisor

import (
	"os"
	"path/filepath"
	"testing"
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

// project is a checkout with a Dockerfile and one source file.
func project(t *testing.T) string {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "Dockerfile"), "FROM alpine:3.20\nCOPY . /app\n")
	writeFile(t, filepath.Join(dir, "src", "main.go"), "package main\n")
	return dir
}
