package protocol

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// The generated types must match the schema dump checked into the repo.
func TestGeneratedTypesAreCurrent(t *testing.T) {
	out := filepath.Join(t.TempDir(), "types_gen.go")
	cmd := exec.Command("go", "run", "./gen", "-in", "schema/protocol.schema.json", "-out", out)
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("gen: %v\n%s", err, b)
	}
	want, _ := os.ReadFile(out)
	got, _ := os.ReadFile("types_gen.go")
	if !bytes.Equal(want, got) {
		t.Fatal("types_gen.go is stale: run go generate ./internal/protocol")
	}
}
