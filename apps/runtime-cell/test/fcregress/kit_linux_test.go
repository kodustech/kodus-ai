//go:build linux

package fcregress

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/microvm"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation"
)

// S-17, the kit's part: a kit altered after its release (one byte of the
// guest kernel) is refused at start, offline, naming the file; so is the
// release's kit under a pin it is not. The pinned kit itself opens (the
// control).
func TestFirecrackerAnAlteredKitIsRefusedOffline(t *testing.T) {
	_ = open(t) // the pinned kit opens
	kitDir, digest := os.Getenv("KODY_E2E_FIRECRACKER_KIT"), os.Getenv("KODY_E2E_FIRECRACKER_KIT_DIGEST")
	altered := filepath.Join(t.TempDir(), "kit")
	if out, err := exec.Command("cp", "-a", "--reflink=auto", kitDir, altered).CombinedOutput(); err != nil {
		t.Fatalf("copy the kit: %v %s", err, out)
	}
	kernel := filepath.Join(altered, "kernel", "vmlinux")
	f, err := os.OpenFile(kernel, os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	b := make([]byte, 1)
	_, _ = f.ReadAt(b, 4096)
	b[0] ^= 0xff
	_, err = f.WriteAt(b, 4096)
	_ = f.Close()
	if err != nil {
		t.Fatal(err)
	}
	opened := func(dir, pin string) error {
		_, err := microvm.Open(context.Background(), microvm.Firecracker{
			CellID: cellID, KitDir: dir, KitDigest: pin, StateDir: filepath.Join(t.TempDir(), "state"), Host: isolation.ProbeHost(),
		})
		return err
	}
	alteredErr := opened(altered, digest)
	if alteredErr == nil || !strings.Contains(alteredErr.Error(), "vmlinux") {
		t.Fatalf("an altered kernel: %v", alteredErr)
	}
	pinErr := opened(kitDir, "sha256:"+strings.Repeat("0", 64))
	if pinErr == nil {
		t.Fatal("the release's kit under another pin opened")
	}
	t.Logf("EVIDENCE S-17 one byte of kernel/vmlinux changed: %v; the kit under another pin: %v", alteredErr, pinErr)
}
