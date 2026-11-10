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
)

type fakeMounter struct {
	mounts      map[string]string // target -> lower
	unmounts    []string
	fail        error
	failUnmount error
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
	if f.failUnmount != nil {
		return f.failUnmount
	}
	delete(f.mounts, target)
	return nil
}

func (f *fakeMounter) Mounted(under string) ([]overlayMount, error) {
	var out []overlayMount
	for target, lower := range f.mounts {
		if strings.HasPrefix(target, under+"/") {
			out = append(out, overlayMount{Target: target, Lower: lower})
		}
	}
	return out, nil
}

func statefulDriver(t *testing.T) (*Driver, *memDocker, *fakeMounter) {
	t.Helper()
	d, docker := bakeDriver(t)
	m := &fakeMounter{}
	d.cfg.PersistBuildState, d.cfg.BuildStateKeep = true, "20GB"
	d.states = testStates(t, d, m)
	return d, docker, m
}

// testStates is the driver's store with a fake mounter, a fake clock and
// all the disk free.
func testStates(t *testing.T, d *Driver, m stateMounter) *buildStates {
	t.Helper()
	st, err := newBuildStates(buildStatesConfig{
		Root: filepath.Join(d.workDir(), "buildkit"), CellID: d.cfg.CellID, Dirs: d.dirs, Mounter: m,
		FreeBytes: func(string) (int64, error) { return 1 << 40, nil }, Clock: clock.NewFake(time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)), Log: d.log(),
	})
	if err != nil {
		t.Fatal(err)
	}
	return st
}

func fakeClock(st *buildStates) *clock.Fake { return st.clock.(*clock.Fake) }

// useAt makes env's state used last at the store's clock time at.
func useAt(t *testing.T, st *buildStates, env string, at time.Time) {
	t.Helper()
	fakeClock(st).Set(at)
	req := seed("m-" + env)
	req.Env = env
	s, ok := st.Acquire(context.Background(), req)
	if !ok {
		t.Fatalf("seed of %s refused", env)
	}
	st.Release(s)
}

func states(d *Driver) *buildStates { return d.states.(*buildStates) }

func pr(machine string) stateRequest {
	return stateRequest{Machine: machine, Service: "api", Org: bakeOrg, Env: bakeEnv}
}

