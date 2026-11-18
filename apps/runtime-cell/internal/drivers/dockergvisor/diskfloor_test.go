package dockergvisor

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/clock"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose/sandbox"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver/drivertest"
)

// R3-03/F1-01: what a build writes into its BuildKit state view is measured
// by no image bound, and nothing admitted a claim against the free disk: one
// claim's RUN step brought the disk to the watchdog's floor, which stops every
// claim of the cell. Now a running build is stopped, as the claim's own
// disk_capacity, once the disk is under a margin of one floor above it.
func TestABuildIsStoppedOnceTheDiskIsUnderTheMarginAboveTheFloor(t *testing.T) {
	d, docker := bakeDriver(t)
	d.cfg.DiskMinFreeBytes = 5 << 30
	var free atomic.Int64
	free.Store(100 << 30)
	d.hooksForTest().freeBytes = func(string) (int64, error) { return free.Load(), nil }
	d.hooksForTest().buildDiskEvery = 10 * time.Millisecond
	// The build writes nothing the image bound sees; the disk fills anyway
	// (its state view, under the work directory).
	f := &fillingBuilder{memDocker: docker, fill: func(b dockercli.BuildRun) string {
		free.Store(9 << 30)
		return filepath.Join(b.Out, "small")
	}}
	d.d = f
	_, _, err := d.runBuild(context.Background(), machine("claim-fill", bakeEnv), sandbox.Build{Service: "api", Context: project(t), Dockerfile: "Dockerfile"}, "kodus-build/m-api:claim", "net", "resolv", bakeSubnet, nil)
	if !errors.Is(err, driver.ErrDiskCapacity) || !f.stopped {
		t.Fatalf("err %v, stopped while it ran %v", err, f.stopped)
	}
}

// A claim is not created on a disk under the margin: microvm refused one its
// disk could not hold, docker-gvisor admitted every claim.
func TestAWorkloadIsNotCreatedOnADiskUnderTheMargin(t *testing.T) {
	docker := newMemDocker()
	d, err := New(context.Background(), docker, Config{CellID: "cell-1", HolderImage: "kodus/holder@sha256:abc", WorkDir: t.TempDir(), DiskMinFreeBytes: 5 << 30})
	if err != nil {
		t.Fatal(err)
	}
	free := int64(9 << 30)
	d.hooksForTest().freeBytes = func(string) (int64, error) { return free, nil }
	ctx := context.Background()
	n, err := d.PrepareClaim(ctx, driver.ClaimNetworkSpec{CellID: "cell-1", OrgID: "org-a", ClaimID: "claim-1"})
	if err != nil {
		t.Fatal(err)
	}
	spec := drivertest.BaseSpec("cell-1", "claim-1", n)
	if _, err := d.Create(ctx, spec); !errors.Is(err, driver.ErrDiskCapacity) {
		t.Fatalf("Create on a disk under the margin: %v", err)
	}
	free = 11 << 30
	if _, err := d.Create(ctx, spec); err != nil {
		t.Fatalf("Create with room: %v", err)
	}
}

// rootCounting is a daemon whose data root is root (an error when empty),
// counting the docker info calls that read it.
type rootCounting struct {
	*memDocker
	root  string
	calls atomic.Int32
}

func (r *rootCounting) DataRoot(context.Context) (string, error) {
	r.calls.Add(1)
	if r.root == "" {
		return "", errors.New("no data root")
	}
	return r.root, nil
}

// The margin is checked every 2 s of every running build and on every
// Create: Docker's data root is read once, not with a docker info each time
// (N2). A daemon that does not answer is asked again only a minute later.
func TestTheMarginReadsDockersDataRootOnce(t *testing.T) {
	d, docker := bakeDriver(t)
	d.cfg.DiskMinFreeBytes = 5 << 30
	clk := clock.NewFake(time.Now())
	d.clock = clk
	var read []string
	d.hooksForTest().freeBytes = func(p string) (int64, error) { read = append(read, p); return 100 << 30, nil }
	daemon := &rootCounting{memDocker: docker, root: t.TempDir()}
	d.d = daemon
	ctx := context.Background()
	for range 5 {
		if err := d.diskShort(ctx); err != nil {
			t.Fatal(err)
		}
	}
	if n := daemon.calls.Load(); n != 1 {
		t.Fatalf("docker info ran %d times for 5 checks", n)
	}
	if read[len(read)-1] != daemon.root {
		t.Fatalf("Docker's disk was not measured: %v", read)
	}

	d2, docker2 := bakeDriver(t)
	d2.cfg.DiskMinFreeBytes = 5 << 30
	d2.clock = clk
	d2.hooksForTest().freeBytes = func(string) (int64, error) { return 100 << 30, nil }
	down := &rootCounting{memDocker: docker2}
	d2.d = down
	for range 5 {
		_ = d2.diskShort(ctx)
	}
	clk.Advance(2 * time.Minute)
	_ = d2.diskShort(ctx)
	if n := down.calls.Load(); n != 2 {
		t.Fatalf("a daemon without a data root was asked %d times, want once and once more after a minute", n)
	}
}

