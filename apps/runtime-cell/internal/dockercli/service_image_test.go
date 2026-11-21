package dockercli

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
)

// fakeImages is a daemon's image store for PullServiceImage: inspect answers
// each image's size and registry digests, a pull (anonymous, checked) adds
// what pullable says the registry serves.
type fakeImages struct {
	t        *testing.T
	login    string
	present  map[string]string // ref -> "<size> <repo digests json>"
	pullable map[string]string
	calls    []string
}

func (f *fakeImages) run(_ context.Context, _ []byte, _ string, args ...string) ([]byte, error) {
	f.calls = append(f.calls, strings.Join(args, " "))
	ref := args[len(args)-1]
	switch {
	case args[0] == "image" && args[1] == "inspect":
		if v, ok := f.present[ref]; ok {
			return []byte(v + "\n"), nil
		}
		return nil, &ExitError{Command: "docker image inspect", Code: 1, Stderr: "Error: No such image: " + ref}
	case args[0] == "--config":
		dir := args[1]
		if dir == f.login {
			f.t.Error("the pull read the cell's docker config")
		}
		if entries, _ := os.ReadDir(dir); len(entries) != 0 {
			f.t.Errorf("the pull's config holds %v", entries)
		}
		v, ok := f.pullable[ref]
		if !ok {
			return nil, &ExitError{Command: "docker pull", Code: 1, Stderr: "Error response from daemon: pull access denied for " + ref}
		}
		f.present[ref] = v
		return nil, nil
	case args[0] == "image" && args[1] == "rm":
		delete(f.present, ref)
		return nil, nil
	}
	f.t.Fatalf("unexpected docker %v", args)
	return nil, nil
}

