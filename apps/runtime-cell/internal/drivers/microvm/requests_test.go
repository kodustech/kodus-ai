package microvm

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose/sandbox"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver/drivertest"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/guest"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/machinetrust"
)

// The microVM driver honors every field of its requests, as its backend
// shows them: each Up gets a fresh claim and a fresh VM directory (the real
// guest agent on a host directory, a docker on its PATH that prints).
func TestTheMicroVMDriverHonorsItsRequests(t *testing.T) {
	drivertest.RunRequests(t, func(t *testing.T) drivertest.RequestSubject {
		d, b, _ := newDriver(t)
		trust := t.TempDir()
		_ = os.WriteFile(filepath.Join(trust, "b.pem"), []byte("bundle"), 0o644)
		_ = os.WriteFile(filepath.Join(trust, "c.pem"), []byte("cellca"), 0o644)
		d.cfg.Trust = machinetrust.Files{Bundle: filepath.Join(trust, "b.pem"), CellCA: filepath.Join(trust, "c.pem")}
		bin := t.TempDir()
		if err := os.WriteFile(filepath.Join(bin, "docker"), []byte("#!/bin/sh\necho \"compose: $*\" >&2\n"), 0o755); err != nil {
			t.Fatal(err)
		}
		roots := map[string]string{} // machine -> its VM directory
		n := 0
		claim := func(t *testing.T) string {
			t.Helper()
			n++
			id := fmt.Sprintf("req-%d", n)
			if _, err := d.PrepareClaim(context.Background(), driver.ClaimNetworkSpec{CellID: cell, OrgID: "org-a", ClaimID: id}); err != nil {
				t.Fatal(err)
			}
			return id
		}
		return drivertest.RequestSubject{
			Capabilities: d.Capabilities(),
			Booter:       d,
			Prepare: func(t *testing.T, ask driver.UpRequest) driver.UpRequest {
				root := t.TempDir()
				fs, err := guest.OpenRoot(root)
				if err != nil {
					t.Fatal(err)
				}
				b.guestFS = fs.WithPath(bin + ":/usr/bin:/bin")
				ref, err := d.Create(context.Background(), spec(claim(t)))
				if err != nil {
					t.Fatal(err)
				}
				roots[ref.MachineID] = root
				ws := filepath.Join(t.TempDir(), "ws")
				if err := os.MkdirAll(filepath.Join(ws, "app"), 0o755); err != nil {
					t.Fatal(err)
				}
				_ = os.WriteFile(filepath.Join(ws, "app", "Dockerfile"), []byte("FROM x\nRUN --mount=type=secret,id="+drivertest.BuildSecretName+" true\n"), 0o644)
				if err := d.Upload(context.Background(), ref, ws, "workspace", nil); err != nil {
					t.Fatal(err)
				}
				ask.Ref, ask.Compose, ask.ProjectDir, ask.WorkspaceRoot = ref, []byte("services: {app: {build: .}}\n"), filepath.Join(ws, "app"), ws
				return ask
			},
			Booted: func(t *testing.T, ref driver.MachineRef) drivertest.Booted {
				dir := filepath.Join(roots[ref.MachineID], "workspace", "app")
				file, _ := os.ReadFile(filepath.Join(dir, composeFileName))
				var got drivertest.Booted
				got.Trusted = strings.Contains(string(file), "target: "+machinetrust.BundleTarget)
				if strings.Contains(string(file), "target: "+sandbox.DecoyTarget) {
					decoy, _ := os.ReadFile(filepath.Join(dir, cellFilesDir, "npmrc"))
					got.Decoy = string(decoy)
				}
				// A machine whose builds hold the org's secrets is recorded
				// so it never becomes a template or a session.
				got.BuildSecrets = slices.Contains(b.specs[ref.MachineID].Taints, isolation.TaintSecrets)
				return got
			},
			Sandboxer:   d,
			SandboxSpec: func(t *testing.T) driver.MachineSpec { return spec(claim(t)) },
			SandboxTrusted: func(t *testing.T, ref driver.MachineRef) bool {
				return slices.ContainsFunc(b.specs[ref.MachineID].Mounts, func(m string) bool { return strings.Contains(m, machinetrust.BundleTarget) })
			},
		}
	})
}
