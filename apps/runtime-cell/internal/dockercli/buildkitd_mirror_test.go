package dockercli

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestBuildkitdMirrorConfig(t *testing.T) {
	conf, err := buildkitdMirrorConfig("mirror.cell.internal:8080")
	if err != nil {
		t.Fatal(err)
	}
	want := "[registry.\"docker.io\"]\n  mirrors = [\"mirror.cell.internal:8080\"]\n\n[registry.\"mirror.cell.internal:8080\"]\n  http = true\n"
	if string(conf) != want {
		t.Fatalf("config:\n%s\nwant:\n%s", conf, want)
	}
	for _, bad := range []string{"", "mirror", "http://mirror:8080", "m:8080\"]\n[x]", "a b:1"} {
		if _, err := buildkitdMirrorConfig(bad); err == nil || !strings.Contains(err.Error(), "host:port") {
			t.Errorf("%q accepted", bad)
		}
	}
}

// A persisted state is mounted at the rootless daemon's root and bounded by
// BuildKit's own GC; a bad bound never reaches the config.
func TestRunBuildMountsThePersistedState(t *testing.T) {
	var got []string
	c := CLI{Run: func(_ context.Context, _ []byte, _ string, args ...string) ([]byte, error) {
		got = args
		return nil, nil
	}}
	out := t.TempDir()
	b := BuildRun{
		Image: "buildkit", Runtime: "runsc", Network: "n", Address: "10.0.0.9", Resolv: "/r", Context: "/c", Dockerfile: "Dockerfile",
		Tag: "t:claim", Out: out, StateDir: "/state/env-1", GCKeepStorage: "20GB",
	}
	if err := c.RunBuild(context.Background(), b); err != nil {
		t.Fatal(err)
	}
	if j := strings.Join(got, " "); !strings.Contains(j, "-v /state/env-1:"+BuildkitStateRoot) || !strings.Contains(j, "--config /out/"+BuildkitdConfig) {
		t.Fatalf("args: %s", j)
	}
	conf, err := os.ReadFile(filepath.Join(out, BuildkitdConfig))
	if err != nil || !strings.Contains(string(conf), "[worker.oci]\n  gc = true\n  gckeepstorage = \"20GB\"") {
		t.Fatalf("config %q %v", conf, err)
	}
	b.GCKeepStorage = "20GB\"\n[x]"
	if err := c.RunBuild(context.Background(), b); err == nil {
		t.Fatal("a bad keep storage reached the config")
	}
}

// The build's progress is BuildKit's plain one, whatever buildctl would
// pick without a TTY: build.steps reads its "#N ... DONE 1.2s" lines.
func TestRunBuildAsksForPlainProgress(t *testing.T) {
	var got []string
	c := CLI{Run: func(_ context.Context, _ []byte, _ string, args ...string) ([]byte, error) {
		got = args
		return nil, nil
	}}
	b := BuildRun{Image: "buildkit", Runtime: "runsc", Network: "n", Address: "10.0.0.9", Resolv: "/r", Context: "/c", Dockerfile: "Dockerfile", Tag: "t", Out: t.TempDir()}
	if err := c.RunBuild(context.Background(), b); err != nil {
		t.Fatal(err)
	}
	if j := strings.Join(got, " "); !strings.Contains(j, "buildkit build --progress plain --frontend dockerfile.v0") {
		t.Fatalf("args: %s", j)
	}
}

// The builder kept every capability Docker gives a container; it now drops
// the ones runsc already disables, and a writable-layer cap reaches docker
// only when it is a size.
func TestRunBuildDropsCapabilitiesAndCapsItsDisk(t *testing.T) {
	var got []string
	c := CLI{Run: func(_ context.Context, _ []byte, _ string, args ...string) ([]byte, error) {
		got = args
		return nil, nil
	}}
	b := BuildRun{Image: "buildkit", Runtime: "runsc", Network: "n", Address: "10.0.0.9", Resolv: "/r", Context: "/c", Dockerfile: "Dockerfile", Tag: "t", Out: t.TempDir()}
	if err := c.RunBuild(context.Background(), b); err != nil {
		t.Fatal(err)
	}
	j := strings.Join(got, " ")
	if !strings.Contains(j, "--cap-drop NET_RAW --cap-drop AUDIT_WRITE") || strings.Contains(j, "--storage-opt") || strings.Contains(j, "no-new-privileges") {
		t.Fatalf("args: %s", j)
	}
	b.DiskSize = "50G"
	if err := c.RunBuild(context.Background(), b); err != nil {
		t.Fatal(err)
	}
	if j := strings.Join(got, " "); !strings.Contains(j, "--storage-opt size=50G") {
		t.Fatalf("args: %s", j)
	}
	got = nil
	b.DiskSize = "50G --privileged"
	if err := c.RunBuild(context.Background(), b); err == nil || got != nil {
		t.Fatalf("a bad disk size reached docker: %v %v", err, got)
	}
}

func TestRunHolderCapsItsDiskOnlyWhenAsked(t *testing.T) {
	var runs []string
	c := CLI{Run: func(_ context.Context, _ []byte, _ string, args ...string) ([]byte, error) {
		runs = append(runs, strings.Join(args, " "))
		if args[0] == "inspect" {
			return []byte(`[{"Id":"abc","Name":"/h","Config":{"Image":"i","Labels":{}},"NetworkSettings":{"Networks":{}}}]`), nil
		}
		return []byte("abc\n"), nil
	}}
	h := HolderSpec{Name: "h", Image: "i", Network: "n", Runtime: "runsc"}
	if _, err := c.RunHolder(context.Background(), h); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(runs[0], "--storage-opt") {
		t.Fatalf("an uncapped holder: %s", runs[0])
	}
	runs = nil
	h.DiskSize = "10G"
	if _, err := c.RunHolder(context.Background(), h); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(runs[0], "--storage-opt size=10G") {
		t.Fatalf("capped holder: %s", runs[0])
	}
	h.DiskSize = "ten"
	if _, err := c.RunHolder(context.Background(), h); err == nil {
		t.Fatal("a bad disk size was taken")
	}
}

