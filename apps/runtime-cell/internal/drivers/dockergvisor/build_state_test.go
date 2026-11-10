package dockergvisor

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/clock"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose/sandbox"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockergvisor/buildstate"
)

// The store's own rules (who may hold a state, eviction order, leftover
// overlays) are tested in buildstate. Here: what the driver's build path and
// sweep do with it.

type fakeMounter struct {
	mounts   map[string]string // target -> lower
	unmounts []string
	fail     error
}

func (f *fakeMounter) Overlay(lower, upper, work, target string) error {
	if f.fail != nil {
		return f.fail
	}
	if f.mounts == nil {
		f.mounts = map[string]string{}
	}
	f.mounts[target] = lower
	return nil
}

func (f *fakeMounter) Unmount(target string) error {
	f.unmounts = append(f.unmounts, target)
	delete(f.mounts, target)
	return nil
}

func (f *fakeMounter) Mounted(under string) ([]buildstate.OverlayMount, error) {
	var out []buildstate.OverlayMount
	for target, lower := range f.mounts {
		if strings.HasPrefix(target, under+"/") {
			out = append(out, buildstate.OverlayMount{Target: target, Lower: lower})
		}
	}
	return out, nil
}

var stateEpoch = time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)

func statefulDriver(t *testing.T) (*Driver, *memDocker, *fakeMounter) {
	t.Helper()
	d, docker := bakeDriver(t)
	m := &fakeMounter{}
	d.cfg.PersistBuildState, d.cfg.BuildStateKeep = true, "20GB"
	d.states = testStates(t, d, m)
	return d, docker, m
}

// stateRoot is where the driver keeps the environments' BuildKit states.
func stateRoot(d *Driver) string { return filepath.Join(d.workDir(), "buildkit") }

// testStates is the driver's store with a fake mounter, a fake clock and
// all the disk free, unless an option says otherwise.
func testStates(t *testing.T, d *Driver, m buildstate.Mounter, opts ...func(*buildstate.Config)) *buildstate.Store {
	t.Helper()
	cfg := buildstate.Config{
		Root: stateRoot(d), CellID: d.cfg.CellID, BuilderDir: d.dirs.builderDir, Mounter: m,
		FreeBytes: func(string) (int64, error) { return 1 << 40, nil }, Clock: clock.NewFake(stateEpoch), Log: d.log(),
	}
	for _, opt := range opts {
		opt(&cfg)
	}
	st, err := buildstate.New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	return st
}

// useAt makes env's state used last at time at of the store's clock.
func useAt(t *testing.T, st *buildstate.Store, clk *clock.Fake, env string, at time.Time) {
	t.Helper()
	clk.Set(at)
	req := seed("m-" + env)
	req.Env = env
	s, ok := st.Acquire(context.Background(), req)
	if !ok {
		t.Fatalf("seed of %s refused", env)
	}
	st.Release(s)
}

func states(d *Driver) *buildstate.Store { return d.states.(*buildstate.Store) }

func pr(machine string) buildstate.Request {
	return buildstate.Request{Machine: machine, Service: "api", Org: bakeOrg, Env: bakeEnv}
}

func seed(machine string) buildstate.Request {
	r := pr(machine)
	r.Seeds = true
	return r
}

// The default branch's setup writes the environment's state; a pull request
// reads it through an overlay that is dropped when its build ends, so the
// state never holds what a pull request wrote (S-52).
func TestTheBuildStateGoesFromTheSetupToPullRequestsOnly(t *testing.T) {
	d, docker, m := statefulDriver(t)
	build := sandbox.Build{Service: "api", Context: project(t), Dockerfile: "Dockerfile"}
	env := states(d).EnvDir(bakeOrg, bakeEnv)

	setup := machine("claim-setup", bakeEnv)
	asSetup(d, setup, true)
	boot(t, d, setup, build)
	got := docker.builds[len(docker.builds)-1]
	if got.StateDir != env || got.CacheTo != "" || got.CacheFrom != "" || got.GCKeepStorage != "20GB" {
		t.Fatalf("seeding setup: state %q cache from %q to %q keep %q", got.StateDir, got.CacheFrom, got.CacheTo, got.GCKeepStorage)
	}

	pr := machine("claim-pr", bakeEnv)
	d.machineLocked(pr.MachineID).seeds = true // never set without Setup; even so, it reads only
	boot(t, d, pr, build)
	got = docker.builds[len(docker.builds)-1]
	if got.StateDir == env || got.StateDir == "" {
		t.Fatalf("a PR build mounted %q, want an overlay of the environment's state", got.StateDir)
	}
	if len(m.unmounts) != 1 || m.unmounts[0] != got.StateDir || len(m.mounts) != 0 {
		t.Fatalf("the PR's overlay outlived its build: mounts %v unmounts %v", m.mounts, m.unmounts)
	}
	if _, err := os.Stat(filepath.Dir(got.StateDir)); !os.IsNotExist(err) {
		t.Fatal("the PR's upper layer was kept")
	}

	// Another environment never reads this one's state.
	other := machine("claim-other", "env-2")
	boot(t, d, other, build)
	if s := docker.builds[len(docker.builds)-1].StateDir; s != "" {
		t.Fatalf("another environment mounted %q", s)
	}
}

