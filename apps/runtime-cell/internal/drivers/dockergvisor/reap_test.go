package dockergvisor

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver/drivertest"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/reaper"
)

var reapNow = time.Date(2026, 11, 7, 12, 0, 0, 0, time.UTC)

// reapFixture is one cell on a daemon in memory: claim-1 (a workload with a
// compose project, a volume, a built image and build directories, and an
// observer) past its ceiling at reapNow, claim-2 alive, and another cell's
// holder, project and network on the same daemon.
type reapFixture struct {
	docker   *memDocker
	work     string
	expired  []driver.MachineRef
	live     driver.MachineRef
	net1     driver.ClaimNetwork
	net2     driver.ClaimNetwork
	foreign  string
	foreignN string
}

func newReapFixture(t *testing.T) (*Driver, reapFixture) {
	t.Helper()
	docker := newMemDocker()
	docker.plant(dockercli.Container{ID: "cegress", Name: "kodus-egress", Networks: map[string]string{"kodus-cell": "10.9.0.2"}})
	work := t.TempDir()
	d, err := New(context.Background(), docker, Config{CellID: "cell-1", HolderImage: "kodus/holder@sha256:abc", WorkDir: work, EgressContainer: "kodus-egress"})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	f := reapFixture{docker: docker, work: work}
	claim := func(id string, hard time.Time) (driver.ClaimNetwork, []driver.MachineRef) {
		n, err := d.PrepareClaim(ctx, driver.ClaimNetworkSpec{CellID: "cell-1", OrgID: "org-a", ClaimID: id})
		if err != nil {
			t.Fatal(err)
		}
		var refs []driver.MachineRef
		for _, role := range []driver.Role{driver.RoleWorkload, driver.RoleObserver} {
			spec := drivertest.BaseSpec("cell-1", id, n)
			spec.Role, spec.ExpiresAt, spec.HardExpiresAt = role, hard.Add(-50*time.Minute), hard
			ref, err := d.Create(ctx, spec)
			if err != nil {
				t.Fatal(err)
			}
			refs = append(refs, ref)
		}
		return n, refs
	}
	f.net1, f.expired = claim("claim-1", reapNow.Add(-time.Minute))
	var live []driver.MachineRef
	f.net2, live = claim("claim-2", reapNow.Add(time.Hour))
	f.live = live[0]
	// The workload's project, as Up leaves it.
	m := f.expired[0].MachineID
	docker.plant(dockercli.Container{ID: "capp", Name: m + "-app-1", Networks: map[string]string{f.net1.WorkloadGroupID: "10.213.1.10"}, Labels: map[string]string{
		dockercli.LabelFromTag(driver.TagCell): "cell-1", dockercli.LabelFromTag(driver.TagClaim): "claim-1",
		dockercli.LabelFromTag(driver.TagHardExpires): driver.FormatTime(reapNow.Add(-time.Minute)),
		composeProjectLabel:                           m, "com.docker.compose.service": "app",
	}})
	docker.plantVolume(m, "pgdata", "rows")
	docker.images[builtTag(m, "app")] = true
	docker.images[builtTag(f.live.MachineID, "app")] = true
	for _, dir := range []string{filepath.Join(work, "builds", m, "app"), filepath.Join(work, "cache", "machine", m, "app"), filepath.Join(work, "buildkit", "machine", m, "app"), filepath.Join(work, "decoy")} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(decoyPath(work, m), []byte("decoy"), 0o644); err != nil {
		t.Fatal(err)
	}
	// Another cell on the same daemon, long past its ceiling.
	f.foreign, f.foreignN = "kodus-claim-9-workload", networkName("claim-9")
	foreignLabels := map[string]string{dockercli.LabelFromTag(driver.TagCell): "cell-2", dockercli.LabelFromTag(driver.TagClaim): "claim-9",
		dockercli.LabelFromTag(driver.TagHardExpires): driver.FormatTime(reapNow.Add(-24 * time.Hour))}
	_ = docker.NetworkCreate(ctx, dockercli.NetworkSpec{Name: f.foreignN, Labels: foreignLabels})
	holder := map[string]string{labelMachine: f.foreign}
	for k, v := range foreignLabels {
		holder[k] = v
	}
	docker.plant(dockercli.Container{ID: "cforeign", Name: f.foreign, Labels: holder, Networks: map[string]string{f.foreignN: "10.213.9.130"}})
	docker.plantVolume(f.foreign, "pgdata", "theirs")
	return d, f
}

