package dockergvisor

import (
	"archive/tar"
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver/drivertest"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockergvisor/toollayer"
)

// layerDocker is an in-memory Docker that also runs sandboxes (as holders,
// remembering their spec) and streams a prepared tar from exec -i.
type layerDocker struct {
	*memDocker
	smu      sync.Mutex
	specs    map[string]dockercli.SandboxSpec
	streamed [][]string
	tarBytes []byte
}

func (c *layerDocker) RunSandbox(ctx context.Context, s dockercli.SandboxSpec) (dockercli.Container, error) {
	c.smu.Lock()
	c.specs[s.Name] = s
	c.smu.Unlock()
	return c.RunHolder(ctx, s.HolderSpec)
}

func (c *layerDocker) ExecStream(_ context.Context, container, user string, argv ...string) (io.ReadWriteCloser, error) {
	c.smu.Lock()
	c.streamed = append(c.streamed, append([]string{container, user}, argv...))
	data := c.tarBytes
	c.smu.Unlock()
	return nopCloser{bytes.NewReader(data)}, nil
}

type nopCloser struct{ io.Reader }

func (nopCloser) Write(p []byte) (int, error) { return len(p), nil }
func (nopCloser) Close() error                { return nil }

const sandboxImage = "kodus/sandbox@sha256:def"

var imageDigest = "sha256:" + strings.Repeat("d", 64)

type layerEnv struct {
	d      *Driver
	docker *layerDocker
	clock  *time.Time
	n      int
}

func newLayerEnv(t *testing.T, withDigest bool) *layerEnv {
	t.Helper()
	docker := &layerDocker{memDocker: newMemDocker(), specs: map[string]dockercli.SandboxSpec{}}
	docker.plant(dockercli.Container{ID: "cegress", Name: "kodus-egress", Networks: map[string]string{"kodus-cell": "10.9.0.2"}})
	if withDigest {
		docker.imageIDs = map[string]string{sandboxImage: imageDigest}
	}
	now := time.Date(2026, 11, 22, 12, 0, 0, 0, time.UTC)
	env := &layerEnv{docker: docker, clock: &now}
	d, err := New(context.Background(), docker, Config{
		CellID: "cell-1", HolderImage: "kodus/holder@sha256:abc", SandboxImage: sandboxImage, WorkDir: t.TempDir(), EgressContainer: "kodus-egress",
		ToolLayers: ToolLayerConfig{Enabled: true, Now: func() time.Time { return *env.clock }},
	})
	if err != nil {
		t.Fatal(err)
	}
	env.d = d
	// The store's trees are read-only: the test's directory cannot go with them.
	t.Cleanup(func() { _ = d.layers.store.PurgeOrg("org-a") })
	return env
}

// sandboxReq is a request on a new claim of org-a.
func (e *layerEnv) sandboxReq(t *testing.T) driver.SandboxRequest {
	t.Helper()
	e.n++
	id := "lay-" + string(rune('a'+e.n))
	net, err := e.d.PrepareClaim(context.Background(), driver.ClaimNetworkSpec{CellID: "cell-1", OrgID: "org-a", ClaimID: id})
	if err != nil {
		t.Fatal(err)
	}
	s := drivertest.BaseSpec("cell-1", id, net)
	s.ExpiresAt, s.HardExpiresAt = time.Now().Add(10*time.Minute), time.Now().Add(time.Hour)
	return driver.SandboxRequest{Spec: s}
}

var buildArgv = []string{"npm", "install", "-g", "--ignore-scripts", "some-cli@1.2.3"}

func (e *layerEnv) build(t *testing.T) driver.ToolLayerBuild {
	t.Helper()
	b := driver.ToolLayerBuild{ID: "some-cli", Installer: "npm", Argv: buildArgv, Binary: "some-cli", Registry: "registry.npmjs.org"}
	key, err := toollayer.ComputeKey(toollayer.KeyInput{Installer: b.Installer, Argv: b.Argv, Binary: b.Binary, ImageDigest: imageDigest, Arch: e.d.arch(), Registry: b.Registry})
	if err != nil {
		t.Fatal(err)
	}
	b.Key = key
	return b
}

