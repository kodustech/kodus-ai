package bakecatalog

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A generation of one repository is written as it always was (no
// refsDigest key) and keyed by its commit; one of several keeps its
// refsDigest across a reopen and is keyed by it.
func TestAGenerationKeepsItsRefsDigest(t *testing.T) {
	one := gen("g1", "env-1")
	raw, err := json.Marshal(one)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "refsDigest") || one.Key() != one.SHA {
		t.Fatalf("one repository: %s, key %s", raw, one.Key())
	}
	digest := "sha256:" + strings.Repeat("0a", 32)
	if !IsRefsDigest(digest) || IsRefsDigest("sha256:"+strings.Repeat("0A", 32)) || IsRefsDigest(strings.Repeat("0a", 32)) || IsRefsDigest("") {
		t.Fatal("IsRefsDigest")
	}
	dir := t.TempDir()
	c := open(t, dir, nil)
	many := gen("g2", "env-2")
	many.RefsDigest = digest
	if many.Key() != digest {
		t.Fatalf("key %s", many.Key())
	}
	if err := c.Publish(one); err != nil {
		t.Fatal(err)
	}
	if err := c.Publish(many); err != nil {
		t.Fatal(err)
	}
	if err := c.Close(); err != nil {
		t.Fatal(err)
	}
	file, err := os.ReadFile(filepath.Join(dir, FileName))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(string(file), `"refsDigest"`) != 1 {
		t.Fatalf("catalog %s", file)
	}
	again := open(t, dir, nil)
	g, eligible, _ := again.Lookup("g2")
	if !eligible || g.RefsDigest != digest {
		t.Fatalf("reopened %+v eligible %v", g, eligible)
	}
	if g, _, _ := again.Lookup("g1"); g.RefsDigest != "" {
		t.Fatalf("one repository reopened with %q", g.RefsDigest)
	}
}
