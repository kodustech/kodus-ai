package kit

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// newKit lays out a kit in a directory and writes its manifest.
func newKit(t *testing.T, env bool) (string, string) {
	t.Helper()
	dir := t.TempDir()
	files := map[string]string{
		Layout.Firecracker: "firecracker", Layout.Jailer: "jailer", Layout.Kernel: "vmlinux", Layout.KernelConfig: "CONFIG_X=y",
		Layout.Rootfs["sandbox"]: "sandbox ext4",
	}
	if env {
		files[Layout.Rootfs["environment"]] = "environment ext4"
	}
	for p, body := range files {
		full := filepath.Join(dir, filepath.FromSlash(p))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	digest, err := Make(dir, "x86_64", "v1.17.0", "6.1.188")
	if err != nil {
		t.Fatal(err)
	}
	return dir, digest
}

func reason(err error) string {
	var e *Error
	if errors.As(err, &e) {
		return e.Reason
	}
	return ""
}

// A kit whose manifest is the pinned digest and whose files are the
// manifest's loads, with its paths, and says whether it ships Docker.
func TestAKitThatMatchesItsPinnedDigestLoads(t *testing.T) {
	for _, env := range []bool{false, true} {
		dir, digest := newKit(t, env)
		k, err := Load(dir, digest, "x86_64")
		if err != nil {
			t.Fatal(err)
		}
		if b, _ := os.ReadFile(k.Path(k.Manifest.Firecracker)); string(b) != "firecracker" {
			t.Fatalf("firecracker path %s", k.Path(k.Manifest.Firecracker))
		}
		if k.NestedDocker() != env {
			t.Fatalf("nested docker %v with an environment base %v", k.NestedDocker(), env)
		}
	}
}

// A manifest that is not the digest the cell pinned is refused.
func TestAManifestThatIsNotThePinnedDigestIsRefused(t *testing.T) {
	dir, _ := newKit(t, false)
	other := "sha256:" + strings.Repeat("0", 64)
	if _, err := Load(dir, other, "x86_64"); !strings.Contains(reason(err), "not the pinned") {
		t.Fatalf("err %v", err)
	}
	if _, err := Load(dir, "latest", "x86_64"); reason(err) == "" {
		t.Fatalf("a digest that is not sha256: %v", err)
	}
}

// A file changed after the manifest was signed is refused by name, whether
// its size changed or only its bytes.
func TestAFileChangedAfterSigningIsRefusedByName(t *testing.T) {
	for _, body := range []string{"jailer!", "JAILER"} {
		dir, digest := newKit(t, false)
		if err := os.WriteFile(filepath.Join(dir, "bin", "jailer"), []byte(body), 0o755); err != nil {
			t.Fatal(err)
		}
		if _, err := Load(dir, digest, "x86_64"); !strings.Contains(reason(err), "bin/jailer") {
			t.Fatalf("%q: %v", body, err)
		}
	}
}

// A kit file that is a link, or a manifest path that leaves the kit, is
// refused: the kit cannot point the cell at a binary outside it.
func TestAKitCannotPointOutsideItself(t *testing.T) {
	dir, digest := newKit(t, false)
	fc := filepath.Join(dir, "bin", "firecracker")
	outside := filepath.Join(t.TempDir(), "firecracker")
	if err := os.WriteFile(outside, []byte("firecracker"), 0o755); err != nil {
		t.Fatal(err)
	}
	_ = os.Remove(fc)
	if err := os.Symlink(outside, fc); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(dir, digest, "x86_64"); !strings.Contains(reason(err), "bin/firecracker") {
		t.Fatalf("a link: %v", err)
	}
	m := Manifest{
		SchemaVersion: 1, Arch: "x86_64", FirecrackerVersion: "v1.17.0", KernelVersion: "6.1.188",
		Firecracker: File{Path: "../../usr/bin/firecracker", SHA256: strings.Repeat("a", 64), Size: 1},
		Jailer:      File{Path: "bin/jailer", SHA256: strings.Repeat("a", 64), Size: 1},
		Kernel:      File{Path: "kernel/vmlinux", SHA256: strings.Repeat("a", 64), Size: 1}, KernelConfig: File{Path: "kernel/config", SHA256: strings.Repeat("a", 64), Size: 1},
		Rootfs: map[string]Rootfs{"sandbox": {File: File{Path: "rootfs/sandbox.ext4", SHA256: strings.Repeat("a", 64), Size: 1}}},
	}
	raw, _ := json.Marshal(m)
	if err := os.WriteFile(filepath.Join(dir, ManifestName), raw, 0o644); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(raw)
	if _, err := Load(dir, "sha256:"+hex.EncodeToString(sum[:]), "x86_64"); !strings.Contains(reason(err), "inside the kit") {
		t.Fatalf("a path out of the kit: %v", err)
	}
}

// A kit built for another architecture is refused, naming both.
func TestAKitOfAnotherArchitectureIsRefused(t *testing.T) {
	dir, digest := newKit(t, false)
	_, err := Load(dir, digest, "arm64")
	if r := reason(err); !strings.Contains(r, "x86_64") || !strings.Contains(r, "arm64") {
		t.Fatalf("err %v", err)
	}
}