// A cell that cannot mount an overlay, or with the feature off, builds as before.
func TestNoOverlayNoState(t *testing.T) {
	d, docker, m := statefulDriver(t)
	if err := d.dirs.builderDir(states(d).EnvDir(bakeOrg, bakeEnv)); err != nil {
		t.Fatal(err)
	}
	m.fail = errors.New("operation not permitted")
	boot(t, d, machine("claim-pr", bakeEnv), sandbox.Build{Service: "api", Context: project(t), Dockerfile: "Dockerfile"})
	if s := docker.builds[len(docker.builds)-1].StateDir; s != "" {
		t.Fatalf("mounted %q without an overlay", s)
	}
	off, _ := bakeDriver(t)
	if _, ok := off.states.Acquire(context.Background(), seed("m")); ok {
		t.Fatal("a state with the feature off")
	}
}

// Under the disk floor, the cell's sweep removes the least recently used
// states nobody holds first.
func TestStatesAreEvictedLeastRecentlyUsedFirst(t *testing.T) {
	d, _, m := statefulDriver(t)
	clk := clock.NewFake(stateEpoch)
	evictions := 0
	st := testStates(t, d, m, func(c *buildstate.Config) {
		c.MinFree, c.Clock = 100, clk
		c.FreeBytes = func(string) (int64, error) {
			if evictions++; evictions > 2 {
				return 1000, nil // one state gone: above the floor
			}
			return 10, nil
		}
	})
	d.states = st
	base := clk.Now()
	old, mid, held := st.EnvDir(bakeOrg, "env-old"), st.EnvDir(bakeOrg, "env-mid"), st.EnvDir(bakeOrg, "env-held")
	// The held one is the oldest of all; it is skipped.
	useAt(t, st, clk, "env-held", base.Add(-100*time.Hour))
	useAt(t, st, clk, "env-old", base.Add(-10*time.Hour))
	useAt(t, st, clk, "env-mid", base.Add(-9*time.Hour))
	req := pr("m-held")
	req.Env = "env-held"
	clk.Set(base.Add(-100 * time.Hour)) // the reader's touch keeps it the oldest
	h, ok := st.Acquire(context.Background(), req)
	if !ok {
		t.Fatal("reader refused")
	}
	defer st.Release(h)
	if _, err := d.Sweep(context.Background(), base); err != nil {
		t.Fatal(err)
	}
	d.reclaim.wait()
	if _, err := os.Stat(old); !os.IsNotExist(err) {
		t.Fatal("the least recently used free state was kept")
	}
	for _, dir := range []string{mid, held} {
		if _, err := os.Stat(dir); err != nil {
			t.Fatalf("%s was evicted: %v", filepath.Base(dir), err)
		}
	}
	if entries, _ := os.ReadDir(filepath.Join(stateRoot(d), "trash")); len(entries) != 0 {
		t.Fatalf("the evicted state's bytes were left in the trash: %v", entries)
	}
}

// A build's acquire never evicts, even below the floor: removing a state is
// proportional to its size, and it is the sweep's, not the build's.
func TestAcquireLeavesEvictionToTheSweep(t *testing.T) {
	d, _, m := statefulDriver(t)
	st := testStates(t, d, m, func(c *buildstate.Config) {
		c.MinFree, c.FreeBytes = 100, func(string) (int64, error) { return 10, nil }
	})
	d.states = st
	other := st.EnvDir(bakeOrg, "env-other")
	if err := d.dirs.builderDir(other); err != nil {
		t.Fatal(err)
	}
	s, ok := st.Acquire(context.Background(), seed("m-setup"))
	if !ok {
		t.Fatal("seed refused")
	}
	st.Release(s)
	if _, err := os.Stat(other); err != nil {
		t.Fatalf("an acquire evicted another environment's state: %v", err)
	}
	// What a crashed sweep left in the trash goes with the next one.
	left := filepath.Join(stateRoot(d), "trash", "leftover")
	if err := os.MkdirAll(filepath.Join(left, "snapshots"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := d.ReclaimDisk(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(left); !os.IsNotExist(err) {
		t.Fatal("the sweep left a half-removed state")
	}
}
