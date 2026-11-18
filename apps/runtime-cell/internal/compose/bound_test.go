package compose

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/yamlbound"
)

// aliasBomb is a compose file of a few hundred bytes whose aliases expand to
// a million nodes: under yaml.v3's own alias ratio, so only the cell's bound
// stops it (review #3).
func aliasBomb() string {
	var b strings.Builder
	b.WriteString("x-0: &a0 [a, a, a, a, a, a, a, a, a, a]\n")
	for i := 1; i <= 5; i++ {
		b.WriteString("x-" + string(rune('0'+i)) + ": &a" + string(rune('0'+i)) + " [")
		for j := 0; j < 10; j++ {
			if j > 0 {
				b.WriteString(", ")
			}
			b.WriteString("*a" + string(rune('0'+i-1)))
		}
		b.WriteString("]\n")
	}
	b.WriteString("services:\n  web:\n    image: nginx\n    x-bomb: *a5\n")
	return b.String()
}

func writeCompose(t *testing.T, content string) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "docker-compose.yml"), []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return dir
}

// A compose file over the cap is refused before it is parsed: what it holds
// (here, not even YAML) is never read into the cell's memory.
func TestAComposeFileOverTheCapIsRefusedBeforeParsing(t *testing.T) {
	dir := writeCompose(t, strings.Repeat("[", yamlbound.MaxFileBytes+1))
	_, err := Load(dir, nil)
	if !errors.Is(err, yamlbound.ErrTooLarge) || !strings.Contains(err.Error(), "1 MiB") {
		t.Fatalf("Load = %v, want the 1 MiB cap", err)
	}
}

func TestAComposeAliasBombIsRefused(t *testing.T) {
	_, err := Load(writeCompose(t, aliasBomb()), nil)
	if !errors.Is(err, yamlbound.ErrTooLarge) {
		t.Fatalf("Load = %v, want the node bound", err)
	}
}

// Many nodes without an alias (a long flow list) count too.
func TestAComposeFileOfTooManyNodesIsRefused(t *testing.T) {
	content := "services:\n  web:\n    image: nginx\n    x-list: [" + strings.Repeat("a,", yamlbound.MaxNodes) + "a]\n"
	_, err := Load(writeCompose(t, content), nil)
	if !errors.Is(err, yamlbound.ErrTooLarge) {
		t.Fatalf("Load = %v, want the node bound", err)
	}
}

// Only a regular file is read: a directory or a FIFO named like a compose
// file is refused, and the FIFO is not waited on.
func TestAComposeFileThatIsNotRegularIsRefused(t *testing.T) {
	for name, mk := range map[string]func(string) error{
		"directory": func(p string) error { return os.Mkdir(p, 0o700) },
		"fifo":      func(p string) error { return syscall.Mkfifo(p, 0o600) },
	} {
		dir := t.TempDir()
		if err := mk(filepath.Join(dir, "docker-compose.yml")); err != nil {
			t.Fatal(err)
		}
		if _, err := Load(dir, []string{"docker-compose.yml"}); err == nil || !strings.Contains(err.Error(), "not a regular file") {
			t.Fatalf("%s: Load = %v, want a refusal", name, err)
		}
	}
}

// An ordinary file with anchors and merges still loads.
func TestAComposeFileWithAnchorsUnderTheBoundsLoads(t *testing.T) {
	content := "x-env: &env { A: \"1\" }\nservices:\n  web:\n    image: nginx\n    environment: *env\n  worker:\n    image: nginx\n    environment:\n      <<: *env\n      B: \"2\"\n"
	p, err := Load(writeCompose(t, content), nil)
	if err != nil || !p.HasService("web") || !p.HasService("worker") {
		t.Fatalf("Load = %v", err)
	}
}
