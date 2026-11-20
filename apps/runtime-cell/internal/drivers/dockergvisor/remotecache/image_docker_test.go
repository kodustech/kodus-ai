package remotecache

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// Against a real registry:2 and Docker (REMOTECACHE_TEST_REGISTRY=
// http://localhost:5000/kodus-bake, REMOTECACHE_TEST_IMAGE=a local image):
// an image docker save wrote goes to the registry as an ordinary OCI image,
// docker pulls it by the returned digest, and PullImage's archive loads under
// the asked name as the same image.
func TestABakedImageRoundTripsThroughARealRegistry(t *testing.T) {
	url, img := os.Getenv("REMOTECACHE_TEST_REGISTRY"), os.Getenv("REMOTECACHE_TEST_IMAGE")
	if url == "" || img == "" {
		t.Skip("REMOTECACHE_TEST_REGISTRY and REMOTECACHE_TEST_IMAGE unset")
	}
	docker := func(args ...string) string {
		out, err := exec.Command("docker", args...).CombinedOutput()
		if err != nil {
			t.Fatalf("docker %v: %v: %s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	work := t.TempDir()
	saved := filepath.Join(work, "saved")
	docker("save", "-o", filepath.Join(work, "saved.tar"), img)
	if err := os.Mkdir(saved, 0o700); err != nil {
		t.Fatal(err)
	}
	if out, err := exec.Command("tar", "-xf", filepath.Join(work, "saved.tar"), "-C", saved).CombinedOutput(); err != nil {
		t.Fatalf("tar: %v %s", err, out)
	}
	store, err := New(Config{URL: url})
	if err != nil {
		t.Fatal(err)
	}
	k := ImageKey{Org: "org-a", Env: "env-1", Fingerprint: "fp-real"}
	digest, _, err := store.PushImage(context.Background(), k, saved)
	if err != nil {
		t.Fatal(err)
	}
	host := strings.TrimPrefix(strings.TrimPrefix(url, "http://"), "https://")
	registry, repo, _ := strings.Cut(host, "/")
	pulled := registry + "/" + k.Repository(repo) + "@" + digest
	docker("pull", "-q", pulled)
	tarball := filepath.Join(work, "pulled.tar")
	const tag = "kodus-bake-test/roundtrip:g1"
	if _, err := store.PullImage(context.Background(), k, digest, tarball, tag); err != nil {
		t.Fatal(err)
	}
	docker("load", "-q", "-i", tarball)
	t.Cleanup(func() { _ = exec.Command("docker", "rmi", "-f", tag, pulled).Run() })
	if got, want := docker("image", "inspect", "-f", "{{.Id}}", tag), docker("image", "inspect", "-f", "{{.Id}}", pulled); got != want {
		t.Fatalf("loaded %s, docker pulled %s", got, want)
	}
	if got, want := docker("image", "inspect", "-f", "{{json .RootFS.Layers}}", tag), docker("image", "inspect", "-f", "{{json .RootFS.Layers}}", img); got != want {
		t.Fatalf("loaded layers %s, want %s", got, want)
	}
}
