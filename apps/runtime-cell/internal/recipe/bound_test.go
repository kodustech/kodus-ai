package recipe

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/yamlbound"
)

func writeRecipe(t *testing.T, content string) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, ".kodus"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, Path), []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return dir
}

// A recipe over the cap is refused before it is parsed (review #3).
func TestARecipeOverTheCapIsRefusedBeforeParsing(t *testing.T) {
	_, err := Load(writeRecipe(t, "version: 1\n"+strings.Repeat("#", yamlbound.MaxFileBytes)))
	if !errors.Is(err, yamlbound.ErrTooLarge) || !strings.Contains(err.Error(), "1 MiB") {
		t.Fatalf("Load = %v, want the 1 MiB cap", err)
	}
}

// A recipe whose aliases expand past the node bound is refused, even in a
// key the recipe keeps as a raw node (ui).
func TestARecipeAliasBombIsRefused(t *testing.T) {
	var b strings.Builder
	b.WriteString("version: 1\nflags:\n  x0: &a0 [a, a, a, a, a, a, a, a, a, a]\n")
	for i := 1; i <= 5; i++ {
		b.WriteString("  x" + string(rune('0'+i)) + ": &a" + string(rune('0'+i)) + " [")
		b.WriteString(strings.TrimSuffix(strings.Repeat("*a"+string(rune('0'+i-1))+", ", 10), ", "))
		b.WriteString("]\n")
	}
	b.WriteString("ui: *a5\n")
	if _, err := Parse([]byte(b.String())); !errors.Is(err, yamlbound.ErrTooLarge) {
		t.Fatalf("Parse = %v, want the node bound", err)
	}
	if _, err := Load(writeRecipe(t, b.String())); !errors.Is(err, yamlbound.ErrTooLarge) {
		t.Fatalf("Load = %v, want the node bound", err)
	}
}

func TestARecipeUnderTheBoundsLoads(t *testing.T) {
	r, err := Load(writeRecipe(t, sample))
	if err != nil || r.Services.Compose.Primary() != "web" {
		t.Fatalf("Load = %v", err)
	}
}