func newFakeImages(t *testing.T) *fakeImages {
	login := t.TempDir()
	if err := os.WriteFile(filepath.Join(login, "config.json"), []byte(`{"auths":{"ghcr.io":{"auth":"x"}}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("DOCKER_CONFIG", login)
	return &fakeImages{t: t, login: login, present: map[string]string{}, pullable: map[string]string{}}
}

const (
	pgDigest  = "sha256:1111111111111111111111111111111111111111111111111111111111111111"
	ownDigest = "sha256:2222222222222222222222222222222222222222222222222222222222222222"
)

// F3-01: compose pulled a compose file's images itself, with the docker
// config the cell runs with, so a file could pull from any registry the
// cell holds a login for, and an image of any size. A service image is now
// pulled anonymously and only once missing, and refused past the bound.
func TestAServiceImageIsPulledAnonymouslyWithinTheBound(t *testing.T) {
	f := newFakeImages(t)
	f.pullable["postgres:16"] = `400000000 ["postgres@` + pgDigest + `"]`
	f.pullable["huge:1"] = `90000000000 ["huge@` + pgDigest + `"]`
	c := CLI{Run: f.run}
	ctx := context.Background()
	if err := c.PullServiceImage(ctx, "postgres:16", 1<<30, false); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(f.calls[1], "--config ") || !strings.HasSuffix(f.calls[1], " pull -q -- postgres:16") {
		t.Fatalf("pull %q", f.calls[1])
	}
	f.calls = nil
	if err := c.PullServiceImage(ctx, "postgres:16", 1<<30, false); err != nil || len(f.calls) != 1 {
		t.Fatalf("an image already here was pulled again: %v %v", err, f.calls)
	}
	if err := c.PullServiceImage(ctx, "huge:1", 1<<30, false); !errors.Is(err, driver.ErrImageTooLarge) {
		t.Fatalf("an image past the bound: %v", err)
	}
	if _, kept := f.present["huge:1"]; kept {
		t.Fatal("the image past the bound was kept")
	}
}

// N10: an image already on the host is used without a pull only when the
// host knows what a registry served for it. A digest names its content
// whoever pulled it; a tag with no registry digest of its repository was
// built or tagged on the host, and is refused. An image of the cell's own
// (fresh: it may have been pulled with the cell's login) is pulled
// anonymously even when here, and refused when the registry does not serve
// it so.
func TestAnImageAlreadyHereIsUsedOnlyAsARegistryServedIt(t *testing.T) {
	f := newFakeImages(t)
	c := CLI{Run: f.run}
	ctx := context.Background()
	byDigest := "docker.io/library/postgres@" + pgDigest
	f.present[byDigest] = `400000000 ["postgres@` + pgDigest + `"]`
	if err := c.PullServiceImage(ctx, byDigest, 1<<30, false); err != nil || len(f.calls) != 1 {
		t.Fatalf("a digest already here: %v %v", err, f.calls)
	}
	f.present["docker.io/library/postgres:16"] = `400000000 ["postgres@` + pgDigest + `"]`
	if err := c.PullServiceImage(ctx, "docker.io/library/postgres:16", 1<<30, false); err != nil {
		t.Fatalf("a tag whose registry digest the host knows: %v", err)
	}
	f.present["redis:7"] = `100000000 []`
	f.present["mysql:8"] = `100000000 ["example.com/other/mysql@` + pgDigest + `"]`
	for _, ref := range []string{"redis:7", "mysql:8"} {
		if err := c.PullServiceImage(ctx, ref, 1<<30, false); err == nil || !strings.Contains(err.Error(), "no registry digest") {
			t.Fatalf("%s, here with no digest of its repository: %v", ref, err)
		}
	}
	own := "ghcr.io/example/holder@" + ownDigest
	f.present[own] = `50000000 ["ghcr.io/example/holder@` + ownDigest + `"]`
	f.calls = nil
	if err := c.PullServiceImage(ctx, own, 1<<30, true); err == nil || len(f.calls) < 2 || !strings.Contains(f.calls[1], " pull -q -- "+own) {
		t.Fatalf("one of the cell's own images, which no registry serves anonymously: %v %v", err, f.calls)
	}
	if _, kept := f.present[own]; !kept {
		t.Fatal("a refused fresh pull removed the cell's own image")
	}
	f.pullable["registry:2"] = `30000000 ["registry@` + ownDigest + `"]`
	f.present["registry:2"] = f.pullable["registry:2"]
	if err := c.PullServiceImage(ctx, "registry:2", 1<<30, true); err != nil {
		t.Fatalf("a public image of the cell's own: %v", err)
	}
}

func TestImageRepositoryNormalizesDockerHub(t *testing.T) {
	for ref, want := range map[string]string{
		"postgres":                              "docker.io/library/postgres",
		"postgres:16":                           "docker.io/library/postgres",
		"library/postgres@" + pgDigest:          "docker.io/library/postgres",
		"index.docker.io/library/postgres:16":   "docker.io/library/postgres",
		"moby/buildkit:v0.20":                   "docker.io/moby/buildkit",
		"ghcr.io/org/x:1":                       "ghcr.io/org/x",
		"registry.example:5000/a/b@" + pgDigest: "registry.example:5000/a/b",
		"Registry.Example/a/b":                  "registry.example/a/b",
	} {
		if got := ImageRepository(ref); got != want {
			t.Errorf("%s: %q, want %q", ref, got, want)
		}
	}
}

// The idle claim network pass (dockergvisor) reads each network's labels
// and when it was made from one ls and one inspect.
func TestNetworksLabelledReadsNamesLabelsAndCreation(t *testing.T) {
	var calls []string
	c := CLI{Run: func(_ context.Context, _ []byte, _ string, args ...string) ([]byte, error) {
		calls = append(calls, strings.Join(args, " "))
		if args[1] == "ls" {
			return []byte("n1\nn2\n"), nil
		}
		return []byte(`{"Name":"kodus-claim-1","Created":"2026-11-07T11:00:00.123456789Z","Labels":{"kodus.cell":"cell-1","kodus.claim":"claim-1"}}
{"Name":"kodus-observers","Created":"2026-11-01T00:00:00Z","Labels":{"kodus.cell":"cell-1"}}
`), nil
	}}
	nets, err := c.NetworksLabelled(context.Background(), map[string]string{"kodus.cell": "cell-1"})
	if err != nil {
		t.Fatal(err)
	}
	if calls[0] != "network ls -q --no-trunc --filter label=kodus.cell=cell-1" || calls[1] != "network inspect --format {{json .}} n1 n2" {
		t.Fatalf("calls %q", calls)
	}
	if len(nets) != 2 || nets[0].Name != "kodus-claim-1" || nets[0].Labels["kodus.claim"] != "claim-1" || nets[0].Created.Hour() != 11 {
		t.Fatalf("networks %+v", nets)
	}
}
