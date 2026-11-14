package dockergvisor

import (
	"context"
	"errors"
	"net/netip"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/buildfingerprint"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose/sandbox"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
)

const (
	bakeOrg = "org-a"
	bakeEnv = "env-1"
)

var bakeSubnet = netip.MustParsePrefix("10.213.1.0/24")

func bakeDriver(t *testing.T) (*Driver, *memDocker) {
	t.Helper()
	d, docker := withEgress(t)
	d.cfg.BuilderImage = "moby/buildkit@sha256:abc"
	return d, docker
}

func machine(claim, env string) driver.MachineRef {
	return driver.MachineRef{MachineID: "kodus-" + claim + "-workload", Tags: map[string]string{
		driver.TagCell: "cell-1", driver.TagOrg: bakeOrg, driver.TagEnv: env, driver.TagClaim: claim,
	}}
}

// boot runs the machine's builds as Up does.
func boot(t *testing.T, d *Driver, ref driver.MachineRef, builds ...sandbox.Build) map[string]string {
	t.Helper()
	built, _, err := d.build(context.Background(), ref, builds, "net", "resolv", bakeSubnet)
	if err != nil {
		t.Fatal(err)
	}
	return built
}

func bakeSpec(ref driver.MachineRef) driver.BakeSpec {
	return driver.BakeSpec{CellID: "cell-1", OrgID: bakeOrg, EnvironmentID: bakeEnv, SHA: strings.Repeat("a", 40), RecipeSHA: "r", Source: ref}
}

func bakedRefs(docker *memDocker, env string) []string {
	refs, _ := docker.ImageRefs(context.Background(), "kodus-bake/cell-1/"+bakeOrg+"/"+env)
	sort.Strings(refs)
	return refs
}

// The setup claim's images outlive its release once pinned; the bake names
// them after their fingerprint and the machine's own names go.
func TestBakeKeepsTheSetupMachinesImagesPastItsRelease(t *testing.T) {
	d, docker := bakeDriver(t)
	ctx := context.Background()
	dir := project(t)
	setup := machine("claim-setup", bakeEnv)
	built := boot(t, d, setup, sandbox.Build{Service: "api", Context: dir, Dockerfile: "Dockerfile"})

	if err := d.PinBakeSource(setup); err != nil {
		t.Fatal(err)
	}
	// The worker releases the setup claim as soon as the bake is acked.
	if err := d.Destroy(ctx, setup); err != nil {
		t.Fatal(err)
	}
	if !docker.images[built["api"]] {
		t.Fatal("the release removed the pinned image before the bake")
	}
	img, err := d.Bake(ctx, bakeSpec(setup))
	if err != nil {
		t.Fatal(err)
	}
	sum, err := buildfingerprint.Of(sandbox.Build{Context: dir, Dockerfile: "Dockerfile"}, d.cfg.BuilderImage)
	if err != nil {
		t.Fatal(err)
	}
	refs := bakedRefs(docker, bakeEnv)
	g := generationForTest(t, d, img.ImageID)
	if want := generationImage(g, sum); len(refs) != 1 || refs[0] != want || img.DriverRef != want {
		t.Fatalf("baked %v, image %+v", refs, img)
	}
	if docker.images[built["api"]] {
		t.Fatal("the machine's own name for the image outlived the bake")
	}
	if img.ImageID != generationID("cell-1", "org-a", "env-1", strings.Repeat("a", 40), g.Nonce) {
		t.Fatalf("image id %q", img.ImageID)
	}
}

