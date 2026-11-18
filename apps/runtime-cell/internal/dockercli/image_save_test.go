package dockercli

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// SaveImage writes the one image named to the tarball with docker save, and
// a name this Docker does not hold is ErrNoSuchImage.
func TestSaveImageWritesTheOneImageNamed(t *testing.T) {
	dir := t.TempDir()
	argv := filepath.Join(dir, "argv")
	bin := filepath.Join(dir, "docker")
	script := "#!/bin/sh\necho \"$@\" > " + argv + "\ncase \"$4\" in missing*) echo 'Error response from daemon: No such image: missing:1' >&2; exit 1;; esac\n"
	if err := os.WriteFile(bin, []byte(script), 0o700); err != nil { //nolint:gosec // G306: the test's own fake docker
		t.Fatal(err)
	}
	c := CLI{Bin: bin}
	tarball := filepath.Join(dir, "img.tar")
	if err := c.SaveImage(context.Background(), "kodus-bake/c/o/e:n-fp", tarball); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(argv) //nolint:gosec // G304: the test's own file
	if strings.TrimSpace(string(got)) != "save -o "+tarball+" kodus-bake/c/o/e:n-fp" {
		t.Fatalf("argv %q", got)
	}
	if err := c.SaveImage(context.Background(), "missing:1", tarball); !errors.Is(err, ErrNoSuchImage) {
		t.Fatalf("a missing image: %v", err)
	}
}
