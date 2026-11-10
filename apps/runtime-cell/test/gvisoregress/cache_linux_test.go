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

// The setup builds with the package mirror allowed and the bake keeps its
// build cache. A PR that changes only a file copied after the RUN that
// installs packages builds with the mirror blocked: the RUN comes from the
// default branch's cache. The same build in an environment with no cache
// fails at that RUN, so the cache is what made the difference.
func TestAPRBuildReadsTheDefaultBranchsBuildCache(t *testing.T) {
	if os.Getenv("KODY_E2E_GVISOR") != "1" {
		t.Skip("KODY_E2E_GVISOR=1 runs it on a Linux Docker with runsc")
	}
	const cell, org = "cell-e2e", "org-e2e"
	dir := t.TempDir()
	ctx := context.Background()
	e := startEgress(t, dir, "kodus-egress-cache")
	project := filepath.Join(dir, "checkout")
	if err := os.MkdirAll(filepath.Join(project, "app"), 0o755); err != nil {
		t.Fatal(err)
	}
	write := func(name, body string) {
		if err := os.WriteFile(filepath.Join(project, "app", name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("Dockerfile", "FROM alpine:3.20\nRUN apk add --no-cache curl\nCOPY app.txt /app.txt\nCMD [\"sleep\", \"300\"]\n")
	write("app.txt", "default branch\n")
	compose := []byte("services:\n  api:\n    build: ./app\n")
	registryOnly := []string{"registry-1.docker.io", "auth.docker.io", "production.cloudfront.docker.com"}

	d, err := dockergvisor.New(ctx, dockercli.CLI{}, dockergvisor.Config{CellID: cell, HolderImage: "alpine:3.20",
		WorkDir: filepath.Join(dir, "cell"), EgressContainer: e.name, BuilderImage: builderImage})
	if err != nil {
		t.Fatal(err)
	}
	claim := func(t *testing.T, id, env string, setup bool, allow []string) driver.MachineRef {
		t.Helper()
		n, err := d.PrepareClaim(ctx, driver.ClaimNetworkSpec{CellID: cell, OrgID: org, ClaimID: id})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = d.ReleaseClaim(context.Background(), n) })
		spec := drivertest.BaseSpec(cell, id, n)
		spec.OrgID, spec.EnvironmentID, spec.Setup = org, env, setup
		spec.ExpiresAt, spec.HardExpiresAt = time.Now().Add(10*time.Minute), time.Now().Add(time.Hour)
		ref, err := d.Create(ctx, spec)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = d.Destroy(context.Background(), ref) })
		if err := e.push.Push(ctx, policy.ClaimPolicy{ClaimID: id, OrgID: org, Phase: policy.PhaseBuild,
			Sources: append([]string{ref.PrivateAddress}, n.Sources...), Allow: allow,
			SteerTo: n.EgressAddress, ExpiresAt: time.Now().Add(time.Hour), IssuedAt: time.Now()}); err != nil {
			t.Fatalf("push policy: %v", err)
		}
		return ref
	}
	t.Cleanup(func() {
		out, _ := exec.Command("docker", "image", "ls", "--format", "{{.Repository}}:{{.Tag}}", "kodus-bake/"+cell+"/"+org+"/env-cache").Output()
		for _, r := range strings.Fields(string(out)) {
			_ = exec.Command("docker", "image", "rm", "-f", r).Run()
		}
	})

	setup := claim(t, "claim-setup", "env-cache", true, buildHosts)
	if _, err := d.Up(ctx, setup, compose, project); err != nil {
		t.Fatalf("setup up: %v", err)
	}
	if err := d.PinBakeSource(setup); err != nil {
		t.Fatal(err)
	}
	if err := d.Destroy(ctx, setup); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Bake(ctx, driver.BakeSpec{CellID: cell, OrgID: org, EnvironmentID: "env-cache", SHA: strings.Repeat("f", 40), RecipeSHA: "r", Source: setup}); err != nil {
		t.Fatal(err)
	}

	write("app.txt", "the pr\n")
	pr := claim(t, "claim-pr", "env-cache", false, registryOnly)
	start := time.Now()
	if _, err := d.Up(ctx, pr, compose, project); err != nil {
		t.Fatalf("a PR build with the mirror blocked did not take the RUN from the cache: %v", err)
	}
	t.Logf("PR build from the cache %s", time.Since(start).Round(time.Millisecond))
	out, err := exec.Command("docker", "exec", pr.MachineID+"-api-1", "cat", "/app.txt").CombinedOutput()
	if err != nil || strings.TrimSpace(string(out)) != "the pr" {
		t.Fatalf("the PR runs %q (%v), not its own build", out, err)
	}

	// Control: no cache, same build, same blocked mirror.
	cold := claim(t, "claim-cold", "env-nocache", false, registryOnly)
	if _, err := d.Up(ctx, cold, compose, project); err == nil || !strings.Contains(err.Error(), "apk add") {
		t.Fatalf("without a cache the RUN should fail with the mirror blocked, got %v", err)
	}
}