func newTestReaper(t *testing.T, f reapFixture) *Reaper {
	t.Helper()
	rp, err := NewForReaper(f.docker, ReaperConfig{CellID: "cell-1", WorkDir: f.work, EgressContainer: "kodus-egress"})
	if err != nil {
		t.Fatal(err)
	}
	rp.mounted = func(string) ([]overlayMount, error) { return nil, nil }
	return rp
}

// S-08 on docker-gvisor: with the cell agent gone (only Docker and the work
// directory are read), the reaper takes a machine past kodus:hard-expires
// down with everything it holds, and leaves a live claim and another cell
// alone. Before it, cmd/reaper had no docker-gvisor driver at all, and the
// cell's own sweep removed only containers (volumes, images, build
// directories and the claim network stayed).
func TestS08ReaperDestroysEverythingOfAMachinePastItsCeiling(t *testing.T) {
	_, f := newReapFixture(t)
	r := &reaper.Reaper{CellID: "cell-1", Driver: newTestReaper(t, f), Now: func() time.Time { return reapNow }}
	rep, err := r.Run(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(rep.Terminated) != 2 {
		t.Fatalf("terminated %v", rep.Terminated)
	}
	docker := f.docker
	m := f.expired[0].MachineID
	for _, ref := range f.expired {
		if _, ok := docker.containers[ref.MachineID]; ok {
			t.Fatalf("holder %s kept", ref.MachineID)
		}
	}
	if _, ok := docker.containers[m+"-app-1"]; ok {
		t.Fatal("project container kept")
	}
	if _, ok := docker.volume(m + "_pgdata"); ok {
		t.Fatal("project volume kept")
	}
	if docker.images[builtTag(m, "app")] {
		t.Fatal("built image kept")
	}
	for _, dir := range []string{"builds", filepath.Join("cache", "machine"), filepath.Join("buildkit", "machine")} {
		if _, err := os.Stat(filepath.Join(f.work, dir, m)); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("%s/%s kept: %v", dir, m, err)
		}
	}
	if _, err := os.Stat(decoyPath(f.work, m)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("decoy file kept: %v", err)
	}
	if _, ok := docker.networks[f.net1.WorkloadGroupID]; ok {
		t.Fatal("claim network kept")
	}
	if _, on := docker.containers["kodus-egress"].Networks[f.net1.WorkloadGroupID]; on {
		t.Fatal("egress still on the removed network")
	}
	if _, err := os.Stat(filepath.Join(f.work, "resolv", f.net1.WorkloadGroupID+".conf")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("resolv.conf kept: %v", err)
	}
	// The live claim and the other cell are untouched.
	if _, ok := docker.containers[f.live.MachineID]; !ok || !docker.images[builtTag(f.live.MachineID, "app")] {
		t.Fatal("live claim touched")
	}
	if _, ok := docker.networks[f.net2.WorkloadGroupID]; !ok {
		t.Fatal("live claim network removed")
	}
	if _, ok := docker.containers[f.foreign]; !ok {
		t.Fatal("another cell's holder removed")
	}
	if _, ok := docker.volume(f.foreign + "_pgdata"); !ok {
		t.Fatal("another cell's volume removed")
	}
	if _, ok := docker.networks[f.foreignN]; !ok {
		t.Fatal("another cell's network removed")
	}
	// A second pass finds nothing more to do.
	if rep, err := r.Run(context.Background()); err != nil || len(rep.Terminated) != 0 {
		t.Fatalf("second pass %+v %v", rep, err)
	}
}

