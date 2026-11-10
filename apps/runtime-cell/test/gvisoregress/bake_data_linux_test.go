//go:build linux

package gvisoregress

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver/drivertest"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockergvisor"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/recipe"
)

// A recipe with data.reset: snapshot bakes the setup's data volumes too.
// The service seeds its volume on first start with a value no later boot
// can repeat; a later claim of the environment finds the setup's value,
// so it booted on the baked data instead of seeding its own.
func TestALaterClaimBootsOnTheSetupsBakedData(t *testing.T) {
	if os.Getenv("KODY_E2E_GVISOR") != "1" {
		t.Skip("KODY_E2E_GVISOR=1 runs it on a Linux Docker with runsc")
	}
	const cell, org, env = "cell-e2e", "org-e2e", "env-data"
	dir := t.TempDir()
	ctx := context.Background()
	t.Cleanup(func() {
		out, _ := exec.Command("docker", "volume", "ls", "-q", "--filter", "label=kodus.env="+env).Output()
		for _, v := range strings.Fields(string(out)) {
			_ = exec.Command("docker", "volume", "rm", "-f", v).Run()
		}
	})
	e := startEgress(t, dir, "kodus-egress-data")
	project := filepath.Join(dir, "checkout")
	if err := os.MkdirAll(filepath.Join(project, ".kodus"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(project, recipe.Path), []byte("version: 1\ndata: { migrate: ./migrate, reset: snapshot }\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	compose := []byte(`services:
  db:
    image: alpine:3.20
    command: ["sh", "-c", "test -f /data/seed || cat /proc/sys/kernel/random/uuid > /data/seed; sleep 300"]
    volumes: ["pgdata:/data"]
volumes:
  pgdata: {}
`)
	d, err := dockergvisor.New(ctx, dockercli.CLI{}, dockergvisor.Config{CellID: cell, HolderImage: "alpine:3.20",
		WorkDir: filepath.Join(dir, "cell"), EgressContainer: e.name})
	if err != nil {
		t.Fatal(err)
	}
	claim := func(t *testing.T, id, imageID string, setup bool) driver.MachineRef {
		t.Helper()
		n, err := d.PrepareClaim(ctx, driver.ClaimNetworkSpec{CellID: cell, OrgID: org, ClaimID: id})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = d.ReleaseClaim(context.Background(), n) })
		spec := drivertest.BaseSpec(cell, id, n)
		spec.OrgID, spec.EnvironmentID, spec.ExpiresAt, spec.HardExpiresAt = org, env, time.Now().Add(10*time.Minute), time.Now().Add(time.Hour)
		spec.ImageID, spec.Setup = imageID, setup
		ref, err := d.Create(ctx, spec)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = d.Destroy(context.Background(), ref) })
		if _, err := d.Up(ctx, ref, compose, project); err != nil {
			t.Fatalf("up %s: %v", id, err)
		}
		return ref
	}
	seed := func(t *testing.T, ref driver.MachineRef) string {
		t.Helper()
		for i := 0; i < 50; i++ {
			out, err := exec.Command("docker", "exec", ref.MachineID+"-db-1", "cat", "/data/seed").Output()
			if s := strings.TrimSpace(string(out)); err == nil && s != "" {
				return s
			}
			time.Sleep(200 * time.Millisecond)
		}
		t.Fatal("the service never seeded its volume")
		return ""
	}

	setup := claim(t, "claim-setup", "setup", true)
	seeded := seed(t, setup)
	if err := d.PinBakeSource(setup); err != nil {
		t.Fatal(err)
	}
	if err := d.Destroy(ctx, setup); err != nil {
		t.Fatal(err)
	}
	img, err := d.Bake(ctx, driver.BakeSpec{CellID: cell, OrgID: org, EnvironmentID: env, SHA: strings.Repeat("d", 40), RecipeSHA: "r", Source: setup})
	if err != nil {
		t.Fatal(err)
	}
	if out := docker(t, "volume", "ls", "-q", "--filter", "label=kodus.env="+env, "--filter", "label=kodus.bake-volume=pgdata"); len(strings.Fields(out)) != 1 {
		t.Fatalf("bake volumes: %q", out)
	}
	if out := docker(t, "volume", "ls", "-q", "--filter", "name="+setup.MachineID); out != "" {
		t.Fatalf("the setup's volumes outlived the release and the bake: %q", out)
	}

	later := claim(t, "claim-later", img.ImageID, false)
	if got := seed(t, later); got != seeded {
		t.Fatalf("the later claim seeded %q, want the setup's %q from the bake", got, seeded)
	}
}

// The pool machine is made from the bake (network, holder, the baked data
// already in its volumes); a claim adopts it, its observer joins the
// adopted network, and its project boots on the setup's data.
func TestAClaimAdoptsAPoolMachineReadyWithTheBakesData(t *testing.T) {
	if os.Getenv("KODY_E2E_GVISOR") != "1" {
		t.Skip("KODY_E2E_GVISOR=1 runs it on a Linux Docker with runsc")
	}
	const cell, org, env = "cell-e2e", "org-e2e", "env-pool"
	dir := t.TempDir()
	ctx := context.Background()
	t.Cleanup(func() {
		out, _ := exec.Command("docker", "volume", "ls", "-q", "--filter", "label=kodus.env="+env).Output()
		for _, v := range strings.Fields(string(out)) {
			_ = exec.Command("docker", "volume", "rm", "-f", v).Run()
		}
	})
	e := startEgress(t, dir, "kodus-egress-pool")
	project := filepath.Join(dir, "checkout")
	if err := os.MkdirAll(filepath.Join(project, ".kodus"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(project, recipe.Path), []byte("version: 1\ndata: { migrate: ./migrate, reset: snapshot }\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	compose := []byte(`services:
  db:
    image: alpine:3.20
    command: ["sh", "-c", "test -f /data/seed || cat /proc/sys/kernel/random/uuid > /data/seed; sleep 300"]
    volumes: ["pgdata:/data"]
volumes:
  pgdata: {}
`)
	d, err := dockergvisor.New(ctx, dockercli.CLI{}, dockergvisor.Config{CellID: cell, HolderImage: "alpine:3.20",
		WorkDir: filepath.Join(dir, "cell"), EgressContainer: e.name})
	if err != nil {
		t.Fatal(err)
	}
	seed := func(t *testing.T, machine string) string {
		t.Helper()
		for i := 0; i < 50; i++ {
			out, err := exec.Command("docker", "exec", machine+"-db-1", "cat", "/data/seed").Output()
			if s := strings.TrimSpace(string(out)); err == nil && s != "" {
				return s
			}
			time.Sleep(200 * time.Millisecond)
		}
		t.Fatal("the service never seeded its volume")
		return ""
	}

	// The setup, baked.
	n, err := d.PrepareClaim(ctx, driver.ClaimNetworkSpec{CellID: cell, OrgID: org, ClaimID: "claim-setup"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.ReleaseClaim(context.Background(), n) })
	spec := drivertest.BaseSpec(cell, "claim-setup", n)
	spec.OrgID, spec.EnvironmentID, spec.ExpiresAt, spec.HardExpiresAt = org, env, time.Now().Add(10*time.Minute), time.Now().Add(time.Hour)
	spec.Setup = true
	setup, err := d.Create(ctx, spec)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := d.Up(ctx, setup, compose, project); err != nil {
		t.Fatal(err)
	}
	seeded := seed(t, setup.MachineID)
	if err := d.PinBakeSource(setup); err != nil {
		t.Fatal(err)
	}
	if err := d.Destroy(ctx, setup); err != nil {
		t.Fatal(err)
	}
	img, err := d.Bake(ctx, driver.BakeSpec{CellID: cell, OrgID: org, EnvironmentID: env, SHA: strings.Repeat("e", 40), RecipeSHA: "r", Source: setup})
	if err != nil {
		t.Fatal(err)
	}

	// The pool machine: the bake's data is in its volume before any claim.
	start := time.Now()
	pm, err := d.PoolCreate(ctx, driver.PoolSpec{CellID: cell, OrgID: org, EnvironmentID: env, ImageID: img.ImageID, KMSKeyRef: "k",
		Size: driver.MachineSize{CPU: 2, MemoryGB: 4, DiskGB: 20}, ExpiresAt: time.Now().Add(time.Hour), HardExpiresAt: time.Now().Add(2 * time.Hour)})
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("pool machine ready in %s", time.Since(start).Round(time.Millisecond))
	t.Cleanup(func() {
		_ = d.Destroy(context.Background(), pm.Workload)
		_ = d.ReleaseClaim(context.Background(), pm.Network)
	})
	if out := docker(t, "volume", "ls", "-q", "--filter", "label=com.docker.compose.project="+pm.Workload.MachineID); !strings.Contains(out, pm.Workload.MachineID+"_pgdata") {
		t.Fatalf("the pool machine has no baked data: %q", out)
	}

	// A claim adopts it; its observer joins the adopted network.
	if err := d.Adopt(ctx, pm, "claim-adopt"); err != nil {
		t.Fatal(err)
	}
	obs := drivertest.BaseSpec(cell, "claim-adopt", pm.Network)
	obs.Role, obs.OrgID, obs.EnvironmentID, obs.ExpiresAt, obs.HardExpiresAt = driver.RoleObserver, org, env, time.Now().Add(10*time.Minute), time.Now().Add(time.Hour)
	observer, err := d.Create(ctx, obs)
	if err != nil {
		t.Fatalf("the adopted network refused the claim's observer: %v", err)
	}
	t.Cleanup(func() { _ = d.Destroy(context.Background(), observer) })
	start = time.Now()
	if _, err := d.Up(ctx, pm.Workload, compose, project); err != nil {
		t.Fatal(err)
	}
	t.Logf("adopted up %s", time.Since(start).Round(time.Millisecond))
	if got := seed(t, pm.Workload.MachineID); got != seeded {
		t.Fatalf("the adopted machine seeded %q, want the setup's %q", got, seeded)
	}

	// Released, nothing of it is left.
	if err := d.Destroy(ctx, observer); err != nil {
		t.Fatal(err)
	}
	if err := d.Destroy(ctx, pm.Workload); err != nil {
		t.Fatal(err)
	}
	if err := d.ReleaseClaim(ctx, pm.Network); err != nil {
		t.Fatal(err)
	}
	if out := docker(t, "volume", "ls", "-q", "--filter", "label=com.docker.compose.project="+pm.Workload.MachineID); out != "" {
		t.Fatalf("the adopted machine's volumes outlived it: %q", out)
	}
}
