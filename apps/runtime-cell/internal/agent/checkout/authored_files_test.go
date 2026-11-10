package checkout

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

const dockerfile = "FROM node:22-bookworm-slim\nWORKDIR /app\nCOPY . .\nCMD [\"npm\", \"start\"]\n"

func authoredRecipe(files ...protocol.AuthoredFile) *protocol.ClaimAcquireBodyRecipe {
	return &protocol.ClaimAcquireBodyRecipe{Path: ".kodus/workspace.yaml", Content: []byte(`"version: 1\n"`), Files: files}
}

func kody(path, content string) protocol.AuthoredFile {
	return protocol.AuthoredFile{Path: path, Content: content}
}

func mustRead(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func wantRefused(t *testing.T, err error, reason string) {
	t.Helper()
	var ae *authoredFileError
	if !errors.As(err, &ae) || !strings.Contains(ae.Error(), reason) {
		t.Fatalf("want an authored file refusal %q, got %v", reason, err)
	}
}

// The files land under .kodus/ of a checkout that has none, with the exact
// bytes, next to the recipe applied after them.
func TestAuthoredFilesAreWrittenIntoTheCheckout(t *testing.T) {
	dir := t.TempDir()
	compose := "services:\n  app:\n    build: { context: ., dockerfile: .kodus/Dockerfile.kody }\n"
	r := authoredRecipe(kody(".kodus/Dockerfile.kody", dockerfile), kody(".kodus/compose.kody.yaml", compose))
	if err := WriteAuthoredFiles(dir, r); err != nil {
		t.Fatal(err)
	}
	if err := ApplyRecipe(dir, r); err != nil {
		t.Fatal(err)
	}
	if got := mustRead(t, filepath.Join(dir, ".kodus/Dockerfile.kody")); got != dockerfile {
		t.Fatalf("Dockerfile %q", got)
	}
	if got := mustRead(t, filepath.Join(dir, ".kodus/compose.kody.yaml")); got != compose {
		t.Fatalf("compose %q", got)
	}
	st, err := os.Lstat(filepath.Join(dir, ".kodus/Dockerfile.kody"))
	if err != nil || st.Mode().Perm() != 0o644 || !st.Mode().IsRegular() {
		t.Fatalf("mode %v %v", st.Mode(), err)
	}
	if got, _ := read(t, dir); got != "version: 1\n" {
		t.Fatalf("recipe %q", got)
	}
	// A checkout whose .kodus is a real directory with other files keeps them.
	again := checkout(t, "version: 1\n")
	if err := WriteAuthoredFiles(again, authoredRecipe(kody(".kodus/Dockerfile", dockerfile))); err != nil {
		t.Fatal(err)
	}
	if got, _ := read(t, again); got != "version: 1\n" {
		t.Fatalf("the checkout's recipe changed: %q", got)
	}
}

func TestNoAuthoredFilesLeavesTheCheckout(t *testing.T) {
	dir := t.TempDir()
	for _, r := range []*protocol.ClaimAcquireBodyRecipe{nil, authoredRecipe()} {
		if err := WriteAuthoredFiles(dir, r); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := os.Lstat(filepath.Join(dir, ".kodus")); !os.IsNotExist(err) {
		t.Fatalf(".kodus was created: %v", err)
	}
}

// A PR that plants .kodus as a link out of the checkout gets nothing
// written there: the claim fails instead.
func TestAuthoredFilesRefuseAKodusLinkOutOfTheCheckout(t *testing.T) {
	for _, target := range []string{"/etc", t.TempDir()} {
		dir := t.TempDir()
		if err := os.Symlink(target, filepath.Join(dir, ".kodus")); err != nil {
			t.Fatal(err)
		}
		err := WriteAuthoredFiles(dir, authoredRecipe(kody(".kodus/Dockerfile.kody", dockerfile)))
		wantRefused(t, err, ".kodus: is a symbolic link")
		if _, err := os.Lstat(filepath.Join(target, "Dockerfile.kody")); !os.IsNotExist(err) {
			t.Fatalf("written through the link into %s: %v", target, err)
		}
	}
}

// A link to another directory of the repository is refused too: the files
// would land where the PR chose, and the boot would read them from there.
func TestAuthoredFilesRefuseAKodusLinkInsideTheCheckout(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "src"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("src", filepath.Join(dir, ".kodus")); err != nil {
		t.Fatal(err)
	}
	wantRefused(t, WriteAuthoredFiles(dir, authoredRecipe(kody(".kodus/Dockerfile.kody", dockerfile))), ".kodus: is a symbolic link")
	if entries, _ := os.ReadDir(filepath.Join(dir, "src")); len(entries) != 0 {
		t.Fatalf("written into src: %v", entries)
	}
}

func TestAuthoredFilesRefuseAKodusFile(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, ".kodus"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	wantRefused(t, WriteAuthoredFiles(dir, authoredRecipe(kody(".kodus/Dockerfile.kody", dockerfile))), ".kodus: is not a directory")
}

// The PR's own .kodus/Dockerfile.kody is never replaced: the claim fails,
// and the PR's file keeps its bytes.
func TestAuthoredFilesNeverReplaceAFileOfTheCheckout(t *testing.T) {
	dir := checkout(t, "")
	_ = os.MkdirAll(filepath.Join(dir, ".kodus"), 0o755)
	planted := "FROM evil.example/backdoor:latest\n"
	if err := os.WriteFile(filepath.Join(dir, ".kodus/Dockerfile.kody"), []byte(planted), 0o644); err != nil {
		t.Fatal(err)
	}
	wantRefused(t, WriteAuthoredFiles(dir, authoredRecipe(kody(".kodus/Dockerfile.kody", dockerfile))), "is already in the checkout with other content")
	if got := mustRead(t, filepath.Join(dir, ".kodus/Dockerfile.kody")); got != planted {
		t.Fatalf("the PR's file was replaced: %q", got)
	}
	// Same length, other bytes: refused all the same.
	same := strings.Repeat("x", len(dockerfile))
	_ = os.WriteFile(filepath.Join(dir, ".kodus/Dockerfile"), []byte(same), 0o644)
	wantRefused(t, WriteAuthoredFiles(dir, authoredRecipe(kody(".kodus/Dockerfile", dockerfile))), "with other content")
}

// The recipe PR Kodus opens adds these very files: a Run on it finds them
// with the same bytes, which changes nothing, so the claim goes on.
func TestAuthoredFilesAcceptTheSameBytesAlreadyThere(t *testing.T) {
	dir := checkout(t, "")
	_ = os.MkdirAll(filepath.Join(dir, ".kodus"), 0o755)
	if err := os.WriteFile(filepath.Join(dir, ".kodus/Dockerfile.kody"), []byte(dockerfile), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := WriteAuthoredFiles(dir, authoredRecipe(kody(".kodus/Dockerfile.kody", dockerfile))); err != nil {
		t.Fatal(err)
	}
}

// A link at the file's own path is never followed, even to the same bytes.
func TestAuthoredFilesRefuseALinkAtTheFilePath(t *testing.T) {
	dir := checkout(t, "")
	_ = os.MkdirAll(filepath.Join(dir, ".kodus"), 0o755)
	outside := filepath.Join(t.TempDir(), "target")
	if err := os.WriteFile(outside, []byte(dockerfile), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(dir, ".kodus/Dockerfile.kody")); err != nil {
		t.Fatal(err)
	}
	// A dangling one too: O_CREAT alone would create its target.
	dangling := filepath.Join(t.TempDir(), "created-through-the-link")
	if err := os.Symlink(dangling, filepath.Join(dir, ".kodus/Dockerfile")); err != nil {
		t.Fatal(err)
	}
	wantRefused(t, WriteAuthoredFiles(dir, authoredRecipe(kody(".kodus/Dockerfile.kody", dockerfile))), "is not a regular file")
	wantRefused(t, WriteAuthoredFiles(dir, authoredRecipe(kody(".kodus/Dockerfile", dockerfile))), "is not a regular file")
	if _, err := os.Lstat(dangling); !os.IsNotExist(err) {
		t.Fatalf("created through the dangling link: %v", err)
	}
}

// A FIFO planted where the file goes cannot hang the cell.
func TestAuthoredFilesRefuseAFIFOWithoutBlocking(t *testing.T) {
	dir := checkout(t, "")
	_ = os.MkdirAll(filepath.Join(dir, ".kodus"), 0o755)
	if err := syscall.Mkfifo(filepath.Join(dir, ".kodus/Dockerfile.kody"), 0o644); err != nil {
		t.Skip("no mkfifo here:", err)
	}
	wantRefused(t, WriteAuthoredFiles(dir, authoredRecipe(kody(".kodus/Dockerfile.kody", dockerfile))), "is not a regular file")
}

// The protocol's rules are checked again before anything is written,
// whatever decoded the frame.
func TestAuthoredFilesRecheckTheProtocolRules(t *testing.T) {
	for name, files := range map[string][]protocol.AuthoredFile{
		"traversal":   {kody(".kodus/../Dockerfile", dockerfile)},
		"dot-dot":     {kody(".kodus/..", dockerfile)},
		"nested":      {kody(".kodus/a/Dockerfile", dockerfile)},
		"outside":     {kody("Dockerfile", dockerfile)},
		"absolute":    {kody("/etc/passwd", dockerfile)},
		"recipe path": {kody(".kodus/workspace.yaml", "version: 1\n")},
		"twice":       {kody(".kodus/Dockerfile", dockerfile), kody(".kodus/Dockerfile", dockerfile)},
		"oversized":   {kody(".kodus/Dockerfile", strings.Repeat("#", protocol.MaxAuthoredFileBytes+1))},
		"too many": {
			kody(".kodus/a", "x"), kody(".kodus/b", "x"), kody(".kodus/c", "x"), kody(".kodus/d", "x"), kody(".kodus/e", "x"),
		},
		"total": {
			kody(".kodus/a", strings.Repeat("#", 16_000)), kody(".kodus/b", strings.Repeat("#", 16_000)),
			kody(".kodus/c", strings.Repeat("#", 16_000)), kody(".kodus/d", strings.Repeat("#", 16_000)),
		},
	} {
		dir := t.TempDir()
		err := WriteAuthoredFiles(dir, authoredRecipe(files...))
		if !errors.Is(err, protocol.ErrAuthoredFiles) {
			t.Fatalf("%s: %v", name, err)
		}
		if entries, _ := os.ReadDir(dir); len(entries) != 0 {
			t.Fatalf("%s: wrote %v", name, entries)
		}
	}
}
