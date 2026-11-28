package rootfs

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/guestinit"
)

// The ext4 image holds the flattened tree with its owners and modes: what
// the guest's kernel mounts as its root is what the image and the builder
// put there. Needs e2fsprogs 1.47.1 or later (mkfs.ext4 and debugfs).
func TestTheExt4ImageHoldsTheFlattenedTreeWithItsOwners(t *testing.T) {
	mkfs, err := exec.LookPath("mkfs.ext4")
	if err != nil {
		t.Skip("no mkfs.ext4: install e2fsprogs 1.47.1 or later")
	}
	debugfs, err := exec.LookPath("debugfs")
	if err != nil {
		t.Skip("no debugfs")
	}
	if err := CheckMkfs(context.Background(), mkfs); err != nil {
		t.Skip(err)
	}
	img := layerOf(t,
		file{name: "etc/os-release", body: "ID=test\n"},
		file{name: "home/node/", typ: '5', mode: 0o750, uid: 1000, gid: 1000},
		file{name: "home/node/notes", body: "mine", uid: 1000, gid: 1000, mode: 0o600},
		// A name and a link target beyond ASCII, as an npm tree holds: the
		// kit build failed on the tool image with libarchive reading them in
		// the C locale.
		file{name: "usr/share/doc/café.txt", body: "ü"},
		file{name: "usr/share/doc/link-to-café", typ: '2', link: "café.txt"},
	)
	dir := t.TempDir()
	out := filepath.Join(dir, "root.ext4")
	if err := Build(context.Background(), []Layer{mem(img)}, Options{Profile: guestinit.SandboxProfile, Guest: []byte("#!guest\n")}, Ext4{Label: "kody-sandbox"}, dir, out); err != nil {
		t.Fatal(err)
	}
	read := func(cmd string) string {
		b, err := exec.Command(debugfs, "-R", cmd, out).CombinedOutput()
		if err != nil {
			t.Fatalf("debugfs %s: %v %s", cmd, err, b)
		}
		return string(b)
	}
	if got := read("cat /home/node/notes"); !strings.Contains(got, "mine") {
		t.Fatalf("notes: %q", got)
	}
	if got := read("stat /usr/share/doc/link-to-café"); !strings.Contains(got, "café.txt") {
		t.Fatalf("a link to a non-ASCII name: %s", got)
	}
	if got := read("cat /usr/local/bin/kody-guest"); !strings.Contains(got, "#!guest") {
		t.Fatalf("guest agent: %q", got)
	}
	st := read("stat /home/node/notes")
	if !strings.Contains(st, "User:  1000") || !strings.Contains(st, "Group:  1000") || !strings.Contains(st, "Mode:  0600") {
		t.Fatalf("owner or mode lost: %s", st)
	}
	if got := read("stat /etc/resolv.conf"); !strings.Contains(got, "Type: symlink") || !strings.Contains(got, guestinit.ResolvPath) {
		t.Fatalf("resolv.conf: %s", got)
	}
	// The same input makes the same image (reproducible kit builds).
	again := filepath.Join(dir, "again.ext4")
	if err := Build(context.Background(), []Layer{mem(img)}, Options{Profile: guestinit.SandboxProfile, Guest: []byte("#!guest\n")}, Ext4{Label: "kody-sandbox", SourceDate: unixZero}, dir, again); err != nil {
		t.Fatal(err)
	}
	if err := Build(context.Background(), []Layer{mem(img)}, Options{Profile: guestinit.SandboxProfile, Guest: []byte("#!guest\n")}, Ext4{Label: "kody-sandbox", SourceDate: unixZero}, dir, out); err != nil {
		t.Fatal(err)
	}
	a, _ := os.ReadFile(out)
	b, _ := os.ReadFile(again)
	if !bytes.Equal(a, b) {
		t.Fatal("the same input made two different images")
	}
}

var unixZero = time.Unix(1, 0)