// layerArchive is what a builder's tar leaves of an npm global install.
func layerArchive(t *testing.T, trailer bool, extra ...tar.Header) []byte {
	t.Helper()
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	dir := func(name string) {
		if err := tw.WriteHeader(&tar.Header{Name: name, Typeflag: tar.TypeDir, Mode: 0o755}); err != nil {
			t.Fatal(err)
		}
	}
	dir("./")
	dir("./.local/")
	dir("./.local/bin/")
	body := "#!/usr/bin/env node\nconsole.log('hi')\n"
	if err := tw.WriteHeader(&tar.Header{Name: "./.local/bin/some-cli", Typeflag: tar.TypeReg, Mode: 0o755, Size: int64(len(body))}); err != nil {
		t.Fatal(err)
	}
	if _, err := tw.Write([]byte(body)); err != nil {
		t.Fatal(err)
	}
	for _, h := range extra {
		h := h
		if err := tw.WriteHeader(&h); err != nil {
			t.Fatal(err)
		}
	}
	if trailer {
		if err := tw.Close(); err != nil {
			t.Fatal(err)
		}
	} else if err := tw.Flush(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// ingest stores a layer for b through a builder sandbox, as a build would.
func (e *layerEnv) ingest(t *testing.T, b driver.ToolLayerBuild, archive []byte) (driver.ToolLayerBuilt, error) {
	t.Helper()
	req := e.sandboxReq(t)
	req.Build = &b
	ref, err := e.d.CreateSandbox(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	e.docker.smu.Lock()
	e.docker.tarBytes = archive
	e.docker.smu.Unlock()
	return toolLayerPart{e.d}.Ingest(context.Background(), "org-a", ref, b, driver.ToolLayerIntegrity{})
}

// reasonOf is the code Ingest reports for a failure.
func reasonOf(err error) string {
	var te *driver.ToolLayerError
	if errors.As(err, &te) {
		return te.Reason
	}
	return ""
}

func binds2(s dockercli.SandboxSpec) []string { return s.Mounts }

// A hit is a read-only bind of the verified tree at /opt/kcli/<id>, answered
// with where the CLI is; the container says which layers it mounts, and the
// layer stays out of garbage collection until the sandbox is destroyed.
func TestAReviewSandboxMountsAHitReadOnlyAndHoldsIt(t *testing.T) {
	e := newLayerEnv(t, true)
	b := e.build(t)
	if _, err := e.ingest(t, b, layerArchive(t, true)); err != nil {
		t.Fatal(err)
	}
	req := e.sandboxReq(t)
	req.ToolLayers = []driver.ToolLayerRef{{Key: b.Key, ID: "some-cli"}}
	ref, err := e.d.CreateSandbox(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	spec := e.docker.specs[ref.MachineID]
	var tree string
	for _, m := range binds2(spec) {
		if strings.HasSuffix(m, ":/opt/kcli/some-cli") {
			tree = strings.TrimSuffix(m, ":/opt/kcli/some-cli")
		}
	}
	root, _ := filepath.EvalSymlinks(e.d.layers.store.Root())
	if tree == "" || !strings.HasPrefix(tree, root+string(filepath.Separator)) || !strings.HasSuffix(tree, string(filepath.Separator)+"tree") {
		t.Fatalf("mounts %v: no bind of a tree under the store", spec.Mounts)
	}
	if len(spec.Tmpfs) != 0 {
		t.Fatalf("a review got tmpfs %v", spec.Tmpfs)
	}
	st := toolLayerPart{e.d}.States(ref)
	if len(st) != 1 || !st[0].Hit || st[0].BinaryPath != "/opt/kcli/some-cli/.local/bin/some-cli" || st[0].Interpreter != "node" || len(st[0].Digest) != 64 {
		t.Fatalf("states %+v", st)
	}
	if got := spec.Labels[labelToolLayers]; got != st[0].Digest {
		t.Fatalf("label %q, want the layer's digest %q", got, st[0].Digest)
	}

	// Held: a collection 40 days on keeps the layer a live sandbox mounts, and
	// takes it once the sandbox is gone.
	*e.clock = e.clock.Add(40 * 24 * time.Hour)
	if _, err := e.d.layers.store.GC(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(tree); err != nil {
		t.Fatalf("GC removed a mounted layer: %v", err)
	}
	if err := e.d.Destroy(context.Background(), ref); err != nil {
		t.Fatal(err)
	}
	if _, err := e.d.layers.store.GC(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(tree); err == nil {
		t.Fatal("the layer was still held after its sandbox was destroyed")
	}
}

// A miss is recorded, reported with its reason, and asks for a build on the
// second miss of the key (U9). The sandbox still starts, with no layer bind.
func TestAMissIsRecordedAndReported(t *testing.T) {
	e := newLayerEnv(t, true)
	b := e.build(t)
	for i, wantBuild := range []bool{false, true} {
		req := e.sandboxReq(t)
		req.ToolLayers = []driver.ToolLayerRef{{Key: b.Key, ID: "some-cli"}}
		ref, err := e.d.CreateSandbox(context.Background(), req)
		if err != nil {
			t.Fatal(err)
		}
		st := toolLayerPart{e.d}.States(ref)
		if len(st) != 1 || st[0].Hit || st[0].Reason != "no_key" || st[0].Build != wantBuild {
			t.Fatalf("miss %d: states %+v", i+1, st)
		}
		for _, m := range e.docker.specs[ref.MachineID].Mounts {
			if strings.Contains(m, "/opt/kcli") {
				t.Fatalf("a miss mounted %s", m)
			}
		}
		if _, ok := e.docker.specs[ref.MachineID].Labels[labelToolLayers]; ok {
			t.Fatal("a miss labelled the sandbox with layers")
		}
	}
}

// No digest for the image: no layer is built or mounted, every request
// answers miss and nothing is recorded (U6).
func TestWithoutAnImageDigestEveryRequestIsAMiss(t *testing.T) {
	e := newLayerEnv(t, false)
	if got := (toolLayerPart{e.d}).ImageDigest(); got != "" {
		t.Fatalf("digest %q", got)
	}
	req := e.sandboxReq(t)
	req.ToolLayers = []driver.ToolLayerRef{{Key: strings.Repeat("a", 64), ID: "some-cli"}}
	ref, err := e.d.CreateSandbox(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	st := toolLayerPart{e.d}.States(ref)
	if len(st) != 1 || st[0].Hit || st[0].Reason != "no_image_digest" || st[0].Build {
		t.Fatalf("states %+v", st)
	}
	if ents, _ := os.ReadDir(e.d.layers.store.Root()); len(ents) != 0 {
		t.Fatalf("the store recorded something without a digest: %v", ents)
	}
	b := driver.ToolLayerBuild{Key: strings.Repeat("a", 64), ID: "some-cli", Installer: "npm", Argv: buildArgv, Binary: "some-cli", Registry: "registry.npmjs.org"}
	if err := (toolLayerPart{e.d}).CheckBuild(b); err == nil {
		t.Fatal("a build was admitted without an image digest")
	}
	req = e.sandboxReq(t)
	req.Build = &b
	if _, err := e.d.CreateSandbox(context.Background(), req); err == nil {
		t.Fatal("a builder was made without an image digest")
	}
}

// Without the feature on the driver keeps no part and every request is a
// disabled miss, never an error.
func TestWithTheFeatureOffRequestsAreDisabledMisses(t *testing.T) {
	docker := &layerDocker{memDocker: newMemDocker(), specs: map[string]dockercli.SandboxSpec{}}
	docker.plant(dockercli.Container{ID: "cegress", Name: "kodus-egress", Networks: map[string]string{"kodus-cell": "10.9.0.2"}})
	d, err := New(context.Background(), docker, Config{CellID: "cell-1", HolderImage: "h@sha256:abc", SandboxImage: sandboxImage, WorkDir: t.TempDir(), EgressContainer: "kodus-egress"})
	if err != nil {
		t.Fatal(err)
	}
	if d.Parts().ToolLayers != nil {
		t.Fatal("a part with the feature off")
	}
	e := &layerEnv{d: d, docker: docker}
	req := e.sandboxReq(t)
	req.ToolLayers = []driver.ToolLayerRef{{Key: strings.Repeat("a", 64), ID: "some-cli"}}
	ref, err := d.CreateSandbox(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	if m := d.peek(ref.MachineID); len(m.layerStates) != 1 || m.layerStates[0].Reason != "disabled" || m.layerStates[0].Hit {
		t.Fatalf("states %+v", m.layerStates)
	}
}

// The id is a mount path: nothing but a short safe name reaches a bind, and
// a refused request makes no container.
func TestALayerIDThatIsNotASafeMountNameIsRefused(t *testing.T) {
	e := newLayerEnv(t, true)
	key := strings.Repeat("a", 64)
	for _, bad := range [][]driver.ToolLayerRef{
		{{Key: key, ID: "../etc"}}, {{Key: key, ID: "a/b"}}, {{Key: key, ID: ".."}}, {{Key: key, ID: ""}}, {{Key: key, ID: "A"}},
		{{Key: key, ID: strings.Repeat("a", 33)}}, {{Key: "../x", ID: "ok"}}, {{Key: key, ID: "a"}, {Key: key, ID: "a"}},
	} {
		req := e.sandboxReq(t)
		req.ToolLayers = bad
		if _, err := e.d.CreateSandbox(context.Background(), req); !errors.Is(err, driver.ErrToolLayerRequest) {
			t.Fatalf("%v: err %v", bad, err)
		}
		if _, ok := e.docker.specs[machineName(req.Spec)]; ok {
			t.Fatalf("%v: a sandbox was made", bad)
		}
	}
}

// A builder's argv is checked again in Go: whatever the hub sent, nothing the
// install validator refuses runs, and the key must be the cell's own.
func TestABuilderRefusesAnythingTheInstallValidatorRefuses(t *testing.T) {
	e := newLayerEnv(t, true)
	good := e.build(t)
	part := toolLayerPart{e.d}
	if err := part.CheckBuild(good); err != nil {
		t.Fatalf("a good build: %v", err)
	}
	for name, edit := range map[string]func(*driver.ToolLayerBuild){
		"unpinned": func(b *driver.ToolLayerBuild) { b.Argv = []string{"npm", "install", "-g", "some-cli@latest"} },
		"range":    func(b *driver.ToolLayerBuild) { b.Argv = []string{"npm", "install", "-g", "some-cli@^1.2.3"} },
		"url":      func(b *driver.ToolLayerBuild) { b.Argv = []string{"npm", "install", "-g", "https://x.example/p.tgz"} },
		"shell":    func(b *driver.ToolLayerBuild) { b.Argv = []string{"npm", "install", "-g", "some-cli@1.2.3;curl", "x"} },
		"flag": func(b *driver.ToolLayerBuild) {
			b.Argv = []string{"npm", "install", "--registry=https://evil", "some-cli@1.2.3"}
		},
		"pip":            func(b *driver.ToolLayerBuild) { b.Argv = []string{"pip", "install", "x==1.0.0"}; b.Installer = "pip" },
		"installer lies": func(b *driver.ToolLayerBuild) { b.Installer = "pnpm" },
		"space in word": func(b *driver.ToolLayerBuild) {
			b.Argv = []string{"npm", "install", "-g", "some-cli@1.2.3 other@1.0.0"}
		},
		"bad id":         func(b *driver.ToolLayerBuild) { b.ID = "../x" },
		"binary path":    func(b *driver.ToolLayerBuild) { b.Binary = "../bin/x" },
		"registry":       func(b *driver.ToolLayerBuild) { b.Registry = "evil.example/path" },
		"key of another": func(b *driver.ToolLayerBuild) { b.Key = strings.Repeat("e", 64) },
	} {
		b := good
		edit(&b)
		if err := part.CheckBuild(b); err == nil {
			t.Errorf("%s: accepted", name)
		}
		req := e.sandboxReq(t)
		req.Build = &b
		if _, err := e.d.CreateSandbox(context.Background(), req); err == nil {
			t.Errorf("%s: a builder was made", name)
		}
	}
}

// The builder installs into a tmpfs sized by the layer cap and mounts
// nothing else of the host; it never takes the cell's trust files (that is
// what a secret's claim gets), and a request cannot be both a builder and a
// review.
func TestABuilderGetsOnlyATmpfsAndNeverSecrets(t *testing.T) {
	e := newLayerEnv(t, true)
	b := e.build(t)
	req := e.sandboxReq(t)
	req.Build = &b
	ref, err := e.d.CreateSandbox(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	spec := e.docker.specs[ref.MachineID]
	if len(spec.Tmpfs) != 1 || spec.Tmpfs[0].Dir != "/opt/kcli/some-cli" || spec.Tmpfs[0].Size != "256m" {
		t.Fatalf("tmpfs %+v", spec.Tmpfs)
	}
	if len(spec.Mounts) != 0 {
		t.Fatalf("a builder mounts %v", spec.Mounts)
	}
	if _, err := dockercli.SandboxArgs(spec); err != nil {
		t.Fatalf("the docker run is refused: %v", err)
	}

	for name, edit := range map[string]func(*driver.SandboxRequest){
		"cell trust":  func(r *driver.SandboxRequest) { r.CellTrust = true },
		"also layers": func(r *driver.SandboxRequest) { r.ToolLayers = []driver.ToolLayerRef{{Key: b.Key, ID: "other"}} },
	} {
		r := e.sandboxReq(t)
		r.Build = &b
		edit(&r)
		if _, err := e.d.CreateSandbox(context.Background(), r); !errors.Is(err, driver.ErrToolLayerRequest) {
			t.Errorf("%s: err %v", name, err)
		}
	}
}

// What the builder's tar holds goes through the store's extractor: a normal
// tree becomes a layer the next review hits, and one the extractor refuses
// leaves nothing behind.
func TestABuildersTarGoesThroughTheExtractorOrLeavesNothing(t *testing.T) {
	e := newLayerEnv(t, true)
	b := e.build(t)
	_, err := e.ingest(t, b, layerArchive(t, true, tar.Header{Name: "./.local/evil", Typeflag: tar.TypeSymlink, Linkname: "/workspace/x", Mode: 0o777}))
	if reasonOf(err) != "symlink_absolute" {
		t.Fatalf("a symlink to /workspace: %v", err)
	}
	_, err = e.ingest(t, b, layerArchive(t, false))
	if reasonOf(err) != "tar_truncated" {
		t.Fatalf("a tar with no trailer (tar failed halfway): %v", err)
	}
	if _, err := e.d.layers.store.Lookup(context.Background(), "org-a", b.Key); !errors.Is(err, toollayer.ErrMiss) {
		t.Fatalf("a refused build left a layer: %v", err)
	}

	built, err := e.ingest(t, b, layerArchive(t, true))
	if err != nil || len(built.Digest) != 64 || built.Bytes <= 0 {
		t.Fatalf("a normal tree: %+v, %v", built, err)
	}
	// The stream ran tar on the guest side, as the tool user, for exactly the layer's directory.
	last := e.docker.streamed[len(e.docker.streamed)-1]
	if got := strings.Join(last[1:], " "); got != "1000:1000 tar -cf - -C /opt/kcli/some-cli ." {
		t.Fatalf("streamed %q", got)
	}
	hit, err := e.d.layers.store.Lookup(context.Background(), "org-a", b.Key)
	if err != nil {
		t.Fatal(err)
	}
	hit.Release()
	if _, err := e.d.layers.store.Lookup(context.Background(), "org-b", b.Key); !errors.Is(err, toollayer.ErrMiss) {
		t.Fatalf("another org's key resolved: %v", err)
	}
}

// Only the builder machine of that very layer may be read out.
func TestIngestReadsOnlyTheBuilderOfThatLayer(t *testing.T) {
	e := newLayerEnv(t, true)
	b := e.build(t)
	req := e.sandboxReq(t)
	ref, err := e.d.CreateSandbox(context.Background(), req) // a plain sandbox
	if err != nil {
		t.Fatal(err)
	}
	e.docker.tarBytes = layerArchive(t, true)
	if _, err := (toolLayerPart{e.d}).Ingest(context.Background(), "org-a", ref, b, driver.ToolLayerIntegrity{}); reasonOf(err) != "invalid_request" {
		t.Fatalf("a review sandbox was read out as a builder: %v", err)
	}
}

// One build per key at a time; the driver says why it refuses.
func TestBeginBuildSaysWhyItRefuses(t *testing.T) {
	e := newLayerEnv(t, true)
	part := toolLayerPart{e.d}
	end, err := part.BeginBuild("org-a", strings.Repeat("a", 64))
	if err != nil {
		t.Fatal(err)
	}
	_, err = part.BeginBuild("org-a", strings.Repeat("a", 64))
	var r *driver.ErrBuildRefused
	if !errors.As(err, &r) || r.Reason != "in_flight" {
		t.Fatalf("err %v", err)
	}
	end(true)
	if _, err = part.BeginBuild("org-a", strings.Repeat("a", 64)); !errors.As(err, &r) || r.Reason != "recent_failure" {
		t.Fatalf("err %v", err)
	}
}

// A sandbox that went away without Destroy (docker rm by hand) lets go of
// its layers at the next sweep.
func TestASweepReleasesTheHoldsOfAVanishedSandbox(t *testing.T) {
	e := newLayerEnv(t, true)
	b := e.build(t)
	if _, err := e.ingest(t, b, layerArchive(t, true)); err != nil {
		t.Fatal(err)
	}
	req := e.sandboxReq(t)
	req.ToolLayers = []driver.ToolLayerRef{{Key: b.Key, ID: "some-cli"}}
	ref, err := e.d.CreateSandbox(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	st := toolLayerPart{e.d}.States(ref)
	tree := filepath.Join(e.d.layers.store.OrgDir("org-a"), "layers", st[0].Digest, "tree")
	_ = e.docker.Remove(context.Background(), ref.MachineID)
	*e.clock = e.clock.Add(40 * 24 * time.Hour)
	if err := e.d.sweepToolLayers(context.Background(), *e.clock); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(tree); err == nil {
		t.Fatal("the vanished sandbox still held its layer")
	}
}

// The org purge reaches the store.
func TestPurgeOrgRemovesTheOrgsLayers(t *testing.T) {
	e := newLayerEnv(t, true)
	b := e.build(t)
	if _, err := e.ingest(t, b, layerArchive(t, true)); err != nil {
		t.Fatal(err)
	}
	if err := (toolLayerPart{e.d}).PurgeOrg("org-a"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(e.d.layers.store.OrgDir("org-a")); err == nil {
		t.Fatal("the org's directory survived the purge")
	}
}
