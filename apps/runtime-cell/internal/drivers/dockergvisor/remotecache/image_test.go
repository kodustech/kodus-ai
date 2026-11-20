package remotecache

import (
	"archive/tar"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/dockercli"
)

// writeSaved makes what `docker save` leaves once extracted: manifest.json
// naming a config and its layers, each a blob named by its digest.
func writeSaved(t *testing.T, dir string, layers ...string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(dir, "blobs", "sha256"), 0o700); err != nil {
		t.Fatal(err)
	}
	put := func(b []byte) string {
		d := sum(b)
		if err := os.WriteFile(filepath.Join(dir, blobPath(d)), b, 0o600); err != nil {
			t.Fatal(err)
		}
		return blobPath(d)
	}
	cfg := put([]byte(`{"architecture":"amd64","os":"linux","rootfs":{"type":"layers"}}`))
	var paths []string
	for _, l := range layers {
		paths = append(paths, put([]byte(l)))
	}
	m, _ := json.Marshal([]map[string]any{{"Config": cfg, "RepoTags": []string{"kodus-bake/c/o/e:g1-fp"}, "Layers": paths}})
	if err := os.WriteFile(filepath.Join(dir, "manifest.json"), m, 0o600); err != nil {
		t.Fatal(err)
	}
}

func tarFile(t *testing.T, tarball, name string) string {
	t.Helper()
	f, err := os.Open(tarball)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = f.Close() }()
	tr := tar.NewReader(f)
	for {
		h, err := tr.Next()
		if err != nil {
			t.Fatalf("%s not in the tarball: %v", name, err)
		}
		if h.Name == name {
			b, _ := io.ReadAll(tr)
			return string(b)
		}
	}
}

var imageA = ImageKey{Org: "org-a", Env: "env-1", Fingerprint: "fp-web-1"}

// A baked image pushed by one cell comes back on another, by the digest the
// push returned, as a tarball docker load takes under the name the pulling
// cell asks for, with every layer byte for byte.
func TestABakedImageComesBackByItsDigestUnderTheAskedName(t *testing.T) {
	store := newStore(t, newFakeRegistry())
	src := t.TempDir()
	writeSaved(t, src, "layer one", "layer two")
	digest, _, err := store.PushImage(context.Background(), imageA, src)
	if err != nil {
		t.Fatal(err)
	}
	if !digestRE.MatchString(digest) {
		t.Fatalf("digest %q", digest)
	}
	tarball := filepath.Join(t.TempDir(), "img.tar")
	const tag = "kodus-bake/c2/o/e:g9-fp"
	if _, err := store.PullImage(context.Background(), imageA, digest, tarball, tag); err != nil {
		t.Fatal(err)
	}
	if err := dockercli.CheckImageTarball(dockercli.ImageLoad{Tarball: tarball, Tag: tag}); err != nil {
		t.Fatalf("docker load would refuse it: %v", err)
	}
	if got := tarFile(t, tarball, blobPath(sum([]byte("layer two")))); got != "layer two" {
		t.Fatalf("layer = %q", got)
	}
}

// The hub's digest is what a cell trusts: a manifest the registry serves under
// it whose bytes hash to something else is refused before any layer moves.
func TestAPullRefusesAManifestThatIsNotTheDigest(t *testing.T) {
	reg := newFakeRegistry()
	store := newStore(t, reg)
	src := t.TempDir()
	writeSaved(t, src, "layer one")
	digest, _, err := store.PushImage(context.Background(), imageA, src)
	if err != nil {
		t.Fatal(err)
	}
	reg.mu.Lock()
	for k, v := range reg.manifests {
		if strings.HasSuffix(k, ":"+digest) {
			reg.manifests[k] = []byte(strings.Replace(string(v), "amd64", "arm64", 1) + " ")
		}
	}
	reg.mu.Unlock()
	_, err = store.PullImage(context.Background(), imageA, digest, filepath.Join(t.TempDir(), "img.tar"), "kodus-bake/c/o/e:g-fp")
	if !errors.Is(err, ErrDigestMismatch) {
		t.Fatalf("err = %v, want ErrDigestMismatch", err)
	}
}

// Another org's image is in another repository: its digest names nothing in
// this org's.
func TestAnotherOrgsBakedImageIsNotFound(t *testing.T) {
	store := newStore(t, newFakeRegistry())
	src := t.TempDir()
	writeSaved(t, src, "layer one")
	digest, _, err := store.PushImage(context.Background(), imageA, src)
	if err != nil {
		t.Fatal(err)
	}
	other := imageA
	other.Org = "org-b"
	if other.Repository("p") == imageA.Repository("p") {
		t.Fatal("two orgs share a repository")
	}
	_, err = store.PullImage(context.Background(), other, digest, filepath.Join(t.TempDir(), "img.tar"), "kodus-bake/c/o/e:g-fp")
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
}

// A saved image with a manifest.json naming a blob outside blobs/sha256, or
// more than one image, is not pushed.
func TestASavedImageThatIsNotOneImageIsNotPushed(t *testing.T) {
	store := newStore(t, newFakeRegistry())
	src := t.TempDir()
	writeSaved(t, src, "layer one")
	if err := os.WriteFile(filepath.Join(src, "manifest.json"), []byte(`[{"Config":"../../etc/passwd","Layers":[]}]`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.PushImage(context.Background(), imageA, src); err == nil {
		t.Fatal("pushed a manifest naming a path outside the blobs")
	}
}