func seed(machine string) stateRequest {
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
	env := states(d).envDir(bakeOrg, bakeEnv)

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

// One seeding build or any number of readers, never both: a busy state
// leaves the build on its own throwaway state and the exported cache.
func TestABusyStateFallsBackToTheExportedCache(t *testing.T) {
	d, _, _ := statefulDriver(t)
	st := states(d)
	if err := d.dirs.builderDir(st.envDir(bakeOrg, bakeEnv)); err != nil {
		t.Fatal(err)
	}
	reader, ok := st.Acquire(context.Background(), pr("m-pr"))
	if !ok || reader.mode != "overlay" {
		t.Fatalf("reader: %+v %v", reader, ok)
	}
	if _, ok := st.Acquire(context.Background(), seed("m-setup")); ok {
		t.Fatal("a seed wrote the state under a reader's overlay")
	}
	if _, ok := st.Acquire(context.Background(), pr("m-pr2")); !ok {
		t.Fatal("two readers could not share the state")
	}
	st.Release(reader)

	d2, _, _ := statefulDriver(t)
	st2 := states(d2)
	s, ok := st2.Acquire(context.Background(), seed("m-setup"))
	if !ok {
		t.Fatal("seed refused")
	}
	if _, ok := st2.Acquire(context.Background(), pr("m-pr")); ok {
		t.Fatal("a reader mounted a state being written")
	}
	st2.Release(s)
	if _, ok := st2.Acquire(context.Background(), pr("m-pr")); !ok {
		t.Fatal("the state stayed held after its seed")
	}
}

// A cell that cannot mount an overlay, or with the feature off, builds as before.
func TestNoOverlayNoState(t *testing.T) {
	d, docker, m := statefulDriver(t)
	if err := d.dirs.builderDir(states(d).envDir(bakeOrg, bakeEnv)); err != nil {
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
	d, _, _ := statefulDriver(t)
	st := states(d)
	st.minFree = 100
	base := fakeClock(st).Now()
	old, mid, held := st.envDir(bakeOrg, "env-old"), st.envDir(bakeOrg, "env-mid"), st.envDir(bakeOrg, "env-held")
	// The held one is the oldest of all; it is skipped.
	useAt(t, st, "env-held", base.Add(-100*time.Hour))
	useAt(t, st, "env-old", base.Add(-10*time.Hour))
	useAt(t, st, "env-mid", base.Add(-9*time.Hour))
	req := pr("m-held")
	req.Env = "env-held"
	fakeClock(st).Set(base.Add(-100 * time.Hour)) // the reader's touch keeps it the oldest
	h, ok := st.Acquire(context.Background(), req)
	if !ok {
		t.Fatal("reader refused")
	}
	defer st.Release(h)
	evictions := 0
	st.freeBytes = func(string) (int64, error) {
		if evictions++; evictions > 2 {
			return 1000, nil // one state gone: above the floor
		}
		return 10, nil
	}
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
	if entries, _ := os.ReadDir(filepath.Join(st.root, "trash")); len(entries) != 0 {
		t.Fatalf("the evicted state's bytes were left in the trash: %v", entries)
	}
}

// Last use is the store's clock, not the wall's: it stamped each state's
// mark with time.Now(), so a state used later on the wall but earlier on
// the cell's clock was kept and the other one evicted.
func TestEvictionOrdersStatesByTheStoresClock(t *testing.T) {
	d, _, _ := statefulDriver(t)
	st := states(d)
	st.minFree = 100
	base := fakeClock(st).Now()
	useAt(t, st, "env-recent", base.Add(time.Hour))
	useAt(t, st, "env-stale", base) // used after on the wall, before on the clock
	evictions := 0
	st.freeBytes = func(string) (int64, error) {
		if evictions++; evictions > 1 {
			return 1000, nil
		}
		return 10, nil
	}
	if err := st.Evict(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(st.envDir(bakeOrg, "env-stale")); !os.IsNotExist(err) {
		t.Fatal("the state the clock used least recently was kept")
	}
	if _, err := os.Stat(st.envDir(bakeOrg, "env-recent")); err != nil {
		t.Fatalf("the state the clock used last was evicted: %v", err)
	}
}

// A build's acquire never evicts, even below the floor: removing a state is
// proportional to its size, and it is the sweep's, not the build's.
func TestAcquireLeavesEvictionToTheSweep(t *testing.T) {
	d, _, _ := statefulDriver(t)
	st := states(d)
	st.minFree = 100
	st.freeBytes = func(string) (int64, error) { return 10, nil }
	other := st.envDir(bakeOrg, "env-other")
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
	left := filepath.Join(st.root, "trash", "leftover")
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

// heldClock is clock.Fake whose After fires only when the test sends on
// fire, and tells the test it was called: a seed's bounded wait held open
// so the test can act while the seed waits.
type heldClock struct {
	*clock.Fake
	waiting chan time.Duration
	fire    chan time.Time
}

func (c *heldClock) After(d time.Duration) <-chan time.Time {
	c.waiting <- d
	return c.fire
}

type acquired struct {
	st buildState
	ok bool
}

// A seed that finds readers waits for them and lets no new one in: a seed
// was refused whenever any reader held the state and readers were never
// refused for a seed, so steady pull request builds kept the default
// branch's setup from ever writing it.
func TestAWaitingSeedGetsTheStateBeforeNewReaders(t *testing.T) {
	d, _, _ := statefulDriver(t)
	st := states(d)
	clk := &heldClock{Fake: fakeClock(st), waiting: make(chan time.Duration, 1), fire: make(chan time.Time)}
	st.clock = clk
	if err := d.dirs.builderDir(st.envDir(bakeOrg, bakeEnv)); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	reader, ok := st.Acquire(ctx, pr("m-pr1"))
	if !ok {
		t.Fatal("reader refused")
	}
	got := make(chan acquired, 1)
	go func() {
		s, ok := st.Acquire(ctx, seed("m-setup"))
		got <- acquired{s, ok}
	}()
	select {
	case wait := <-clk.waiting:
		if wait != defaultSeedWait {
			t.Fatalf("the seed waits %v", wait)
		}
	case r := <-got:
		t.Fatalf("the seed did not wait for the reader: %+v", r)
	}
	if _, ok := st.Acquire(ctx, pr("m-pr2")); ok {
		t.Fatal("a new reader entered while a seed waited")
	}
	st.Release(reader)
	r := <-got
	if !r.ok || r.st.mode != "seed" {
		t.Fatalf("the seed did not get the state once its readers went: %+v", r)
	}
	if _, ok := st.Acquire(ctx, pr("m-pr3")); ok {
		t.Fatal("a reader mounted a state being written")
	}
	st.Release(r.st)
	again, ok := st.Acquire(ctx, pr("m-pr4"))
	if !ok {
		t.Fatal("the state stayed closed to readers after its seed")
	}
	st.Release(again)
}

// The wait is bounded: a seed whose readers outlast it builds on its own
// state, and the state opens to readers again. Ending the build's context
// ends the wait as well.
func TestASeedWaitsForReadersOnlySoLong(t *testing.T) {
	d, _, _ := statefulDriver(t)
	st := states(d)
	if err := d.dirs.builderDir(st.envDir(bakeOrg, bakeEnv)); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	reader, ok := st.Acquire(ctx, pr("m-pr1"))
	if !ok {
		t.Fatal("reader refused")
	}
	defer st.Release(reader)
	start := fakeClock(st).Now()
	if _, ok := st.Acquire(ctx, seed("m-setup")); ok {
		t.Fatal("a seed wrote the state under a reader's overlay")
	}
	if waited := fakeClock(st).Now().Sub(start); waited != defaultSeedWait {
		t.Fatalf("the seed waited %v, want %v", waited, defaultSeedWait)
	}
	r2, ok := st.Acquire(ctx, pr("m-pr2"))
	if !ok {
		t.Fatal("the state stayed closed to readers after the seed gave up")
	}
	defer st.Release(r2)

	st.clock = &heldClock{Fake: fakeClock(st), waiting: make(chan time.Duration, 1), fire: make(chan time.Time)}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if _, ok := st.Acquire(cancelled, seed("m-setup")); ok {
		t.Fatal("a seed took the state under its readers")
	}
}

// seedRefused is true when a seed cannot take env's state now; the store's
// fake clock makes a seed's wait end at once.
func seedRefused(t *testing.T, st *buildStates) bool {
	t.Helper()
	s, ok := st.Acquire(context.Background(), seed("m-setup"))
	if ok {
		st.Release(s)
	}
	return !ok
}

// An overlay whose unmount failed keeps its state held until the reclaim
// loop unmounts it: Release dropped the reader anyway, so a seed could
// write, or eviction remove, the lower directory under a live overlay.
func TestAStateStaysHeldWhileItsOverlayIsMounted(t *testing.T) {
	d, _, m := statefulDriver(t)
	st := states(d)
	if err := d.dirs.builderDir(st.envDir(bakeOrg, bakeEnv)); err != nil {
		t.Fatal(err)
	}
	reader, ok := st.Acquire(context.Background(), pr("m-pr"))
	if !ok {
		t.Fatal("reader refused")
	}
	m.failUnmount = errors.New("device or resource busy")
	st.Release(reader)
	if !seedRefused(t, st) {
		t.Fatal("a seed took the state under a mounted overlay")
	}
	if err := st.Evict(); err == nil || !seedRefused(t, st) {
		t.Fatalf("the reclaim gave the state back with the overlay still mounted (err %v)", err)
	}
	m.failUnmount = nil
	if err := st.Evict(); err != nil {
		t.Fatal(err)
	}
	if _, mounted := m.mounts[reader.dir]; mounted {
		t.Fatal("the reclaim did not unmount the overlay")
	}
	if _, err := os.Stat(reader.overlay); !os.IsNotExist(err) {
		t.Fatal("the overlay's upper layer outlived its unmount")
	}
	if seedRefused(t, st) {
		t.Fatal("the state stayed held after its overlay went")
	}
}

// What a crashed cell left under machine/ is unmounted and taken out
// before the store is returned, so no seed writes under it: nothing ever
// cleaned it. One that does not unmount holds its state for the reclaim
// loop.
func TestLeftoverOverlaysAreUnmountedBeforeAnySeed(t *testing.T) {
	d, _, _ := statefulDriver(t)
	root := states(d).root
	env := filepath.Join(root, "env", envDirKey(d.cfg.CellID, bakeOrg, bakeEnv))
	mounted := filepath.Join(root, "machine", "m-crashed", "api", "merged")
	unmounted := filepath.Join(root, "machine", "m-old", "api", "upper")
	for _, dir := range []string{env, mounted, unmounted} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	m := &fakeMounter{mounts: map[string]string{mounted: env, "/elsewhere/merged": env}}
	st := testStates(t, d, m)
	if _, still := m.mounts[mounted]; still {
		t.Fatal("the crashed cell's overlay stayed mounted")
	}
	if _, kept := m.mounts["/elsewhere/merged"]; !kept {
		t.Fatal("an overlay outside the cell's directory was unmounted")
	}
	if entries, _ := os.ReadDir(filepath.Join(root, "machine")); len(entries) != 0 {
		t.Fatalf("leftover overlay directories stayed: %v", entries)
	}
	if seedRefused(t, st) {
		t.Fatal("a seed was refused after the leftovers went")
	}

	// It does not unmount: the state stays held, the reclaim retries.
	if err := os.MkdirAll(mounted, 0o700); err != nil {
		t.Fatal(err)
	}
	m = &fakeMounter{mounts: map[string]string{mounted: env}, failUnmount: errors.New("busy")}
	st = testStates(t, d, m)
	if !seedRefused(t, st) {
		t.Fatal("a seed took the state under a leftover overlay")
	}
	if _, err := os.Stat(mounted); err != nil {
		t.Fatalf("the directory of a still mounted overlay was taken out: %v", err)
	}
	m.failUnmount = nil
	if err := st.Evict(); err != nil {
		t.Fatal(err)
	}
	if seedRefused(t, st) {
		t.Fatal("the state stayed held after the reclaim unmounted the leftover")
	}
}

func TestParseOverlayMountsKeepsTheCellsOverlays(t *testing.T) {
	info := `22 1 0:21 / /proc rw,nosuid shared:5 - proc proc rw
101 30 0:50 / /var/kodus/work\040dir/buildkit/machine/m1/api/merged rw,nosuid,nodev - overlay overlay rw,lowerdir=/var/kodus/work\040dir/buildkit/env/abc,upperdir=/u,workdir=/w
102 30 0:51 / /var/lib/docker/overlay2/x/merged rw - overlay overlay rw,lowerdir=/l,upperdir=/u,workdir=/w
103 30 0:52 / /var/kodus/work\040dir/buildkit/machine/m2/api/merged rw - tmpfs tmpfs rw
`
	got, err := parseOverlayMounts(strings.NewReader(info), "/var/kodus/work dir/buildkit/machine")
	want := overlayMount{Target: "/var/kodus/work dir/buildkit/machine/m1/api/merged", Lower: "/var/kodus/work dir/buildkit/env/abc"}
	if err != nil || len(got) != 1 || got[0] != want {
		t.Fatalf("%+v %v", got, err)
	}
}
