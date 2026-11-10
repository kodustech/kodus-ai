package buildstate

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/clock"
)

const (
	testCell = "cell-1"
	testOrg  = "org-a"
	testEnv  = "env-1"
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

func (f *fakeMounter) Mounted(under string) ([]OverlayMount, error) {
	var out []OverlayMount
	for target, lower := range f.mounts {
		if strings.HasPrefix(target, under+"/") {
			out = append(out, OverlayMount{Target: target, Lower: lower})
		}
	}
	return out, nil
}

func mkdir(t *testing.T, dir string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
}

// newStoreAt is a store under root with a fake clock and all the disk free.
func newStoreAt(t *testing.T, root string, m Mounter) *Store {
	t.Helper()
	st, err := New(Config{
		Root: root, CellID: testCell, Mounter: m,
		BuilderDir: func(p string) error { return os.MkdirAll(p, 0o700) },
		FreeBytes:  func(string) (int64, error) { return 1 << 40, nil },
		Clock:      clock.NewFake(time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)),
		Log:        slog.New(slog.DiscardHandler),
	})
	if err != nil {
		t.Fatal(err)
	}
	return st
}

func newStore(t *testing.T) (*Store, *fakeMounter) {
	t.Helper()
	m := &fakeMounter{}
	return newStoreAt(t, filepath.Join(t.TempDir(), "buildkit"), m), m
}

func fakeClock(st *Store) *clock.Fake { return st.clock.(*clock.Fake) }

// useAt makes env's state used last at the store's clock time at.
func useAt(t *testing.T, st *Store, env string, at time.Time) {
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

func pr(machine string) Request {
	return Request{Machine: machine, Service: "api", Org: testOrg, Env: testEnv}
}

func seed(machine string) Request {
	r := pr(machine)
	r.Seeds = true
	return r
}

// One seeding build or any number of readers, never both: a busy state
// leaves the build on its own throwaway state and the exported cache.
func TestABusyStateFallsBackToTheExportedCache(t *testing.T) {
	st, _ := newStore(t)
	mkdir(t, st.EnvDir(testOrg, testEnv))
	reader, ok := st.Acquire(context.Background(), pr("m-pr"))
	if !ok || reader.Mode != ModeOverlay {
		t.Fatalf("reader: %+v %v", reader, ok)
	}
	if _, ok := st.Acquire(context.Background(), seed("m-setup")); ok {
		t.Fatal("a seed wrote the state under a reader's overlay")
	}
	if _, ok := st.Acquire(context.Background(), pr("m-pr2")); !ok {
		t.Fatal("two readers could not share the state")
	}
	st.Release(reader)

	st2, _ := newStore(t)
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

// Last use is the store's clock, not the wall's: it stamped each state's
// mark with time.Now(), so a state used later on the wall but earlier on
// the cell's clock was kept and the other one evicted.
func TestEvictionOrdersStatesByTheStoresClock(t *testing.T) {
	st, _ := newStore(t)
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
	if _, err := os.Stat(st.EnvDir(testOrg, "env-stale")); !os.IsNotExist(err) {
		t.Fatal("the state the clock used least recently was kept")
	}
	if _, err := os.Stat(st.EnvDir(testOrg, "env-recent")); err != nil {
		t.Fatalf("the state the clock used last was evicted: %v", err)
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
	st State
	ok bool
}

// A seed that finds readers waits for them and lets no new one in: a seed
// was refused whenever any reader held the state and readers were never
// refused for a seed, so steady pull request builds kept the default
// branch's setup from ever writing it.
func TestAWaitingSeedGetsTheStateBeforeNewReaders(t *testing.T) {
	st, _ := newStore(t)
	clk := &heldClock{Fake: fakeClock(st), waiting: make(chan time.Duration, 1), fire: make(chan time.Time)}
	st.clock = clk
	mkdir(t, st.EnvDir(testOrg, testEnv))
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
	if !r.ok || r.st.Mode != ModeSeed {
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
	st, _ := newStore(t)
	mkdir(t, st.EnvDir(testOrg, testEnv))
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
func seedRefused(t *testing.T, st *Store) bool {
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
	st, m := newStore(t)
	mkdir(t, st.EnvDir(testOrg, testEnv))
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
	if _, mounted := m.mounts[reader.Dir]; mounted {
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
	root := filepath.Join(t.TempDir(), "buildkit")
	env := filepath.Join(root, "env", EnvKey(testCell, testOrg, testEnv))
	mounted := filepath.Join(root, "machine", "m-crashed", "api", "merged")
	unmounted := filepath.Join(root, "machine", "m-old", "api", "upper")
	for _, dir := range []string{env, mounted, unmounted} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	m := &fakeMounter{mounts: map[string]string{mounted: env, "/elsewhere/merged": env}}
	st := newStoreAt(t, root, m)
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
	st = newStoreAt(t, root, m)
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
	want := OverlayMount{Target: "/var/kodus/work dir/buildkit/machine/m1/api/merged", Lower: "/var/kodus/work dir/buildkit/env/abc"}
	if err != nil || len(got) != 1 || got[0] != want {
		t.Fatalf("%+v %v", got, err)
	}
}
