package agent

import (
	"os"
	"path/filepath"
	"slices"
	"testing"
)

func TestDockerfileImagePins(t *testing.T) {
	dir := t.TempDir()
	write := func(p, s string) {
		if err := os.MkdirAll(filepath.Dir(filepath.Join(dir, p)), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, p), []byte(s), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("Dockerfile", "FROM node:22-alpine AS web\nFROM web\n")
	write(".kodus/Dockerfile.backend", "FROM golang:1.24.5-alpine\n")
	write("node_modules/x/Dockerfile", "FROM evil/image\n")
	write("README.md", "FROM ubuntu\n")
	pins, err := dockerfileImagePins(dir)
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"library/golang:1.24.5-alpine", "library/node:22-alpine"}; !slices.Equal(pins, want) {
		t.Fatalf("pins %v, want %v", pins, want)
	}
}
