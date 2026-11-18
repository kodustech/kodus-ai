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

// A build with a push target sends its image to that registry over plain
// HTTP and reports the digest in its metadata file; it writes no tarball.
func TestAPushBuildSendsItsImageToTheRegistry(t *testing.T) {
	var got []string
	c := CLI{Run: func(_ context.Context, _ []byte, _ string, args ...string) ([]byte, error) {
		got = args
		return nil, nil
	}}
	out := t.TempDir()
	b := BuildRun{
		Image: "buildkit", Runtime: "runsc", Network: "n", Address: "10.213.1.9", Resolv: "/r", Context: "/c", Dockerfile: "Dockerfile", Tag: "t:claim", Out: out,
		Push: &BuildPush{Registry: "10.213.1.8:5000", Repo: "kodus/api-0123456789ab", Tag: "m1"},
	}
	if err := c.RunBuild(context.Background(), b); err != nil {
		t.Fatal(err)
	}
	j := strings.Join(got, " ")
	if !strings.Contains(j, "type=image,name=10.213.1.8:5000/kodus/api-0123456789ab:m1,push=true") || strings.Contains(j, BuildTarball) || !strings.Contains(j, "--metadata-file /out/"+BuildMetadata) {
		t.Fatalf("args: %s", j)
	}
	if conf, err := os.ReadFile(filepath.Join(out, BuildkitdConfig)); err != nil || !strings.Contains(string(conf), "[registry.\"10.213.1.8:5000\"]\n  http = true") {
		t.Fatalf("config %q %v", conf, err)
	}
	got = nil
	b.Push.Repo = "Kodus/../x"
	if err := c.RunBuild(context.Background(), b); err == nil || got != nil {
		t.Fatal("a push target that is not a repository reached docker")
	}
}

// The builder writes the metadata file: only one sha256 manifest digest in a
// small regular file is taken, never a link or anything else.
func TestTheBuiltDigestIsReadAsUntrusted(t *testing.T) {
	digest := "sha256:" + strings.Repeat("a", 64)
	for name, c := range map[string]struct {
		write func(dir string) error
		ok    bool
	}{
		"a digest": {func(d string) error {
			return os.WriteFile(filepath.Join(d, BuildMetadata), []byte(`{"containerimage.digest":"`+digest+`"}`), 0o644)
		}, true},
		"a tag": {func(d string) error {
			return os.WriteFile(filepath.Join(d, BuildMetadata), []byte(`{"containerimage.digest":"latest"}`), 0o644)
		}, false},
		"a link": {func(d string) error {
			target := filepath.Join(d, "elsewhere")
			if err := os.WriteFile(target, []byte(`{"containerimage.digest":"`+digest+`"}`), 0o644); err != nil {
				return err
			}
			return os.Symlink(target, filepath.Join(d, BuildMetadata))
		}, false},
		"too big": {func(d string) error {
			return os.WriteFile(filepath.Join(d, BuildMetadata), []byte(`{"containerimage.digest":"`+digest+`","x":"`+strings.Repeat("x", maxMetadataBytes)+`"}`), 0o644)
		}, false},
		"none": {func(string) error { return nil }, false},
	} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			if err := c.write(dir); err != nil {
				t.Fatal(err)
			}
			got, err := BuiltDigest(dir)
			if c.ok != (err == nil) || (c.ok && got != digest) || (!c.ok && !errors.Is(err, driver.ErrImageLoad)) {
				t.Fatalf("digest %q err %v", got, err)
			}
		})
	}
}

// The cell pulls by digest only: a reference by tag never reaches docker.
func TestAPullIsByDigestOnly(t *testing.T) {
	ran := false
	c := CLI{Run: func(context.Context, []byte, string, ...string) ([]byte, error) { ran = true; return nil, nil }}
	if err := c.PullImage(context.Background(), "127.0.0.1:5001/kodus/api:latest"); err == nil || ran {
		t.Fatal("a pull by tag reached docker")
	}
	if err := c.PullImage(context.Background(), "127.0.0.1:5001/kodus/api@sha256:"+strings.Repeat("b", 64)); err != nil || !ran {
		t.Fatalf("a pull by digest: %v", err)
	}
}

// gVisor sets a sandbox's interfaces up when it starts and takes no network
// later: a registry joined to the claim network after it ran would not be
// there for the builder's push. It is created, joined at its fixed address,
// and only then started.
func TestARegistryIsOnTheClaimNetworkBeforeItStarts(t *testing.T) {
	var calls []string
	c := CLI{Run: func(_ context.Context, _ []byte, _ string, args ...string) ([]byte, error) {
		calls = append(calls, strings.Join(args, " "))
		if args[0] == "inspect" {
			return []byte(`[{"Id":"r1","Name":"/kodus-registry-1"}]`), nil
		}
		return []byte("r1"), nil
	}}
	_, err := c.RunRegistry(context.Background(), RegistrySpec{
		Name: "kodus-registry-1", Image: "registry@sha256:abc", Runtime: "runsc", Network: "kodus-registries-cell-1",
		ClaimNetwork: "claim-net", ClaimIP: "10.213.1.8", StorageDir: t.TempDir(), User: "1000:1000",
	})
	if err != nil {
		t.Fatal(err)
	}
	var verbs []string
	for _, call := range calls {
		verbs = append(verbs, strings.Fields(call)[0])
	}
	if strings.Join(verbs, ",") != "create,network,start,inspect" || calls[1] != "network connect --ip 10.213.1.8 claim-net r1" {
		t.Fatalf("calls %q", calls)
	}
	calls = nil
	if _, err := c.RunRegistry(context.Background(), RegistrySpec{
		Name: "kodus-registry-2", Image: "registry@sha256:abc", Runtime: "runsc", Network: "n",
		ClaimNetwork: "claim-net", ClaimIP: "10.213.1.8; rm", StorageDir: t.TempDir(), User: "1000:1000",
	}); err == nil || calls != nil {
		t.Fatalf("an address that is not one reached docker: %v %q", err, calls)
	}
}

// A cold push writes the build's layers through the registry's page cache,
// charged to its cgroup until written back: a registry with no ceiling of its
// own gets one a push of hundreds of megabytes fits in (a
// 256m registry was killed mid-push and the build read "connection refused").
func TestARegistryGetsACeilingAColdPushFitsIn(t *testing.T) {
	var create string
	c := CLI{Run: func(_ context.Context, _ []byte, _ string, args ...string) ([]byte, error) {
		switch args[0] {
		case "create":
			create = strings.Join(args, " ")
		case "inspect":
			return []byte(`[{"Id":"r1","Name":"/kodus-registry-1"}]`), nil
		}
		return []byte("r1"), nil
	}}
	spec := RegistrySpec{
		Name: "kodus-registry-1", Image: "registry@sha256:abc", Runtime: "runsc", Network: "n",
		ClaimNetwork: "claim-net", ClaimIP: "10.213.1.8", StorageDir: t.TempDir(), User: "1000:1000",
	}
	if _, err := c.RunRegistry(context.Background(), spec); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(create, " --memory 1g ") {
		t.Fatalf("a registry with no ceiling of its own: %q", create)
	}
	spec.MemLimit = "2g"
	if _, err := c.RunRegistry(context.Background(), spec); err != nil || !strings.Contains(create, " --memory 2g ") {
		t.Fatalf("an explicit ceiling: %v %q", err, create)
	}
}
