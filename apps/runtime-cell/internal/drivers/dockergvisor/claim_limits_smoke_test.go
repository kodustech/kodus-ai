//go:build linux && dockersmoke

package dockergvisor

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/claimlimits"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockercli"
)

// TestSmokeClaimLimitsDockerAttachment only targets an explicitly identified,
// task-owned daemon and delegated cgroup root. The supervisor owns daemon/root
// provisioning. This test never pulls an image or changes daemon configuration.
// Kernel pressure is proved separately by claimlimits.TestKernelCeilings.
func TestSmokeClaimLimitsDockerAttachment(t *testing.T) {
	root := os.Getenv("KODY_CGROUP_TEST_ROOT")
	image := os.Getenv("KODY_CGROUP_DOCKER_IMAGE")
	expectedID := os.Getenv("KODY_CGROUP_DOCKER_ID")
	host := os.Getenv("DOCKER_HOST")
	if root == "" && image == "" && expectedID == "" {
		t.Skip("requires a task-owned cgroupfs daemon and delegated root")
	}
	if root == "" || expectedID == "" || !digestRef.MatchString(image) {
		t.Fatal("explicit delegated root, private daemon ID and pinned local image required")
	}
	if os.Getenv("DOCKER_CONTEXT") != "" || !strings.HasPrefix(host, "unix:///") {
		t.Fatal("explicit local unix DOCKER_HOST without DOCKER_CONTEXT required")
	}
	socket := strings.TrimPrefix(host, "unix://")
	if filepath.Clean(socket) != socket || socket == "/var/run/docker.sock" || socket == "/run/docker.sock" {
		t.Fatal("refusing default or ambiguous daemon socket")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	cli := dockercli.CLI{}
	info, err := cli.CgroupInfo(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if info.ID != expectedID || info.Driver != "cgroupfs" || info.Version != "2" || info.Rootless {
		t.Fatal("private daemon identity or cgroup capabilities mismatch")
	}
	if _, err := dockercli.ExecCommand(ctx, nil, "docker", "image", "inspect", image); err != nil {
		t.Fatalf("pinned image must already exist in private daemon: %v", err)
	}

	work := t.TempDir()
	// Holder-only fixtures do not boot compose, but production Destroy invokes
	// compose down. Supply its own inert config rather than discover repo files.
	compose := filepath.Join(work, "compose.yaml")
	if err := os.WriteFile(compose, []byte("services:\n  inert:\n    image: "+image+"\n    command: ['true']\n"), 0600); err != nil {
		t.Fatal(err)
	}
	env := append(dockercli.MinimalEnv(), "COMPOSE_FILE="+compose)
	cli.Run = dockercli.ExecCommandWith(env)
	limits, err := claimlimits.New(root)
	if err != nil {
		t.Fatal(err)
	}
	defer limits.Close()
	random := make([]byte, 8)
	if _, err := rand.Read(random); err != nil {
		t.Fatal(err)
	}
	suffix := hex.EncodeToString(random)
	cell, claim, org := "cg-cell-"+suffix, "cg-claim-"+suffix, "cg-org-"+suffix
	d, err := New(ctx, cli, Config{CellID: cell, Runtime: "runsc", HolderImage: image, WorkDir: work, MemLimit: "256m", CPUs: "0.5", PidsLimit: 128, ClaimLimits: limits})
	if err != nil {
		t.Fatal(err)
	}
	n, err := d.PrepareClaim(ctx, driver.ClaimNetworkSpec{CellID: cell, OrgID: org, ClaimID: claim})
	if err != nil {
		t.Fatal(err)
	}
	key := resourceKey(cell, org, n.WorkloadGroupID)
	groupPath := filepath.Join(root, key)
	var machines []driver.MachineRef
	cleaned := false
	cleanup := func() error {
		cctx, ccancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer ccancel()
		var errs []error
		for i := len(machines) - 1; i >= 0; i-- {
			if err := d.Destroy(cctx, machines[i]); err != nil {
				errs = append(errs, err)
			}
		}
		if err := d.ReleaseClaim(cctx, n); err != nil {
			errs = append(errs, err)
		}
		return errors.Join(errs...)
	}
	defer func() {
		if !cleaned {
			if err := cleanup(); err != nil {
				t.Error(err)
			}
		}
	}()
	now := time.Now().UTC()
	for _, role := range []driver.Role{driver.RoleWorkload, driver.RoleObserver} {
		ref, err := d.Create(ctx, driver.MachineSpec{CellID: cell, EnvironmentID: "owned-cgroup-smoke", OrgID: org, ClaimID: claim, ImageID: "owned-cgroup-image", Role: role, ClaimGroupID: n.WorkloadGroupID, KMSKeyRef: "local-test", ExpiresAt: now.Add(2 * time.Minute), HardExpiresAt: now.Add(3 * time.Minute)})
		if err != nil {
			t.Fatal(err)
		}
		machines = append(machines, ref)
	}
	var parent string
	for _, ref := range machines {
		containers, err := cli.Inspect(ctx, ref.MachineID)
		if err != nil || len(containers) != 1 {
			t.Fatalf("inspect holder: %v count=%d", err, len(containers))
		}
		c := containers[0]
		if c.PID <= 0 || c.Labels["kodus.cell"] != cell || c.Labels["kodus.org"] != org || c.Labels[labelLimitKey] != key {
			t.Fatal("holder identity/membership missing")
		}
		expectedParent := strings.TrimPrefix(root, "/sys/fs/cgroup") + "/" + key
		if c.CgroupParent != expectedParent {
			t.Fatalf("wrong aggregate parent %q", c.CgroupParent)
		}
		if parent != "" && parent != c.CgroupParent {
			t.Fatal("holders have different parents")
		}
		parent = c.CgroupParent
		if err := limits.Verify(key, c.PID); err != nil {
			t.Fatal(err)
		}
		t.Logf("holder=%s role=%s pid=%d parent=%s", ref.MachineID, ref.Tags[driver.TagRole], c.PID, c.CgroupParent)
	}
	for name, want := range map[string]string{"memory.max": "268435456", "memory.swap.max": "0", "cpu.max": "50000 100000", "pids.max": "128"} {
		value, err := os.ReadFile(filepath.Join(groupPath, name))
		if err != nil {
			t.Fatal(err)
		}
		if strings.Join(strings.Fields(string(value)), " ") != want {
			t.Fatalf("kernel %s=%q want %q", name, value, want)
		}
	}
	if err := cleanup(); err != nil {
		t.Fatal(err)
	}
	cleaned = true
	if _, err := os.Stat(groupPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("parent remains after release: %v", err)
	}
	labels, err := cli.NetworkLabels(ctx, n.WorkloadGroupID)
	if err != nil || labels != nil {
		t.Fatalf("network remains after release: %v", err)
	}
	if cs, err := cli.List(ctx, map[string]string{"kodus.cell": cell}); err != nil || len(cs) != 0 {
		t.Fatalf("containers remain: %v count=%d", err, len(cs))
	}
	t.Log("verified two real runsc holders under one 256MiB/.5CPU/128-host-task parent; parent/network/containers cleaned")
}
