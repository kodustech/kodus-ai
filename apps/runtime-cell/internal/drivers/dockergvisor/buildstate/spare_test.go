package buildstate

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/clock"
)

// copyMounter makes a view the way the clone mounter does, as a plain
// directory holding a copy of the state, on any OS. hold, when set, is
// called inside each copy before it starts.
type copyMounter struct {
	mu     sync.Mutex
	copies int
	hold   func()
}

func (m *copyMounter) Overlay(lower, _, _, target string) error {
	m.mu.Lock()
	m.copies++
	hold := m.hold
	m.mu.Unlock()
	if hold != nil {
		hold()
	}
	return os.CopyFS(target, os.DirFS(lower))
}

func (m *copyMounter) Unmount(string) error                   { return nil }
func (m *copyMounter) Mounted(string) ([]OverlayMount, error) { return nil, nil }

func (m *copyMounter) made() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.copies
}

func newSpareStore(t *testing.T, root string, m Mounter) *Store {
	t.Helper()
	st, err := New(Config{
		Root: root, CellID: testCell, Mounter: m, SpareViews: true,
		BuilderDir: func(p string) error { return os.MkdirAll(p, 0o700) },
		FreeBytes:  func(string) (int64, error) { return 1 << 40, nil },
		Clock:      clock.NewFake(time.Date(2026, 11, 13, 0, 0, 0, 0, time.UTC)),
		Log:        slog.New(slog.DiscardHandler),
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		st.WaitSpares()
		st.WaitRemovals()
	})
	return st
}

// seedWith runs a seeding build that leaves exactly the files named in the state.
func seedWith(t *testing.T, st *Store, files ...string) {
	t.Helper()
	s, ok := st.Acquire(context.Background(), seed("m-setup"))
	if !ok {
		t.Fatal("seed refused")
	}
	entries, _ := os.ReadDir(s.Dir)
	for _, e := range entries {
		if e.Name() != stateUsedMark {
			_ = os.RemoveAll(filepath.Join(s.Dir, e.Name()))
		}
	}
	for _, f := range files {
		if err := os.WriteFile(filepath.Join(s.Dir, f), []byte(f), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	st.Release(s)
}

// entered waits for a spare's copy to start, failing the test after a while.
func waitEntered(t *testing.T, entered <-chan struct{}) {
	t.Helper()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("no spare was started")
	}
}

func viewHas(t *testing.T, v State, file string) bool {
	t.Helper()
	_, err := os.Stat(filepath.Join(v.Dir, file))
	return err == nil
}

// The pull request's build after a setup finds its view of the state made:
// no copy of the state runs on its path, and the view is the seed's state.
func TestABuildAfterASetupTakesAViewMadeAheadOfIt(t *testing.T) {
	m := &copyMounter{}
	st := newSpareStore(t, filepath.Join(t.TempDir(), "buildkit"), m)
	seedWith(t, st, "layer-main")
	st.WaitSpares()
	made := m.made()

	view, ok := st.Acquire(context.Background(), pr("m-pr"))
	if !ok {
		t.Fatal("reader refused")
	}
	defer st.Release(view)
	if m.made() != made {
		t.Fatalf("the build copied the state on its path (%d copies, %d before it)", m.made(), made)
	}
	if !viewHas(t, view, "layer-main") {
		t.Fatal("the view is not the seed's state")
	}
}

// A view made before a seed is never read: the build after the second seed
// sees the second seed's state, whether the spare was made before that seed
// or while it ran.
func TestAViewMadeBeforeOrDuringASeedIsNeverRead(t *testing.T) {
	m := &copyMounter{}
	st := newSpareStore(t, filepath.Join(t.TempDir(), "buildkit"), m)
	seedWith(t, st, "layer-v1")
	st.WaitSpares() // a spare at the first seed

	// The next spare starts, and a seed writes the state while it copies.
	entered, finish := make(chan struct{}), make(chan struct{})
	var once sync.Once
	m.mu.Lock()
	m.hold = func() {
		once.Do(func() {
			close(entered)
			<-finish
		})
	}
	m.mu.Unlock()
	seedWith(t, st, "layer-v2") // its release starts a spare, held in its copy
	waitEntered(t, entered)
	seedWith(t, st, "layer-v3")
	close(finish)
	st.WaitSpares()

	view, ok := st.Acquire(context.Background(), pr("m-pr"))
	if !ok {
		t.Fatal("reader refused")
	}
	defer st.Release(view)
	if viewHas(t, view, "layer-v1") || viewHas(t, view, "layer-v2") || !viewHas(t, view, "layer-v3") {
		t.Fatal("the build read a view of an older state")
	}
}

// A spare being made never makes a seed wait for it.
func TestASeedDoesNotWaitForASpareBeingMade(t *testing.T) {
	m := &copyMounter{}
	st := newSpareStore(t, filepath.Join(t.TempDir(), "buildkit"), m)
	entered, finish := make(chan struct{}), make(chan struct{})
	var once sync.Once
	m.hold = func() {
		once.Do(func() {
			close(entered)
			<-finish
		})
	}
	defer close(finish)
	seedWith(t, st, "layer-v1")
	waitEntered(t, entered)

	got := make(chan bool, 1)
	go func() {
		s, ok := st.Acquire(context.Background(), seed("m-setup-2"))
		if ok {
			st.Release(s)
		}
		got <- ok
	}()
	select {
	case ok := <-got:
		if !ok {
			t.Fatal("the seed was refused while a spare was being made")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the seed waited for the spare being made")
	}
}

// A spare a stopped cell left is never taken: the next build makes its own.
func TestASpareLeftByAStoppedCellIsNotTaken(t *testing.T) {
	root := filepath.Join(t.TempDir(), "buildkit")
	m := &copyMounter{}
	first := newSpareStore(t, root, m)
	seedWith(t, first, "layer-main")
	first.WaitSpares()
	// The spare the stopped cell left now differs from the state.
	matches, _ := filepath.Glob(filepath.Join(root, "spare", "*", "merged"))
	if len(matches) != 1 {
		t.Fatalf("spares: %v", matches)
	}
	if err := os.WriteFile(filepath.Join(matches[0], "planted"), nil, 0o600); err != nil {
		t.Fatal(err)
	}

	again := newSpareStore(t, root, m)
	view, ok := again.Acquire(context.Background(), pr("m-pr"))
	if !ok {
		t.Fatal("reader refused")
	}
	defer again.Release(view)
	if viewHas(t, view, "planted") || !viewHas(t, view, "layer-main") {
		t.Fatal("the build took a spare from before the restart")
	}
	if _, err := os.Stat(filepath.Join(root, "spare")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the old spares are still in the tree: %v", err)
	}
}