// claim.ready and pool.target carry the id; the protocol takes 128
// characters, and real org and environment ids are UUIDs.
func TestBakeImageIDFitsTheProtocolWithUUIDs(t *testing.T) {
	const org, env, sha = "7f5bc971-76c2-4586-a624-84a7a98c696c", "dec0de00-0e00-4000-8000-0000000000e1", "0f0fdb512016b3f16eb39102e6deff8b6034f837"
	id := bakeImageID("cell-dev-1", org, env, sha)
	if len(id) > 128 || !strings.HasSuffix(id, "@"+sha) {
		t.Fatalf("%q (%d)", id, len(id))
	}
	if id == bakeImageID("cell-dev-1", org, "dec0de00-0e00-4000-8000-0000000000e2", sha) || id == bakeImageID("cell-dev-2", org, env, sha) {
		t.Fatal("two environments or two cells share a bake id")
	}
}

// A later claim whose build input is the baked one takes the image without
// building; one whose input changed builds.
func TestABuildMatchingTheBakeIsNotBuiltAgain(t *testing.T) {
	d, docker := bakeDriver(t)
	ctx := context.Background()
	dir := project(t)
	setup := machine("claim-setup", bakeEnv)
	boot(t, d, setup, sandbox.Build{Service: "api", Context: dir, Dockerfile: "Dockerfile"})
	if err := d.PinBakeSource(setup); err != nil {
		t.Fatal(err)
	}
	image, err := d.Bake(ctx, bakeSpec(setup))
	if err != nil {
		t.Fatal(err)
	}
	builds := len(docker.builds)

	base := machine("claim-base", bakeEnv)
	base.ImageID = image.ImageID
	got := boot(t, d, base, sandbox.Build{Service: "api", Context: dir, Dockerfile: "Dockerfile"})
	if len(docker.builds) != builds {
		t.Fatal("a build matching the bake ran again")
	}
	if !docker.images[got["api"]] || got["api"] != builtTag(base.MachineID, "api") {
		t.Fatalf("the claim does not hold the baked image under its own name: %v", got)
	}

	// The PR changed the context: that build runs.
	writeFile(t, filepath.Join(dir, "src", "main.go"), "package main // pr\n")
	boot(t, d, machine("claim-pr", bakeEnv), sandbox.Build{Service: "api", Context: dir, Dockerfile: "Dockerfile"})
	if len(docker.builds) != builds+1 {
		t.Fatal("a changed build reused the bake")
	}
	// Another environment never takes this one's bake.
	boot(t, d, machine("claim-other", "env-2"), sandbox.Build{Service: "api", Context: project(t), Dockerfile: "Dockerfile"})
	if len(docker.builds) != builds+2 {
		t.Fatal("another environment reused this one's bake")
	}
}

// An environment keeps only its latest bake; a claim holding an older image
// keeps it, and another environment's bake is untouched.
func TestANewBakeReplacesTheOldOneWithoutTakingAClaimsImage(t *testing.T) {
	d, docker := bakeDriver(t)
	ctx := context.Background()
	bakeFrom := func(claim, env, dir string) {
		t.Helper()
		ref := machine(claim, env)
		boot(t, d, ref, sandbox.Build{Service: "api", Context: dir, Dockerfile: "Dockerfile"})
		if err := d.PinBakeSource(ref); err != nil {
			t.Fatal(err)
		}
		spec := bakeSpec(ref)
		spec.EnvironmentID = env
		image, err := d.Bake(ctx, spec)
		if err != nil {
			t.Fatal(err)
		}
		if err := d.AcknowledgeBake(ctx, image.ImageID); err != nil {
			t.Fatal(err)
		}
	}
	dir := project(t)
	bakeFrom("claim-s1", bakeEnv, dir)
	bakeFrom("claim-o1", "env-2", project(t))
	old := bakedRefs(docker, bakeEnv)
	holder := machine("claim-base", bakeEnv)
	held := boot(t, d, holder, sandbox.Build{Service: "api", Context: dir, Dockerfile: "Dockerfile"})

	writeFile(t, filepath.Join(dir, "src", "main.go"), "package main // next commit\n")
	bakeFrom("claim-s2", bakeEnv, dir)
	now := bakedRefs(docker, bakeEnv)
	if len(now) != 1 || now[0] == old[0] {
		t.Fatalf("bakes %v after %v, want only the new one", now, old)
	}
	if !docker.images[held["api"]] {
		t.Fatal("the new bake took the image a running claim holds")
	}
	if len(bakedRefs(docker, "env-2")) != 1 {
		t.Fatal("another environment's bake was dropped")
	}
}