// R3-03: what each claim of the cell holds on Docker's disk, its writable
// layers and its volumes, a compose volume found by its project's claim.
// Another cell's claims are not this cell's to stop.
func TestClaimDiskUsageCountsEachClaimsVolumesAndLayers(t *testing.T) {
	d, docker := bakeDriver(t)
	cell, claim := dockercli.LabelFromTag(driver.TagCell), dockercli.LabelFromTag(driver.TagClaim)
	docker.diskUsage = dockercli.DiskUsage{
		Containers: []dockercli.DiskUser{
			{Labels: map[string]string{cell: "cell-1", claim: "claim-a", composeProjectLabel: "m-a"}, Bytes: 10},
			{Labels: map[string]string{cell: "cell-2", claim: "claim-x", composeProjectLabel: "m-x"}, Bytes: 1 << 40},
		},
		Volumes: []dockercli.DiskUser{
			{Labels: map[string]string{composeProjectLabel: "m-a"}, Bytes: 1000},
			{Labels: map[string]string{cell: "cell-1", claim: "claim-b"}, Bytes: 500},
			{Labels: map[string]string{composeProjectLabel: "m-x"}, Bytes: 1 << 40},
			{Labels: map[string]string{}, Bytes: 7},
		},
	}
	got, err := d.ClaimDiskUsage(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got["claim-a"] != 1010 || got["claim-b"] != 500 {
		t.Fatalf("usage %v", got)
	}
}

// pressureBuilder runs two builds at once: the one of claim-big writes into
// its output once both run, the other writes nothing. Each runs until it
// is stopped or released.
type pressureBuilder struct {
	*memDocker
	both    sync.WaitGroup
	release chan struct{}
	mu      sync.Mutex
	stopped map[string]bool
}

func (p *pressureBuilder) RunBuild(ctx context.Context, b dockercli.BuildRun) error {
	if err := p.memDocker.RunBuild(ctx, b); err != nil {
		return err
	}
	p.both.Done()
	p.both.Wait()
	if strings.Contains(b.Out, "claim-big") {
		if err := os.WriteFile(filepath.Join(b.Out, "fill"), make([]byte, 1<<20), 0o600); err != nil {
			return err
		}
	}
	select {
	case <-ctx.Done():
		p.mu.Lock()
		p.stopped[b.Out] = true
		p.mu.Unlock()
		return ctx.Err()
	case <-p.release:
		return nil
	}
}

// F1-01: under the margin every running build stopped itself, the claims
// that wrote nothing with the one that filled the disk. Now the build that
// wrote the most is stopped, one at a time, and the others run on.
func TestUnderTheMarginOnlyTheBuildThatWroteTheMostIsStopped(t *testing.T) {
	d, docker := bakeDriver(t)
	d.cfg.DiskMinFreeBytes = 5 << 30
	d.cfg.MaxBuilds = 2
	d.hooksForTest().buildDiskEvery = 10 * time.Millisecond
	work := d.workDir()
	// The disk is short while the big build's fill is on it.
	d.hooksForTest().freeBytes = func(string) (int64, error) {
		if fills, _ := filepath.Glob(filepath.Join(work, "builds", "*claim-big*", "*", "fill")); len(fills) > 0 {
			return 9 << 30, nil
		}
		return 100 << 30, nil
	}
	p := &pressureBuilder{memDocker: docker, release: make(chan struct{}), stopped: map[string]bool{}}
	p.both.Add(2)
	d.d = p
	errs := make(chan error, 2)
	for _, claim := range []string{"claim-big", "claim-small"} {
		go func() {
			_, _, err := d.runBuild(context.Background(), machine(claim, bakeEnv), sandbox.Build{Service: "api", Context: project(t), Dockerfile: "Dockerfile"}, "kodus-build/m-api:"+claim, "net", "resolv", bakeSubnet, nil)
			errs <- fmt.Errorf("%s: %w", claim, err)
		}()
	}
	first := <-errs
	if !errors.Is(first, driver.ErrDiskCapacity) || !strings.HasPrefix(first.Error(), "claim-big") {
		t.Fatalf("first to end: %v, want claim-big's disk_capacity", first)
	}
	close(p.release)
	if second := <-errs; errors.Is(second, driver.ErrDiskCapacity) {
		t.Fatalf("the build that wrote nothing was stopped too: %v", second)
	}
}
