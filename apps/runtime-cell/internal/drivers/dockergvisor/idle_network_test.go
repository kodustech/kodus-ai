package dockergvisor

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver/drivertest"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/reaper"
)

// idleRig is a claim whose machines were destroyed without ReleaseClaim:
// what the lease sweep does after a cell restarts with live claims, a cell
// that died between PrepareClaim and Create, or a ReleaseClaim that failed
// once. It used to leave the network (the egress still on it), its
// resolv.conf and its /24 of the pool forever: the reaper and the sweep
// found networks only through containers.
type idleRig struct {
	d      *Driver
	docker *memDocker
	work   string
	net    driver.ClaimNetwork
}

func newIdleRig(t *testing.T, withMachine bool) *idleRig {
	t.Helper()
	docker := newMemDocker()
	docker.plant(dockercli.Container{ID: "cegress", Name: "kodus-egress", Networks: map[string]string{"kodus-cell": "10.9.0.2"}})
	work := t.TempDir()
	d, err := New(context.Background(), docker, Config{CellID: "cell-1", HolderImage: "kodus/holder@sha256:abc", WorkDir: work, EgressContainer: "kodus-egress"})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	n, err := d.PrepareClaim(ctx, driver.ClaimNetworkSpec{CellID: "cell-1", OrgID: "org-a", ClaimID: "claim-1"})
	if err != nil {
		t.Fatal(err)
	}
	spec := drivertest.BaseSpec("cell-1", "claim-1", n)
	spec.ExpiresAt, spec.HardExpiresAt = reapNow.Add(time.Hour), reapNow.Add(2*time.Hour)
	ref, err := d.Create(ctx, spec)
	if err != nil {
		t.Fatal(err)
	}
	if !withMachine {
		if err := d.Destroy(ctx, ref); err != nil {
			t.Fatal(err)
		}
	}
	return &idleRig{d: d, docker: docker, work: work, net: n}
}

func (r *idleRig) gone(t *testing.T) bool {
	t.Helper()
	r.docker.mu.Lock()
	_, there := r.docker.networks[r.net.WorkloadGroupID]
	r.docker.mu.Unlock()
	_, err := os.Stat(r.d.resolvPath(r.net.WorkloadGroupID))
	if there != (err == nil) {
		t.Fatalf("network there %v, resolv.conf err %v", there, err)
	}
	return !there
}

func TestTheCellsSweepReleasesAClaimNetworkNoMachineIsLeftOn(t *testing.T) {
	r := newIdleRig(t, false)
	if _, err := r.d.Sweep(context.Background(), reapNow); err != nil {
		t.Fatal(err)
	}
	if !r.gone(t) {
		t.Fatal("the claim network outlived its last machine")
	}
}

func TestTheReaperReleasesAClaimNetworkNoMachineIsLeftOn(t *testing.T) {
	r := newIdleRig(t, false)
	rp, err := NewForReaper(r.docker, ReaperConfig{CellID: "cell-1", WorkDir: r.work, EgressContainer: "kodus-egress", Now: func() time.Time { return reapNow }})
	if err != nil {
		t.Fatal(err)
	}
	rr := &reaper.Reaper{CellID: "cell-1", Driver: rp, Orphans: rp, Now: func() time.Time { return reapNow }}
	if _, err := rr.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !r.gone(t) {
		t.Fatal("the claim network outlived its last machine")
	}
}

// A claim being prepared has its network a moment before its first machine:
// a network younger than the grace stays, and so does one a machine is on.
func TestAClaimNetworkStaysWhileNewOrInUse(t *testing.T) {
	r := newIdleRig(t, false)
	r.docker.networkCreated = map[string]time.Time{r.net.WorkloadGroupID: reapNow.Add(-time.Minute)}
	if _, err := r.d.Sweep(context.Background(), reapNow); err != nil {
		t.Fatal(err)
	}
	if r.gone(t) {
		t.Fatal("a network made a minute ago was released")
	}
	used := newIdleRig(t, true)
	if _, err := used.d.Sweep(context.Background(), reapNow); err != nil {
		t.Fatal(err)
	}
	if used.gone(t) {
		t.Fatal("the network of a live machine was released")
	}
}

// R3-04: under claim limits a cell refused to start while its previous
// process's claims held their resource groups, and nothing ended them before
// their ceiling. Drain ends every machine of the cell, live ones too, and
// every claim network left with no machine, however new.
func TestDrainEndsEveryMachineAndNetworkOfTheCell(t *testing.T) {
	r := newIdleRig(t, true)
	r.docker.networkCreated = map[string]time.Time{r.net.WorkloadGroupID: reapNow}
	other := dockercli.Container{ID: "cother", Name: "kodus-other-cell", Labels: map[string]string{"kodus.cell": "cell-2"}}
	r.docker.plant(other)
	rp, err := NewForReaper(r.docker, ReaperConfig{CellID: "cell-1", WorkDir: r.work, EgressContainer: "kodus-egress", Now: func() time.Time { return reapNow }})
	if err != nil {
		t.Fatal(err)
	}
	n, err := rp.Drain(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("drained %d machines", n)
	}
	r.docker.mu.Lock()
	var left []string
	for name, c := range r.docker.containers {
		if c.Labels["kodus.cell"] == "cell-1" {
			left = append(left, name)
		}
	}
	_, otherKept := r.docker.containers[other.Name]
	r.docker.mu.Unlock()
	if len(left) != 0 || !otherKept {
		t.Fatalf("left %v, other cell's kept %v", left, otherKept)
	}
	if !r.gone(t) {
		t.Fatal("the drained claim's network is still there")
	}
}
