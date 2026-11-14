//go:build linux

package gvisoregress

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockergvisor"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/recipe"
)

// Real runsc/volume/catalog acceptance; no product, model, Git or external
// service is involved. Every resource belongs to a fresh random cell scope.
func TestImmutableBakeGenerationSurvivesDriverRestart(t *testing.T) {
	if os.Getenv("KODY_E2E_GVISOR") != "1" {
		t.Skip("KODY_E2E_GVISOR=1 requires isolated Linux Docker with runsc")
	}
	var nonce [6]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		t.Fatal(err)
	}
	suffix := hex.EncodeToString(nonce[:])
	cell, org, env := "cell-generation-"+suffix, "org-generation", "env-generation"
	t.Logf("owned test scope=%s", cell)
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	root := t.TempDir()
	project := filepath.Join(root, "checkout")
	if err := os.MkdirAll(filepath.Join(project, ".kodus"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(project, recipe.Path), []byte("version: 1\ndata: { reset: snapshot }\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	compose := []byte(`services:
  db:
    image: alpine:3.20
    command: ["sh", "-c", "test -f /data/seed || cat /proc/sys/kernel/random/uuid > /data/seed; sleep 180"]
    volumes: ["pgdata:/data"]
volumes:
  pgdata: {}
`)
	backend := dockercli.CLI{}
	cfg := dockergvisor.Config{CellID: cell, WorkDir: filepath.Join(root, "work"), BakeStateDir: filepath.Join(root, "state"), HolderImage: "alpine:3.20", HelperImage: "alpine:3.20", MemLimit: "256m", MemReady: "128m", CPUs: "1"}
	if err := os.MkdirAll(cfg.WorkDir, 0o700); err != nil {
		t.Fatal(err)
	}
	d, err := dockergvisor.New(ctx, backend, cfg)
	if err != nil {
		t.Fatal(err)
	}
	var refs []driver.MachineRef
	var networks []driver.ClaimNetwork
	t.Cleanup(func() {
		cleanup, stop := context.WithTimeout(context.Background(), 30*time.Second)
		defer stop()
		for _, ref := range refs {
			if err := d.Destroy(cleanup, ref); err != nil {
				t.Errorf("cleanup machine: %v", err)
			}
		}
		for _, network := range networks {
			if err := d.ReleaseClaim(cleanup, network); err != nil {
				t.Errorf("cleanup network: %v", err)
			}
		}
		if err := d.Close(); err != nil {
			t.Errorf("close catalog: %v", err)
		}
		vols, err := backend.Volumes(cleanup, map[string]string{"kodus.cell": cell, "kodus.org": org, "kodus.env": env})
		if err != nil {
			t.Errorf("list owned bake volumes: %v", err)
			return
		}
		for _, v := range vols {
			if err := backend.VolumeRemove(cleanup, v.Name); err != nil {
				t.Errorf("cleanup bake volume: %v", err)
			}
		}
		left, err := backend.List(cleanup, map[string]string{"kodus.cell": cell})
		if err != nil || len(left) != 0 {
			t.Errorf("owned containers remain: %d %v", len(left), err)
		}
		remainingVolumes, err := backend.Volumes(cleanup, map[string]string{"kodus.cell": cell})
		if err != nil || len(remainingVolumes) != 0 {
			t.Errorf("owned volumes remain: %d %v", len(remainingVolumes), err)
		}
		for _, network := range networks {
			labels, err := backend.NetworkLabels(cleanup, network.WorkloadGroupID)
			if err != nil || labels != nil {
				t.Errorf("owned network remains: %s %v", network.WorkloadGroupID, err)
			}
		}
	})
	claim := func(phase, image string, setup bool) driver.MachineRef {
		t.Helper()
		id := "claim-" + suffix + "-" + phase
		network, err := d.PrepareClaim(ctx, driver.ClaimNetworkSpec{CellID: cell, OrgID: org, ClaimID: id})
		if err != nil {
			t.Fatal(err)
		}
		networks = append(networks, network)
		ref, err := d.Create(ctx, driver.MachineSpec{CellID: cell, OrgID: org, EnvironmentID: env, ClaimID: id, Role: driver.RoleWorkload, ImageID: image, Setup: setup, ClaimGroupID: network.WorkloadGroupID, KMSKeyRef: "synthetic", ExpiresAt: time.Now().Add(3 * time.Minute), HardExpiresAt: time.Now().Add(5 * time.Minute)})
		if err != nil {
			t.Fatal(err)
		}
		refs = append(refs, ref)
		if _, err := d.Up(ctx, ref, compose, project); err != nil {
			t.Fatal(err)
		}
		return ref
	}
	seed := func(ref driver.MachineRef) string {
		t.Helper()
		for range 50 {
			out, err := exec.CommandContext(ctx, "docker", "exec", ref.MachineID+"-db-1", "cat", "/data/seed").Output()
			if value := strings.TrimSpace(string(out)); err == nil && value != "" {
				return value
			}
			select {
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			case <-time.After(100 * time.Millisecond):
			}
		}
		t.Fatal("seed did not become ready")
		return ""
	}
	bake := func(ref driver.MachineRef) driver.ImageRef {
		t.Helper()
		if err := d.PinBakeSource(ref); err != nil {
			t.Fatal(err)
		}
		if err := d.Destroy(ctx, ref); err != nil {
			t.Fatal(err)
		}
		image, err := d.Bake(ctx, driver.BakeSpec{CellID: cell, OrgID: org, EnvironmentID: env, SHA: strings.Repeat("a", 40), RecipeSHA: "synthetic-recipe", Source: ref})
		if err != nil {
			t.Fatal(err)
		}
		if err := d.AcknowledgeBake(ctx, image.ImageID); err != nil {
			t.Fatal(err)
		}
		return image
	}
	first := claim("setup-one", "setup", true)
	seedOne := seed(first)
	one := bake(first)
	old := claim("old", one.ImageID, false)
	if got := seed(old); got != seedOne {
		t.Fatalf("first generation lost seed: %s", got)
	}
	second := claim("setup-two", "setup", true)
	seedTwo := seed(second)
	if seedTwo == seedOne {
		t.Fatal("clean setup inherited the previous seed")
	}
	two := bake(second)
	if one.ImageID == two.ImageID {
		t.Fatal("same-SHA bakes shared an identity")
	}
	if err := d.Reset(ctx, old, driver.SnapshotRef{Kind: "compose_volumes"}); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Up(ctx, old, compose, project); err != nil {
		t.Fatal(err)
	}
	if got := seed(old); got != seedOne {
		t.Fatal("active old generation was pruned or substituted")
	}
	for _, ref := range refs {
		if err := d.Destroy(ctx, ref); err != nil {
			t.Fatal(err)
		}
	}
	for _, network := range networks {
		if err := d.ReleaseClaim(ctx, network); err != nil {
			t.Fatal(err)
		}
	}
	if err := d.AcknowledgeBake(ctx, two.ImageID); err != nil {
		t.Fatal(err)
	}
	if err := d.Close(); err != nil {
		t.Fatal(err)
	}
	restarted, err := dockergvisor.New(ctx, backend, cfg)
	if err != nil {
		t.Fatal(err)
	}
	d = restarted
	recovered, err := d.RecoverBakes(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(recovered) != 1 || recovered[0].ImageID != two.ImageID || !recovered[0].Current {
		t.Fatalf("recovered unexpected generations: %+v", recovered)
	}
	current := claim("recovered", two.ImageID, false)
	if got := seed(current); got != seedTwo {
		t.Fatal("recovered generation did not restore its own data")
	}
	t.Logf("scope=%s sameShaDistinct=true oldClaimReset=true catalogRestart=true restoredSeed=true", cell)
}