// The reaper reads the owner from Docker, never from the ref: another
// cell's machine, or a machine whose project holds another cell's
// container, is refused whole.
func TestReaperRefusesAnotherCellsMachine(t *testing.T) {
	_, f := newReapFixture(t)
	rp := newTestReaper(t, f)
	ctx := context.Background()
	forged := driver.MachineRef{MachineID: f.foreign, Tags: map[string]string{driver.TagCell: "cell-1"}}
	if err := rp.Destroy(ctx, forged); !errors.Is(err, driver.ErrNotOwned) {
		t.Fatalf("foreign holder: %v", err)
	}
	if _, ok := f.docker.containers[f.foreign]; !ok {
		t.Fatal("foreign holder removed")
	}
	m := f.live.MachineID
	f.docker.plant(dockercli.Container{ID: "cplanted", Name: m + "-x-1", Labels: map[string]string{composeProjectLabel: m, dockercli.LabelFromTag(driver.TagCell): "cell-2"}})
	if err := rp.Destroy(ctx, f.live); !errors.Is(err, driver.ErrNotOwned) {
		t.Fatalf("mixed project: %v", err)
	}
	if _, ok := f.docker.containers[m]; !ok {
		t.Fatal("holder of a refused machine removed")
	}
	if refs, err := rp.List(ctx, map[string]string{driver.TagCell: "cell-2"}); err != nil || refs != nil {
		t.Fatalf("list for another cell: %v %v", refs, err)
	}
}

// A build state still mounted (a build of a dead cell) is left for the
// cell's recovery to unmount: removing under a live overlay would delete
// what it holds.
func TestReaperLeavesAMountedBuildState(t *testing.T) {
	_, f := newReapFixture(t)
	rp := newTestReaper(t, f)
	rp.mounted = func(under string) ([]overlayMount, error) {
		return []overlayMount{{Target: filepath.Join(under, "app", "merged")}}, nil
	}
	r := &reaper.Reaper{CellID: "cell-1", Driver: rp, Now: func() time.Time { return reapNow }}
	if _, err := r.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	m := f.expired[0].MachineID
	if _, err := os.Stat(filepath.Join(f.work, "buildkit", "machine", m)); err != nil {
		t.Fatalf("mounted state removed: %v", err)
	}
	if _, err := os.Stat(filepath.Join(f.work, "builds", m)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("build output kept")
	}
}

// The cell's own sweep takes an expired machine down as the reaper does,
// even after a restart left the driver with no memory of it: it used to
// remove its containers only, and leak the volumes, images, directories and
// the claim network (whose /24 no later claim could take).
func TestSweepExpiredAfterARestartRemovesWhatOnlyMemoryKnew(t *testing.T) {
	_, f := newReapFixture(t)
	restarted, err := New(context.Background(), f.docker, Config{CellID: "cell-1", HolderImage: "kodus/holder@sha256:abc", WorkDir: f.work, EgressContainer: "kodus-egress"})
	if err != nil {
		t.Fatal(err)
	}
	gone, err := restarted.SweepExpired(context.Background(), reapNow)
	if err != nil || len(gone) != 2 {
		t.Fatalf("%v %v", gone, err)
	}
	m := f.expired[0].MachineID
	if _, ok := f.docker.volume(m + "_pgdata"); ok {
		t.Fatal("volume kept")
	}
	if f.docker.images[builtTag(m, "app")] {
		t.Fatal("built image kept")
	}
	if _, err := os.Stat(filepath.Join(f.work, "builds", m)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("build dir kept")
	}
	if _, ok := f.docker.networks[f.net1.WorkloadGroupID]; ok {
		t.Fatal("claim network kept")
	}
	if _, ok := f.docker.containers[f.live.MachineID]; !ok {
		t.Fatal("live machine swept")
	}
	if _, ok := f.docker.containers[f.foreign]; !ok {
		t.Fatal("another cell's machine swept")
	}
}

func TestNewForReaperNeedsTheCellAndItsWorkDir(t *testing.T) {
	if _, err := NewForReaper(newMemDocker(), ReaperConfig{WorkDir: "/x"}); err == nil {
		t.Fatal("no cell id accepted")
	}
	if _, err := NewForReaper(newMemDocker(), ReaperConfig{CellID: "cell-1"}); err == nil {
		t.Fatal("no work dir accepted")
	}
}