// The cell's trust bundle reaches the builder read-only: BuildKit's own TLS
// reads it (SSL_CERT_FILE) and the config hands it to every RUN step
// (execCABundle, builder-image/exec-ca-bundle.patch), in the one [worker.oci]
// table the GC bound shares. Without it the builder gets neither.
func TestRunBuildGivesTheBuilderTheCellTrustBundle(t *testing.T) {
	var got []string
	c := CLI{Run: func(_ context.Context, _ []byte, _ string, args ...string) ([]byte, error) {
		got = args
		return nil, nil
	}}
	out := t.TempDir()
	b := BuildRun{
		Image: "buildkit", Runtime: "runsc", Network: "n", Address: "10.0.0.9", Resolv: "/r", Context: "/c", Dockerfile: "Dockerfile",
		Tag: "t:claim", Out: out, StateDir: "/state/env-1", GCKeepStorage: "20GB", CABundle: "/cell/trust/ca-bundle.pem",
	}
	if err := c.RunBuild(context.Background(), b); err != nil {
		t.Fatal(err)
	}
	j := strings.Join(got, " ")
	if !strings.Contains(j, "-v /cell/trust/ca-bundle.pem:"+BuilderCABundle+":ro") || !strings.Contains(j, "-e SSL_CERT_FILE="+BuilderCABundle) {
		t.Fatalf("args: %s", j)
	}
	conf, err := os.ReadFile(filepath.Join(out, BuildkitdConfig))
	if err != nil || !strings.Contains(string(conf), "[worker.oci]\n  gc = true\n  gckeepstorage = \"20GB\"\n  execCABundle = \""+BuilderCABundle+"\"\n") || strings.Count(string(conf), "[worker.oci]") != 1 {
		t.Fatalf("config %q %v", conf, err)
	}
	b.CABundle, b.StateDir = "", ""
	_ = os.Remove(filepath.Join(out, BuildkitdConfig))
	if err := c.RunBuild(context.Background(), b); err != nil {
		t.Fatal(err)
	}
	if j := strings.Join(got, " "); strings.Contains(j, BuilderCABundle) || strings.Contains(j, "SSL_CERT_FILE") {
		t.Fatalf("a build without the bundle got it: %s", j)
	}
}

// G6: each of the claim's secrets is a BuildKit secret of its own id, read by
// buildctl from a builder variable of the cell's naming (so no id replaces
// PATH or BUILDKITD_FLAGS); an id that would break buildctl's list is refused.
func TestRunBuildOffersTheClaimsSecretsByID(t *testing.T) {
	var got []string
	c := CLI{Run: func(_ context.Context, _ []byte, _ string, args ...string) ([]byte, error) {
		got = args
		return nil, nil
	}}
	b := BuildRun{
		Image: "buildkit", Runtime: "runsc", Network: "n", Address: "10.0.0.9", Resolv: "/r", Context: "/c", Dockerfile: "Dockerfile", Tag: "t", Out: t.TempDir(),
		Secrets: map[string]string{"PATH": "kodus-ph-b", "NPM_TOKEN": "kodus-ph-a"},
	}
	if err := c.RunBuild(context.Background(), b); err != nil {
		t.Fatal(err)
	}
	j := strings.Join(got, " ")
	for _, want := range []string{
		"-e KODUS_BUILD_SECRET_0=kodus-ph-a", "-e KODUS_BUILD_SECRET_1=kodus-ph-b",
		"--secret id=NPM_TOKEN,env=KODUS_BUILD_SECRET_0", "--secret id=PATH,env=KODUS_BUILD_SECRET_1",
	} {
		if !strings.Contains(j, want) {
			t.Errorf("no %q in %s", want, j)
		}
	}
	if strings.Contains(j, "-e PATH=") || strings.Contains(j, "-e NPM_TOKEN=") {
		t.Fatalf("a secret id became a builder variable: %s", j)
	}
	for _, bad := range []string{"A,env=PATH", "a=b", "", "1A"} {
		b.Secrets = map[string]string{bad: "kodus-ph-a"}
		if err := c.RunBuild(context.Background(), b); err == nil {
			t.Errorf("secret id %q accepted", bad)
		}
	}
}

// runsc runs with --oci-seccomp (the cell refuses a host without it), which
// applies Docker's default profile inside the sandbox; buildkitd needs the
// mount and unshare that profile refuses, so the builder alone asks for none
// (as it had before runsc applied profiles). It stays in gVisor with its
// capability drops, on the claim's network only.
func TestRunBuildRunsWithoutDockersSeccompProfile(t *testing.T) {
	var got []string
	c := CLI{Run: func(_ context.Context, _ []byte, _ string, args ...string) ([]byte, error) {
		got = args
		return nil, nil
	}}
	b := BuildRun{Image: "buildkit", Runtime: "runsc", Network: "n", Address: "10.0.0.9", Resolv: "/r", Context: "/c", Dockerfile: "Dockerfile", Tag: "t", Out: t.TempDir()}
	if err := c.RunBuild(context.Background(), b); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.Join(got, " "), "--security-opt seccomp=unconfined") {
		t.Fatalf("the builder gets Docker's default profile, which refuses buildkitd's mounts: %s", strings.Join(got, " "))
	}
}
