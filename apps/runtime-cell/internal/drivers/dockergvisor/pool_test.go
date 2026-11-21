package dockergvisor

import (
	"context"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
)

// A pool machine runs no project: whatever its services run (and the
// coverage they count) starts at the Up of the claim that adopts it.
func TestAPoolMachineRunsNoProjectUntilAClaimBootsIt(t *testing.T) {
	docker := newMemDocker()
	docker.plant(dockercli.Container{ID: "cegress", Name: "kodus-egress", Networks: map[string]string{"kodus-cell": "10.9.0.2"}})
	d, err := New(context.Background(), docker, Config{CellID: "cell-1", HolderImage: "kodus/holder@sha256:abc", WorkDir: t.TempDir(), EgressContainer: "kodus-egress"})
	if err != nil {
		t.Fatal(err)
	}
	s := spec()
	pm, err := d.PoolCreate(context.Background(), driver.PoolSpec{
		CellID: "cell-1", OrgID: "org-a", EnvironmentID: "env-1", ImageID: s.ImageID, KMSKeyRef: s.KMSKeyRef, Size: s.Size,
		ExpiresAt: s.ExpiresAt, HardExpiresAt: s.HardExpiresAt,
	})
	if err != nil {
		t.Fatal(err)
	}
	docker.mu.Lock()
	defer docker.mu.Unlock()
	if len(docker.ups) != 0 {
		t.Fatalf("pool machine %s ran compose up: %v", pm.Workload.MachineID, docker.ups)
	}
	for _, c := range docker.containers {
		if c.Labels["com.docker.compose.project"] != "" {
			t.Fatalf("pool machine %s has a project container %s", pm.Workload.MachineID, c.Name)
		}
	}
}
