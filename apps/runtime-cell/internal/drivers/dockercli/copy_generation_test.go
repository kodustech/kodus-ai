package dockercli

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

// Docker may auto-create a missing named source during create/run. Such a
// volume must fail provenance before the mounted helper can start copying.
func TestGenerationCopyChecksMountedSourceBeforeStart(t *testing.T) {
	for _, present := range []bool{false, true} {
		t.Run(map[bool]string{false: "missing", true: "present"}[present], func(t *testing.T) {
			created, started, removed := false, false, false
			nonce := strings.Repeat("a", 24)
			cli := CLI{Run: func(ctx context.Context, _ []byte, _ string, args ...string) ([]byte, error) {
				switch args[0] {
				case "create":
					created = true
				case "volume":
					if len(args) > 1 && args[1] == "inspect" {
						if !created {
							t.Fatal("source inspected before helper holds it")
						}
						if present {
							return []byte(`{"kodus.bake-generation":"` + nonce + `"}`), nil
						}
						return []byte(`{}`), nil
					}
				case "start":
					if !created {
						t.Fatal("helper started without source hold")
					}
					started = true
				case "run":
					t.Fatal("guarded copy bypassed create/inspect boundary")
				case "rm":
					removed = true
				}
				return nil, nil
			}}
			err := cli.CopyVolumeGeneration(context.Background(), "runsc", "helper", "source", "target", map[string]string{"kodus.cell": "cell"}, "", nonce, "")
			if (err == nil) != present || started != present || !removed {
				t.Fatalf("present=%v started=%v removed=%v err=%v", present, started, removed, err)
			}
		})
	}
}

func TestGenerationMarkerRefusesMissingOrNonRegularSource(t *testing.T) {
	for _, kind := range []string{"missing", "symlink", "fifo", "directory", "wrong", "matching"} {
		t.Run(kind, func(t *testing.T) {
			dir := t.TempDir()
			from, to := filepath.Join(dir, "from"), filepath.Join(dir, "to")
			if err := os.Mkdir(from, 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.Mkdir(to, 0o700); err != nil {
				t.Fatal(err)
			}
			nonce := strings.Repeat("a", 24)
			marker := filepath.Join(from, ".kodus-bake-generation")
			switch kind {
			case "matching":
				if err := os.WriteFile(marker, []byte(nonce), 0o600); err != nil {
					t.Fatal(err)
				}
			case "wrong":
				if err := os.WriteFile(marker, []byte("wrong"), 0o600); err != nil {
					t.Fatal(err)
				}
			case "symlink":
				if err := os.WriteFile(filepath.Join(dir, "bait"), []byte(nonce), 0o600); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(filepath.Join(dir, "bait"), marker); err != nil {
					t.Fatal(err)
				}
			case "fifo":
				if err := unix.Mkfifo(marker, 0o600); err != nil {
					t.Fatal(err)
				}
			case "directory":
				if err := os.Mkdir(marker, 0o700); err != nil {
					t.Fatal(err)
				}
			}
			if err := os.WriteFile(filepath.Join(from, "data"), []byte("seed"), 0o600); err != nil {
				t.Fatal(err)
			}
			// Only this test's owned paths replace the fixed container mountpoints.
			script := strings.ReplaceAll(strings.ReplaceAll(generationCopyScript, "/from", from), "/to", to)
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			err := exec.CommandContext(ctx, "sh", "-ec", script, "copy-test", nonce, "").Run()
			if (err == nil) != (kind == "matching") {
				t.Fatalf("marker %s err=%v", kind, err)
			}
			_, statErr := os.Stat(filepath.Join(to, "data"))
			if (statErr == nil) != (kind == "matching") {
				t.Fatal("invalid source copied data")
			}
		})
	}
}

func TestGenerationMarkerWriteRefusesCheckoutSymlink(t *testing.T) {
	dir := t.TempDir()
	from, to := filepath.Join(dir, "from"), filepath.Join(dir, "to")
	if err := os.Mkdir(from, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(to, 0o700); err != nil {
		t.Fatal(err)
	}
	bait := filepath.Join(dir, "bait")
	if err := os.WriteFile(bait, []byte("untouched"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(bait, filepath.Join(from, ".kodus-bake-generation")); err != nil {
		t.Fatal(err)
	}
	script := strings.ReplaceAll(strings.ReplaceAll(generationCopyScript, "/from", from), "/to", to)
	err := exec.Command("sh", "-ec", script, "copy-test", "", strings.Repeat("a", 24)).Run()
	if err == nil {
		t.Fatal("trusted marker followed checkout symlink")
	}
	value, err := os.ReadFile(bait)
	if err != nil || string(value) != "untouched" {
		t.Fatal("marker write escaped destination")
	}
}
