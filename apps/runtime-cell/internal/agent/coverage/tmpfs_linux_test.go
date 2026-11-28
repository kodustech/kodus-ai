//go:build linux

package coverage

import (
	"bytes"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"syscall"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/exercised"
)

func needRoot(t *testing.T) {
	t.Helper()
	if os.Geteuid() != 0 {
		t.Skip("mounting a tmpfs needs root")
	}
}

// A PR that writes its coverage directory without end stops at DirBytes
// (ENOSPC in its own process), and at DirFiles files: the host's disk never
// sees it.
func TestTmpfsCapStopsWritesPastTheBound(t *testing.T) {
	needRoot(t)
	claimDir := t.TempDir()
	dir, _, err := Prepare(claimDir, Tmpfs{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = Release(claimDir, Tmpfs{}) })
	if err := os.WriteFile(filepath.Join(dir, exercised.StartMarkerPrefix+"1-0"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	f, err := os.Create(filepath.Join(dir, "coverage-1-2-3.json"))
	if err != nil {
		t.Fatal(err)
	}
	chunk := bytes.Repeat([]byte("x"), 1<<20)
	written := 0
	for written <= DirBytes {
		n, err := f.Write(chunk)
		written += n
		if err != nil {
			if !errors.Is(err, syscall.ENOSPC) {
				t.Fatalf("write past the cap: %v, want ENOSPC", err)
			}
			break
		}
	}
	_ = f.Close()
	if written > DirBytes {
		t.Fatalf("wrote %d bytes, past the cap %d", written, DirBytes)
	}
	if err := os.Remove(f.Name()); err != nil {
		t.Fatal(err)
	}
	made := 0
	for ; made <= DirFiles; made++ {
		if err := os.WriteFile(filepath.Join(dir, "f"+strconv.Itoa(made)), nil, 0o600); err != nil {
			break
		}
	}
	if made >= DirFiles {
		t.Fatalf("made %d files, the cap is %d", made, DirFiles)
	}
	// A second Prepare (a reset's boot) keeps the cap and its files.
	if _, _, err := Prepare(claimDir, Tmpfs{}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "f0")); err != nil {
		t.Fatalf("a second Prepare lost the files: %v", err)
	}
	if err := Release(claimDir, Tmpfs{}); err != nil {
		t.Fatal(err)
	}
	if ok, _ := tmpfsCapped(dir); ok {
		t.Fatal("still capped after Release")
	}
	if err := os.RemoveAll(claimDir); err != nil {
		t.Fatalf("the claim's directory is not removable after Release: %v", err)
	}
}

// A cell that stopped without its releases leaves caps; the next one
// unmounts those of <claims>/<claim>/coverage and nothing else.
func TestRecoverUnmountsTheCapsALostCellLeft(t *testing.T) {
	needRoot(t)
	claims := t.TempDir()
	left := filepath.Join(claims, "claim-1")
	if err := os.Mkdir(left, 0o700); err != nil {
		t.Fatal(err)
	}
	if _, _, err := Prepare(left, Tmpfs{}); err != nil {
		t.Fatal(err)
	}
	other := filepath.Join(claims, "claim-2", "elsewhere")
	if err := os.MkdirAll(other, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Mount("tmpfs", other, "tmpfs", 0, "size=1m"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = syscall.Unmount(other, syscall.MNT_DETACH) })
	n, err := Tmpfs{}.Recover(claims)
	if err != nil || n != 1 {
		t.Fatalf("recovered %d, %v; want 1", n, err)
	}
	if ok, _ := tmpfsCapped(filepath.Join(left, DirName)); ok {
		t.Fatal("the left cap is still mounted")
	}
	var st syscall.Statfs_t
	if err := syscall.Statfs(other, &st); err != nil || int64(st.Type) != tmpfsMagic {
		t.Fatalf("a mount that is no claim's coverage was taken: %v", err)
	}
}

// A cell in a mount namespace of its own (a unit with PrivateMounts=)
// would mount the cap where Docker never looks: it refuses instead.
func TestTmpfsCapRefusesOutsideTheHostsMountNamespace(t *testing.T) {
	if dir := os.Getenv("KODUS_COVERAGE_CHILD_DIR"); dir != "" {
		if err := (Tmpfs{}).Cap(dir); err == nil {
			_ = syscall.Unmount(dir, syscall.MNT_DETACH)
			t.Fatal("capped in a private mount namespace")
		}
		return
	}
	needRoot(t)
	unshare, err := exec.LookPath("unshare")
	if err != nil {
		t.Skip("no unshare(1)")
	}
	dir := t.TempDir()
	cmd := exec.Command(unshare, "--mount", "--propagation", "unchanged", os.Args[0], "-test.run=^TestTmpfsCapRefusesOutsideTheHostsMountNamespace$", "-test.v")
	cmd.Env = append(os.Environ(), "KODUS_COVERAGE_CHILD_DIR="+dir)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("child: %v\n%s", err, out)
	}
}