// A bake takes only what it pinned, of the environment it names, and the
// pin is consumed even when the bake is refused.
func TestBakeTakesOnlyAPinnedMachineOfItsEnvironment(t *testing.T) {
	d, docker := bakeDriver(t)
	ctx := context.Background()
	if err := d.PinBakeSource(machine("claim-never", bakeEnv)); !errors.Is(err, ErrBakeSource) {
		t.Fatalf("pin of a machine that never booted: %v", err)
	}
	setup := machine("claim-setup", bakeEnv)
	built := boot(t, d, setup, sandbox.Build{Service: "api", Context: project(t), Dockerfile: "Dockerfile"})
	if _, err := d.Bake(ctx, bakeSpec(setup)); !errors.Is(err, ErrBakeSource) {
		t.Fatalf("bake without a pin: %v", err)
	}
	if err := d.PinBakeSource(setup); err != nil {
		t.Fatal(err)
	}
	if err := d.PinBakeSource(setup); !errors.Is(err, ErrBakeSource) {
		t.Fatalf("second pin: %v", err)
	}
	spec := bakeSpec(setup)
	spec.EnvironmentID = "env-2"
	if _, err := d.Bake(ctx, spec); !errors.Is(err, driver.ErrNotOwned) {
		t.Fatalf("bake for another environment than the machine's: %v", err)
	}
	if docker.images[built["api"]] || len(bakedRefs(docker, "env-2")) != 0 || len(bakedRefs(docker, bakeEnv)) != 0 {
		t.Fatal("a refused bake kept or named the image")
	}
	if _, err := d.Bake(ctx, bakeSpec(setup)); !errors.Is(err, ErrBakeSource) {
		t.Fatalf("the refused bake left its pin: %v", err)
	}
}

// A setup machine with nothing to build bakes nothing, and drops the
// environment's older bake: the environment no longer builds that image.
func TestABakeOfNothingDropsTheOldBake(t *testing.T) {
	d, docker := bakeDriver(t)
	ctx := context.Background()
	first := machine("claim-s1", bakeEnv)
	boot(t, d, first, sandbox.Build{Service: "api", Context: project(t), Dockerfile: "Dockerfile"})
	_ = d.PinBakeSource(first)
	if _, err := d.Bake(ctx, bakeSpec(first)); err != nil {
		t.Fatal(err)
	}
	second := machine("claim-s2", bakeEnv)
	boot(t, d, second)
	if err := d.PinBakeSource(second); err != nil {
		t.Fatal(err)
	}
	img, err := d.Bake(ctx, bakeSpec(second))
	if err != nil {
		t.Fatal(err)
	}
	if err := d.AcknowledgeBake(ctx, img.ImageID); err != nil {
		t.Fatal(err)
	}
	if img.DriverRef != "" || len(bakedRefs(docker, bakeEnv)) != 0 {
		t.Fatalf("bake of nothing: %+v, left %v", img, bakedRefs(docker, bakeEnv))
	}
}

func TestBakeRepoNamesOnlyWhatDockerAccepts(t *testing.T) {
	if r, ok := bakeRepo("cell-1", "0f8d2c1e-1b2a-4c3d-9e8f-7a6b5c4d3e2f", "env_1"); !ok || r != "kodus-bake/cell-1/0f8d2c1e-1b2a-4c3d-9e8f-7a6b5c4d3e2f/env_1" {
		t.Fatalf("%q %v", r, ok)
	}
	for _, bad := range []string{"", "Org", "a/b", "a:b", "-a", "a-", "..", strings.Repeat("a", 65)} {
		if _, ok := bakeRepo("cell-1", bad, "env"); ok {
			t.Errorf("%q named a repository", bad)
		}
	}
}
