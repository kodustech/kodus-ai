package dockergvisor

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose/sandbox"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockercli"
)

// chowns records what the driver gives the builder, in place of lchown:
// the tests do not run as root.
type chowns struct {
	mu sync.Mutex
	to map[string][2]int // path -> uid, gid
}

func (c *chowns) chown(p string, uid, gid int) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.to[p] = [2]int{uid, gid}
	return nil
}

func (c *chowns) owner(p string) ([2]int, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	ids, ok := c.to[p]
	return ids, ok
}

// recordChowns makes the driver's builder directories record their owner
// instead of changing it.
func recordChowns(d *Driver) *chowns {
	c := &chowns{to: map[string][2]int{}}
	d.dirs = hostDirs{uid: d.dirs.uid, gid: d.dirs.gid, self: os.Geteuid(), chown: c.chown, owner: statOwner}
	return c
}

// Every host directory a build writes is the builder's alone, under roots
// that are the cell's alone: no other host user can put a layer in an
// environment's state or cache, or swap the image the cell loads.
func TestTheBuildersDirectoriesAreItsAlone(t *testing.T) {
	d, docker, _ := statefulDriver(t)
	if err := os.MkdirAll(states(d).root, 0o700); err != nil {
		t.Fatal(err)
	}
	for _, root := range builderRoots(d.workDir()) {
		if err := os.MkdirAll(root, 0o777); err != nil {
			t.Fatal(err)
		}
		_ = os.Chmod(root, 0o777) // what an older cell or a careless operator left
	}
	if _, err := New(context.Background(), docker, d.cfg); err != nil {
		t.Fatal(err)
	}
	for _, root := range builderRoots(d.workDir()) {
		if info, err := os.Stat(root); err != nil || info.Mode().Perm() != 0o700 {
			t.Fatalf("root %s: %v %v, want the cell's alone (0700)", root, info.Mode(), err)
		}
	}
	owners := recordChowns(d)
	d.states = testStates(t, d, &fakeMounter{})
	var checked int
	docker.duringBuild = func(b dockercli.BuildRun) {
		dirs := []string{b.Out, b.CacheTo, b.StateDir}
		if b.StateDir != "" && filepath.Base(b.StateDir) == "merged" {
			dirs = append(dirs, filepath.Join(filepath.Dir(b.StateDir), "upper"), filepath.Join(filepath.Dir(b.StateDir), "work"))
		}
		for _, p := range dirs {
			if p == "" {
				continue
			}
			checked++
			info, err := os.Lstat(p)
			if err != nil || !info.IsDir() || info.Mode().Perm() != 0o700 {
				t.Errorf("%s: %v %v, want a directory only its owner reaches (0700)", p, info.Mode(), err)
			}
			if ids, ok := owners.owner(p); !ok || ids != [2]int{builderUser, builderUser} {
				t.Errorf("%s owned by %v (%v), want the builder %d:%d", p, ids, ok, builderUser, builderUser)
			}
		}
	}
	build := sandbox.Build{Service: "api", Context: project(t), Dockerfile: "Dockerfile"}
	seeder := machine("claim-seed", bakeEnv)
	asSetup(d, seeder, true)
	boot(t, d, seeder, build) // the environment's state, written directly
	boot(t, d, machine("claim-pr", bakeEnv), build)
	d.states = noStates{}
	setup := machine("claim-setup", bakeEnv)
	asSetup(d, setup, false)
	boot(t, d, setup, build) // a cache of its own
	if checked != 1+1+1+3+1+1 {
		t.Fatalf("checked %d directories, want the seed's out and state, the PR's out and overlay, the setup's out and cache", checked)
	}
}

// The builder's host ids are the image's user only when Docker maps no
// user namespace; with one, the cell must be told them or it builds nothing.
func TestTheBuildersHostIDsFollowDockersUserNamespace(t *testing.T) {
	cfg := func(uid, gid int) Config {
		return Config{CellID: "cell-1", HolderImage: "h", WorkDir: t.TempDir(), BuilderImage: "moby/buildkit@sha256:abc", BuilderUID: uid, BuilderGID: gid}
	}
	docker := newMemDocker()
	docker.securityOptions = []string{"name=seccomp,profile=builtin"}
	d, err := New(context.Background(), docker, cfg(0, 0))
	if err != nil || d.dirs.uid != builderUser || d.dirs.gid != builderUser {
		t.Fatalf("no user namespace: %+v %v, want %d", d.dirs, err, builderUser)
	}
	for _, opt := range []string{"name=userns", "name=rootless"} {
		docker.securityOptions = []string{"name=seccomp,profile=builtin", opt}
		if _, err := New(context.Background(), docker, cfg(0, 0)); !errors.Is(err, ErrBuilderIDsUnknown) {
			t.Fatalf("%s: %v, want ErrBuilderIDsUnknown", opt, err)
		}
	}
	d, err = New(context.Background(), docker, cfg(101000, 101000))
	if err != nil || d.dirs.uid != 101000 || d.dirs.gid != 101000 {
		t.Fatalf("told ids: %+v %v", d.dirs, err)
	}
	for _, ids := range [][2]int{{101000, 0}, {-1, -1}} {
		if _, err := New(context.Background(), docker, cfg(ids[0], ids[1])); err == nil {
			t.Fatalf("ids %v accepted", ids)
		}
	}
	// A cell that builds nothing never asks.
	docker.securityOptions = []string{"name=userns"}
	if _, err := New(context.Background(), docker, Config{CellID: "cell-1", HolderImage: "h", WorkDir: t.TempDir()}); err != nil {
		t.Fatal(err)
	}
}

// A root someone else made (a link, or a directory of another user's in a
// shared work directory) is refused: whoever owns it reaches everything
// the builder writes below it.
func TestAPlantedRootIsRefused(t *testing.T) {
	work, elsewhere := t.TempDir(), t.TempDir()
	if err := os.Symlink(elsewhere, filepath.Join(work, "cache")); err != nil {
		t.Fatal(err)
	}
	if _, err := New(context.Background(), newMemDocker(), Config{CellID: "cell-1", HolderImage: "h", WorkDir: work, BuilderImage: "b"}); err == nil {
		t.Fatal("a root that is a link was taken")
	}
	h := defaultHostDirs()
	h.self++ // the directory is someone else's
	if err := h.privateRoot(filepath.Join(t.TempDir(), "buildkit")); err == nil {
		t.Fatal("a root another user owns was taken")
	}
	// The same for a directory the builder writes: never through a link.
	link := filepath.Join(t.TempDir(), "out")
	if err := os.Symlink(elsewhere, link); err != nil {
		t.Fatal(err)
	}
	h = defaultHostDirs()
	h.chown = func(string, int, int) error { return nil }
	if err := h.builderDir(link); err == nil {
		t.Fatal("a builder directory that is a link was taken")
	}
}
