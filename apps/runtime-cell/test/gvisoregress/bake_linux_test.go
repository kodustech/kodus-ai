//go:build linux

package gvisoregress

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver/drivertest"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockergvisor"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy"
)

// The default branch's setup claim builds, is baked and released. A later
// claim of the same environment with the same build input boots without a
// builder container ever starting (Docker's own events say so) and with no
// egress policy at all, so it could not even fetch the base image: it can
// only be running the bake. A PR that changes the Dockerfile builds, and
// runs its own image.
func TestABakedImageBootsALaterClaimWithoutBuilding(t *testing.T) {
	if os.Getenv("KODY_E2E_GVISOR") != "1" {
		t.Skip("KODY_E2E_GVISOR=1 runs it on a Linux Docker with runsc")
	}
	const cell, org, env = "cell-e2e", "org-e2e", "env-e2e"
	dir := t.TempDir()
	ctx := context.Background()
	repo := "kodus-bake/" + cell + "/" + org + "/" + env
	t.Cleanup(func() {
		out, _ := exec.Command("docker", "image", "ls", "--format", "{{.Repository}}:{{.Tag}}", repo).Output()
		for _, r := range strings.Fields(string(out)) {
			_ = exec.Command("docker", "image", "rm", "-f", r).Run()
		}
	})
	e := startEgress(t, dir, "kodus-egress-bake")
	project := filepath.Join(dir, "checkout")
	if err := os.MkdirAll(filepath.Join(project, "app"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(project, "app", "Dockerfile"), []byte("FROM alpine:3.20\nRUN apk add --no-cache curl && curl --version > /built.txt\nCMD [\"sleep\", \"300\"]\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	compose := []byte("services:\n  api:\n    build: ./app\n")

	// image is the bake the claim boots from, as the agent names it at
	// acquire (the environment's last generation); none for a setup. A claim
	// reuses a baked image only when it names its generation.
	claim := func(t *testing.T, d *dockergvisor.Driver, id string, image ...string) (driver.MachineRef, driver.ClaimNetwork) {
		t.Helper()
		n, err := d.PrepareClaim(ctx, driver.ClaimNetworkSpec{CellID: cell, OrgID: org, ClaimID: id})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = d.ReleaseClaim(context.Background(), n) })
		spec := drivertest.BaseSpec(cell, id, n)
		spec.OrgID, spec.EnvironmentID, spec.ExpiresAt, spec.HardExpiresAt = org, env, time.Now().Add(10*time.Minute), time.Now().Add(time.Hour)
		if len(image) > 0 {
			spec.ImageID, spec.ImageRef = image[0], image[0]
		}
		ref, err := d.Create(ctx, spec)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = d.Destroy(context.Background(), ref) })
		return ref, n
	}

	// builders counts the builder containers Docker created in [since, until].
	builders := func(t *testing.T, since, until time.Time) int {
		t.Helper()
		out := docker(t, "events", "--since", since.Format(time.RFC3339Nano), "--until", until.Format(time.RFC3339Nano),
			"--filter", "type=container", "--filter", "event=create", "--filter", "image="+builderImage, "--format", "{{.Actor.ID}}")
		return len(strings.Fields(out))
	}
	allowBuild := func(t *testing.T, id string, ref driver.MachineRef, n driver.ClaimNetwork) {
		t.Helper()
		if err := e.push.Push(ctx, policy.ClaimPolicy{ClaimID: id, OrgID: org, Phase: policy.PhaseBuild,
			Sources: append([]string{ref.PrivateAddress}, n.Sources...), Allow: buildHosts,
			SteerTo: n.EgressAddress, ExpiresAt: time.Now().Add(time.Hour), IssuedAt: time.Now()}); err != nil {
			t.Fatalf("push policy: %v", err)
		}
	}
	runs := func(t *testing.T, ref driver.MachineRef) string {
		t.Helper()
		out, err := exec.Command("docker", "exec", ref.MachineID+"-api-1", "cat", "/built.txt").CombinedOutput()
		if err != nil {
			t.Fatalf("the service is not running: %s %v", out, err)
		}
		return string(out)
	}

	d, err := dockergvisor.New(ctx, dockercli.CLI{}, dockergvisor.Config{CellID: cell, HolderImage: "alpine:3.20",
		WorkDir: filepath.Join(dir, "cell"), EgressContainer: e.name, BuilderImage: builderImage})
	if err != nil {
		t.Fatal(err)
	}

	// The setup claim builds.
	setup, n := claim(t, d, "claim-setup")
	allowBuild(t, "claim-setup", setup, n)
	start := time.Now()
	if _, err := d.Up(ctx, setup, compose, project); err != nil {
		t.Fatalf("setup up: %v\negress: %s", err, docker(t, "logs", e.name))
	}
	builtIn := time.Since(start)
	if got := builders(t, start, time.Now()); got != 1 {
		t.Fatalf("setup started %d builders, want 1", got)
	}
	// image.bake: the pin, the worker's release, then the bake.
	if err := d.PinBakeSource(setup); err != nil {
		t.Fatal(err)
	}
	if err := d.Destroy(ctx, setup); err != nil {
		t.Fatal(err)
	}
	img, err := d.Bake(ctx, driver.BakeSpec{CellID: cell, OrgID: org, EnvironmentID: env, SHA: strings.Repeat("b", 40), RecipeSHA: "r", Source: setup})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(img.DriverRef, repo+":") {
		t.Fatalf("baked %+v", img)
	}

	// A base-side claim at the same input: no policy, no builder, the bake.
	base, _ := claim(t, d, "claim-base", img.ImageID)
	start = time.Now()
	if _, err := d.Up(ctx, base, compose, project); err != nil {
		t.Fatalf("a claim at the baked input did not boot from the bake: %v", err)
	}
	fromBake := time.Since(start)
	if got := builders(t, start, time.Now()); got != 0 {
		t.Fatalf("a claim at the baked input started %d builders", got)
	}
	if out := runs(t, base); !strings.Contains(out, "curl") {
		t.Fatalf("the baked image is not what runs: %s", out)
	}
	t.Logf("up with a build %s, up from the bake %s", builtIn.Round(time.Millisecond), fromBake.Round(time.Millisecond))

	// A PR that changes the build builds, and runs its own image.
	if err := os.WriteFile(filepath.Join(project, "app", "Dockerfile"), []byte("FROM alpine:3.20\nRUN echo pr > /built.txt\nCMD [\"sleep\", \"300\"]\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	pr, prNet := claim(t, d, "claim-pr")
	allowBuild(t, "claim-pr", pr, prNet)
	start = time.Now()
	if _, err := d.Up(ctx, pr, compose, project); err != nil {
		t.Fatalf("pr up: %v", err)
	}
	if got := builders(t, start, time.Now()); got != 1 {
		t.Fatalf("a changed build started %d builders, want 1", got)
	}
	if out := runs(t, pr); strings.TrimSpace(out) != "pr" {
		t.Fatalf("the PR runs %q, not its own build", out)
	}
	// The PR's image never becomes the environment's (S-52).
	if refs := docker(t, "image", "ls", "--format", "{{.Repository}}:{{.Tag}}", repo); refs != img.DriverRef {
		t.Fatalf("the environment's bake is %q, want only %q", refs, img.DriverRef)
	}
}
