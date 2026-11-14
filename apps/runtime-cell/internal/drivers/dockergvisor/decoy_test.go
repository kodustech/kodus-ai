package dockergvisor

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose/sandbox"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
)

// S-29: a Run's npmrc canary is a file the cell owns, bound read-only into
// every service where a compromised app looks for secrets, and gone with
// the machine. Before, nothing was ever planted.
func TestUpPlantsTheDecoyFileAndDestroyRemovesIt(t *testing.T) {
	d, r, _ := newDriver(t, `{"runsc":{}}`)
	ref, err := d.Create(context.Background(), spec())
	if err != nil {
		t.Fatal(err)
	}
	ref.Tags[driver.TagOrg], ref.Tags[driver.TagRole] = "", ""
	const value = "npm_0123456789abcdef0123456789abcdef"
	decoy := decoyPath(d.workDir(), ref.MachineID)
	dir := t.TempDir()
	mount := `,"volumes":[{"type":"bind","source":"` + decoy + `","target":"` + sandbox.DecoyTarget + `","read_only":true}]`
	r.answers["compose config"] = strings.Replace(canonicalFor(dir), `"extra_hosts"`, strings.TrimPrefix(mount, ",")+`,"extra_hosts"`, 1)
	r.answers["ps"] = "s1\n"
	r.answers["inspect"] = `[{"Id":"s1","Name":"/kodus-claim-1-workload-a-1","Config":{"Labels":{"kodus.cell":"cell-1"}},"NetworkSettings":{"Networks":{"kodus-claim-1":{"IPAddress":"172.30.0.9"}}}}]`
	ctx := driver.WithCanaries(context.Background(), []driver.Canary{{Slot: driver.CanarySlotNpmrc, Value: value}, {Slot: driver.CanarySlotConfig, Value: "kdx_live_0123456789abcdef0123456789abcdef"}})
	if _, err := d.Up(ctx, ref, []byte("services:\n  a:\n    image: x\n"), dir); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(decoy)
	if err != nil || string(b) != "//registry.npmjs.org/:_authToken="+value+"\n" {
		t.Fatalf("decoy %q %v", b, err)
	}
	if fi, _ := os.Stat(decoy); fi.Mode().Perm() != 0o644 {
		t.Fatalf("decoy mode %v", fi.Mode())
	}
	// The decoy is the cell's, never in the checkout.
	if strings.HasPrefix(decoy, dir) {
		t.Fatal("decoy inside the checkout")
	}
	// Nothing the driver logged or labelled carries it.
	for _, c := range r.calls {
		if strings.Contains(strings.Join(c.args, " "), value) {
			t.Fatalf("a docker argument carries the canary: %v", c.args)
		}
	}
	if err := d.Destroy(context.Background(), ref); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(decoy); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("decoy outlived the machine: %v", err)
	}
}

// A claim without the npmrc canary (a setup, an older hub) gets no file,
// and none left from an earlier boot of the same name.
func TestUpWithoutCanariesPlantsNoDecoy(t *testing.T) {
	d, r, _ := newDriver(t, `{"runsc":{}}`)
	ref, _ := d.Create(context.Background(), spec())
	ref.Tags[driver.TagOrg], ref.Tags[driver.TagRole] = "", ""
	decoy := decoyPath(d.workDir(), ref.MachineID)
	if err := os.MkdirAll(filepath.Dir(decoy), 0o755); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(decoy, []byte("stale"), 0o644)
	dir := t.TempDir()
	r.answers["compose config"] = canonicalFor(dir)
	r.answers["ps"] = "s1\n"
	r.answers["inspect"] = `[{"Id":"s1","Name":"/kodus-claim-1-workload-a-1","Config":{"Labels":{"kodus.cell":"cell-1"}},"NetworkSettings":{"Networks":{"kodus-claim-1":{"IPAddress":"172.30.0.9"}}}}]`
	if _, err := d.Up(context.Background(), ref, []byte("services:\n  a:\n    image: x\n"), dir); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(decoy); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("a decoy without canaries: %v", err)
	}
}
