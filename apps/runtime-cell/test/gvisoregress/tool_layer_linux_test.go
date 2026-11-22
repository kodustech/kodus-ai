//go:build linux

package gvisoregress

import (
	"context"
	"os"
	"path"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver/drivertest"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockergvisor"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockergvisor/toollayer"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/guest"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// A tool layer on runsc (docs/runtime/persistent-state.md sections 4 and 8.2):
// a tiny pinned npm CLI is installed in a builder sandbox that reaches the
// registry alone, the builder is sealed, its /opt/kcli/<id> is read out
// through the store's extractor, and a review sandbox of the same org mounts
// the result. The review sees the layer read-only with no exec bit, runs the
// CLI as `node <script>` with no network at all, cannot change what the next
// sandbox mounts, and another org's sandbox cannot ask for it. Opt-in, on a
// Linux Docker with runsc that reaches registry.npmjs.org, with the tool
// image built (docker buildx bake runtime-sandbox):
//
//	KODY_E2E_GVISOR=1 KODY_E2E_SANDBOX_IMAGE=<tool image> go test -run TestAToolLayerIsBuiltCleanAndMountedReadOnly -v ./test/gvisoregress/
func TestAToolLayerIsBuiltCleanAndMountedReadOnly(t *testing.T) {
	if os.Getenv("KODY_E2E_GVISOR") != "1" {
		t.Skip("KODY_E2E_GVISOR=1 runs it on a Linux Docker with runsc")
	}
	image := os.Getenv("KODY_E2E_SANDBOX_IMAGE")
	if image == "" {
		t.Skip("KODY_E2E_SANDBOX_IMAGE names the sandbox tool image (docker buildx bake runtime-sandbox)")
	}
	const (
		cell, org, registry = "cell-layer", "org-layer", "registry.npmjs.org"
		id                  = "semver"
		pkg                 = "semver@7.6.3"
	)
	ctx := context.Background()
	dir := t.TempDir()
	e := startEgress(t, dir, "kodus-egress-layer")
	d, err := dockergvisor.New(ctx, dockercli.CLI{}, dockergvisor.Config{
		CellID: cell, HolderImage: "alpine:3.20", SandboxImage: image,
		WorkDir: filepath.Join(dir, "cell"), EgressContainer: e.name,
		MemLimit: "1g", CPUs: "1", MemMax: "2g", CPUsMax: 2,
		ToolLayers: dockergvisor.ToolLayerConfig{Enabled: true},
	})
	if err != nil {
		t.Fatal(err)
	}
	layers := d.Parts().ToolLayers
	if layers == nil || layers.ImageDigest() == "" {
		t.Fatal("the driver keeps no layers or could not read the sandbox image's digest")
	}
	// The layers' trees are read-only: the test's directory cannot go with them.
	t.Cleanup(func() { _ = layers.PurgeOrg(org); _ = layers.PurgeOrg("org-other") })

	build := driver.ToolLayerBuild{
		ID: id, Installer: "npm", Argv: []string{"npm", "install", "-g", "--ignore-scripts", pkg}, Binary: "semver", Registry: registry,
	}
	build.Key, err = toollayer.ComputeKey(toollayer.KeyInput{
		Installer: build.Installer, Argv: build.Argv, Binary: build.Binary, ImageDigest: layers.ImageDigest(),
		Arch: d.Capabilities().HostArch, Registry: build.Registry,
	})
	if err != nil {
		t.Fatal(err)
	}

	// sandbox makes a sandbox of orgID on a claim network of its own and a
	// client to its guest agent; both go with the test.
	n := 0
	sandbox := func(t *testing.T, orgID string, net func(driver.ClaimNetwork), edit func(*driver.SandboxRequest)) (driver.MachineRef, func(string) protocol.SandboxExecResult) {
		t.Helper()
		claim := "claim-layer-" + string(rune('a'+n))
		n++
		cn, err := d.PrepareClaim(ctx, driver.ClaimNetworkSpec{CellID: cell, OrgID: orgID, ClaimID: claim})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = d.ReleaseClaim(context.WithoutCancel(ctx), cn) })
		spec := drivertest.BaseSpec(cell, claim, cn)
		spec.OrgID, spec.ExpiresAt, spec.HardExpiresAt = orgID, time.Now().Add(10*time.Minute), time.Now().Add(time.Hour)
		req := driver.SandboxRequest{Spec: spec}
		edit(&req)
		ref, err := d.CreateSandbox(ctx, req)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = d.Destroy(context.WithoutCancel(ctx), ref) })
		if net != nil {
			net(cn)
		}
		rw, err := d.DialGuest(ctx, ref)
		if err != nil {
			t.Fatal(err)
		}
		cl := guest.NewClient(rw, cell, claim)
		t.Cleanup(func() { _ = cl.Close() })
		return ref, func(cmd string) protocol.SandboxExecResult {
			t.Helper()
			ms := int64(5 * 60 * 1000)
			r, err := cl.Do(ctx, guest.NewID(), protocol.SandboxOp{Op: protocol.SandboxOpKindExec, Command: &cmd, TimeoutMs: &ms})
			if err != nil || r.Exec == nil {
				t.Fatalf("exec %q: %v %+v", cmd, err, r)
			}
			return *r.Exec
		}
	}

	// The builder: the registry host is all its egress allows, and its machine
	// has no secret and no checkout.
	var builderNet driver.ClaimNetwork
	var builderRef driver.MachineRef
	builderRef, run := sandbox(t, org, func(cn driver.ClaimNetwork) { builderNet = cn }, func(r *driver.SandboxRequest) { r.Build = &build })
	prefix := path.Join(driver.ToolLayerMountDir, id)
	home := "/workspace/.kcli/" + id
	env := "HOME=" + home + " PATH=" + prefix + "/.local/bin:/usr/local/bin:/usr/bin:/bin NPM_CONFIG_PREFIX=" + prefix + "/.local NPM_CONFIG_CACHE=" + home + "/.cache/npm NPM_CONFIG_REGISTRY=https://" + registry + "/"
	if err := (pushedEgress{e}).Allow(ctx, "claim-layer-a", org, builderNet, []string{builderRef.PrivateAddress}, []string{registry}); err != nil {
		t.Fatal(err)
	}
	if r := run("set -eu; mkdir -p " + prefix + "/.local/bin " + home + "/.cache/npm; cd " + prefix + "; /usr/bin/env -i " + env + " /usr/bin/timeout -k 5 300 npm install -g --ignore-scripts " + pkg); r.ExitCode != 0 {
		t.Fatalf("install: exit %d\n%s", r.ExitCode, r.Stderr)
	}
	// The builder reaches nothing but its registry; sealed, not even that.
	if r := run("wget -q -T 5 -O /dev/null https://example.com/ 2>&1; echo $?"); strings.TrimSpace(r.Stdout) == "0" {
		t.Fatal("the builder reached a host that is not its registry")
	}
	if err := (pushedEgress{e}).Allow(ctx, "claim-layer-a", org, builderNet, []string{builderRef.PrivateAddress}, nil); err != nil {
		t.Fatal(err)
	}
	built, err := layers.Ingest(ctx, org, builderRef, build, driver.ToolLayerIntegrity{LockfileIntegrity: true})
	if err != nil {
		t.Fatalf("ingest: %v", err)
	}
	if len(built.Digest) != 64 || built.Bytes <= 0 {
		t.Fatalf("built %+v", built)
	}

	// A review of the same org mounts the layer; no egress policy is ever
	// pushed for it, so it runs sealed.
	review := func(t *testing.T) (driver.ToolLayerState, func(string) protocol.SandboxExecResult) {
		ref, run := sandbox(t, org, nil, func(r *driver.SandboxRequest) { r.ToolLayers = []driver.ToolLayerRef{{Key: build.Key, ID: id}} })
		st := layers.States(ref)
		if len(st) != 1 || !st[0].Hit || st[0].Interpreter != "node" || st[0].Digest != built.Digest || !strings.HasPrefix(st[0].BinaryPath, prefix+"/") {
			t.Fatalf("states %+v", st)
		}
		return st[0], run
	}
	st, run := review(t)
	// The CLI runs as `node <script>`, with no network.
	if r := run(st.Interpreter + " " + st.BinaryPath + " -i minor 1.2.3"); r.ExitCode != 0 || strings.TrimSpace(r.Stdout) != "1.3.0" {
		t.Fatalf("the CLI: exit %d stdout %q stderr %q", r.ExitCode, r.Stdout, r.Stderr)
	}
	// Read-only: the mount is ro, so no write lands even where the 0555 mode bits answer first
	// (a new file in a directory gets EACCES before EROFS); chmod reaches the mount and gets EROFS.
	if r := run("grep -E ' " + prefix + " [^ ]+ ro[, ]' /proc/mounts"); r.ExitCode != 0 {
		t.Fatalf("the layer is not mounted read-only: %q", r.Stdout+r.Stderr)
	}
	if r := run("touch " + prefix + "/x 2>&1"); r.ExitCode == 0 {
		t.Fatalf("a write to the layer succeeded: %q", r.Stdout+r.Stderr)
	}
	// EPERM when the cell's user is not the sandbox user (the files are not its own), EROFS when it is.
	if r := run("chmod u+w " + st.BinaryPath + " 2>&1"); r.ExitCode == 0 || !(strings.Contains(r.Stdout+r.Stderr, "Read-only file system") || strings.Contains(r.Stdout+r.Stderr, "Operation not permitted")) {
		t.Fatalf("chmod on the layer: exit %d %q", r.ExitCode, r.Stdout+r.Stderr)
	}
	if r := run("test ! -x " + st.BinaryPath + " && test -r " + st.BinaryPath); r.ExitCode != 0 {
		t.Fatalf("the script has an exec bit or is unreadable: %+v", r)
	}
	// Whatever a review does to the layer, the next sandbox mounts the original bytes.
	sum := "sha256sum " + st.BinaryPath
	before := run(sum).Stdout
	run("rm -rf " + prefix + "/.local 2>&1; chmod -R u+w " + prefix + " 2>&1; echo tampered >> " + st.BinaryPath + " 2>&1")
	st2, run2 := review(t)
	if after := run2("sha256sum " + st2.BinaryPath).Stdout; after != before || before == "" {
		t.Fatalf("the layer changed under a review: %q then %q", before, after)
	}
	if r := run2("getent hosts " + registry); r.ExitCode == 0 {
		t.Fatal("a sealed review resolved a host")
	}

	// Another org's key finds nothing: the layer is not asked for by name, and the key resolves in the org's own directory.
	ref, _ := sandbox(t, "org-other", nil, func(r *driver.SandboxRequest) { r.ToolLayers = []driver.ToolLayerRef{{Key: build.Key, ID: id}} })
	if st := layers.States(ref); len(st) != 1 || st[0].Hit {
		t.Fatalf("another org's sandbox mounted the layer: %+v", st)
	}
}
