//go:build unix

package registry

import (
	"errors"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

// testDirs owns the host directories as a cell that runs as the test's
// user: the builder's chowns are not applied, ownership is read from stat.
type testDirs struct{}

func (testDirs) BuilderDir(p string) error          { return os.MkdirAll(p, 0o700) }
func (testDirs) Builder() (uid, gid int)            { return 1000, 1000 }
func (testDirs) Self() int                          { return os.Geteuid() }
func (testDirs) Chown(string, int, int) error       { return nil }
func (testDirs) Owner(info fs.FileInfo) (int, bool) { return statOwner(info) }

func statOwner(info fs.FileInfo) (int, bool) {
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, false
	}
	return int(st.Uid), true
}

func testRegistries(t *testing.T) *Registries {
	t.Helper()
	return New(Config{
		CellID: "cell-1", Image: "registry@sha256:abc", Root: t.TempDir(), KeepBytes: 40 << 30, EnvKey: envKey,
		Dirs: testDirs{}, Log: func() *slog.Logger { return slog.New(slog.DiscardHandler) },
	})
}

func envKey(org, env string) string { return org + "-" + env }

func seedDir(s *Registries) string {
	return filepath.Join(s.cfg.Root, envKey("org-a", "env-1"), "seed")
}

func writeFile(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

// writeBlob puts a blob in a registry storage as distribution lays it out.
func writeBlob(t *testing.T, storage, sum string, mode os.FileMode) string {
	t.Helper()
	p := filepath.Join(storage, V2, "blobs", "sha256", sum[:2], sum, "data")
	writeFile(t, p, "layer "+sum)
	if err := os.Chmod(p, mode); err != nil {
		t.Fatal(err)
	}
	return p
}

// A seed storage is wiped only while no build holds it: a build that takes it
// up while a wipe is under way keeps what it writes there, whether the wipe
// is the end of the build before it or the first build finding it past its
// bound. The wipe still takes the old seed.
func TestASeedWipeKeepsWhatABuildThatStartedMeanwhileWrote(t *testing.T) {
	for name, atStart := range map[string]bool{"at the end of the build that held it": false, "when the first build finds it past its bound": true} {
		t.Run(name, func(t *testing.T) {
			s := testRegistries(t)
			key := envKey("org-a", "env-1")
			seed := seedDir(s)
			if err := s.cfg.Dirs.BuilderDir(seed); err != nil {
				t.Fatal(err)
			}
			old := writeBlob(t, seed, strings.Repeat("a", 64), 0o444)
			var fresh string
			release := func() {}
			meanwhile := func() {
				s.hooks.seedWiping = nil
				release = s.hold(key, seed)
				if err := s.cfg.Dirs.BuilderDir(seed); err != nil {
					t.Fatal(err)
				}
				fresh = writeBlob(t, seed, strings.Repeat("f", 64), 0o644)
			}
			if atStart {
				s.cfg.KeepBytes = 1
				s.hooks.seedWiping = meanwhile
				defer s.hold(key, seed)()
			} else {
				defer s.hold(key, seed)()
				s.hooks.seedWiping = meanwhile
				s.wipeSeed(key, seed)
			}
			defer func() { release() }()
			if fresh == "" {
				t.Fatal("no wipe ran")
			}
			if _, err := os.Stat(fresh); err != nil {
				t.Fatalf("the wipe took what the later build wrote: %v", err)
			}
			if _, err := os.Stat(old); !errors.Is(err, fs.ErrNotExist) {
				t.Fatalf("the old seed stayed: %v", err)
			}
		})
	}
}

// A pull request's storage gets only the seed's own sealed blobs: a blob
// whose directory is swapped for a link while the cell links it (the seed's
// directories are the builder's) is left out, never the file the link
// points to.
func TestASeedBlobSwappedForALinkIsNotGivenToAPullRequest(t *testing.T) {
	s := testRegistries(t)
	seed := seedDir(s)
	if err := s.cfg.Dirs.BuilderDir(seed); err != nil {
		t.Fatal(err)
	}
	sum := strings.Repeat("a", 64)
	writeBlob(t, seed, sum, 0o444)
	bait := filepath.Join(t.TempDir(), "bait")
	writeFile(t, filepath.Join(bait, "data"), "not a blob of the seed")
	if err := os.Chmod(filepath.Join(bait, "data"), 0o444); err != nil {
		t.Fatal(err)
	}
	s.hooks.seedLinking = func(path string) {
		dir := filepath.Dir(path)
		if err := os.Rename(dir, dir+".moved"); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(bait, dir); err != nil {
			t.Fatal(err)
		}
	}
	storage := filepath.Join(s.cfg.Root, "claims", "pr")
	if err := s.cfg.Dirs.BuilderDir(storage); err != nil {
		t.Fatal(err)
	}
	n, err := s.linkSeed(seed, storage, Repo("api"))
	if err != nil {
		t.Fatal(err)
	}
	data := filepath.Join(storage, V2, "blobs", "sha256", sum[:2], sum, "data")
	if got, rerr := os.ReadFile(data); n != 0 || rerr == nil {
		t.Fatalf("linked %d blobs; the pull request's storage holds %q", n, got)
	}
}
