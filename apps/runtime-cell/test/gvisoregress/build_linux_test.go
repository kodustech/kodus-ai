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

// builderImage is rootless BuildKit v0.34.0 by digest.
const builderImage = "moby/buildkit@sha256:65eca3c01cd1180c8f64565c4e3c5983af5145818b0e6fa863385d099eb73855"

// What a build needs from the internet: the registry for its base image
// and the package mirror its RUN steps use.
var buildHosts = []string{"registry-1.docker.io", "auth.docker.io", "production.cloudfront.docker.com", allowed}

// A project with a build section boots: the Dockerfile builds under gVisor
// on the claim network, fetching through the cell, and its image runs. A
// RUN step that reaches a host off the allowlist fails the build.
func TestABuildRunsInTheSandboxAndFetchesOnlyThroughTheCell(t *testing.T) {
	if os.Getenv("KODY_E2E_GVISOR") != "1" {
		t.Skip("KODY_E2E_GVISOR=1 runs it on a Linux Docker with runsc")
	}
	for _, c := range []struct {
		name, run string
		boots     bool
	}{
		{"allowed", "RUN apk add --no-cache curl && curl --version > /built.txt", true},
		{"denied", "RUN wget -q -T 8 -O /stolen https://pastebin.com/", false},
	} {
		t.Run(c.name, func(t *testing.T) {
			dir := t.TempDir()
			e := startEgress(t, dir, "kodus-egress-build")
			ctx := context.Background()
			d, err := dockergvisor.New(ctx, dockercli.CLI{}, dockergvisor.Config{CellID: "cell-e2e", HolderImage: "alpine:3.20",
				WorkDir: filepath.Join(dir, "cell"), EgressContainer: e.name, BuilderImage: builderImage})
			if err != nil {
				t.Fatal(err)
			}
			n, err := d.PrepareClaim(ctx, driver.ClaimNetworkSpec{CellID: "cell-e2e", OrgID: "org-e2e", ClaimID: "claim-build"})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = d.ReleaseClaim(context.Background(), n) })
			spec := drivertest.BaseSpec("cell-e2e", "claim-build", n)
			spec.OrgID, spec.ExpiresAt, spec.HardExpiresAt = "org-e2e", time.Now().Add(10*time.Minute), time.Now().Add(time.Hour)
			ref, err := d.Create(ctx, spec)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = d.Destroy(context.Background(), ref) })
			// The policy names the builder from the start, as the agent's does.
			pol := policy.ClaimPolicy{ClaimID: "claim-build", OrgID: "org-e2e", Phase: policy.PhaseBuild,
				Sources: append([]string{ref.PrivateAddress}, n.Sources...), Allow: append(append([]string{}, buildHosts...), "pastebin.com"),
				SteerTo: n.EgressAddress, ExpiresAt: time.Now().Add(time.Hour), IssuedAt: time.Now()}
			if err := e.push.Push(ctx, pol); err != nil {
				t.Fatalf("push policy: %v", err)
			}
			project := filepath.Join(dir, "checkout")
			if err := os.MkdirAll(filepath.Join(project, "app"), 0o755); err != nil {
				t.Fatal(err)
			}
			dockerfile := "FROM alpine:3.20\n" + c.run + "\nCMD [\"sleep\", \"300\"]\n"
			if err := os.WriteFile(filepath.Join(project, "app", "Dockerfile"), []byte(dockerfile), 0o644); err != nil {
				t.Fatal(err)
			}
			_, err = d.Up(ctx, ref, []byte("services:\n  api:\n    build: ./app\n"), project)
			if !c.boots {
				// It must fail at the RUN step, the base image having come
				// through the cell: a failure anywhere else proves nothing.
				if err == nil || !strings.Contains(err.Error(), "RUN wget") || !strings.Contains(err.Error(), "pastebin.com") {
					t.Fatalf("want the build to fail at the RUN that fetches the denied host, got %v", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("up: %v\negress: %s", err, docker(t, "logs", e.name))
			}
			out, err := exec.Command("docker", "exec", ref.MachineID+"-api-1", "cat", "/built.txt").CombinedOutput()
			if err != nil || !strings.Contains(string(out), "curl") {
				t.Fatalf("the built image is not what runs: %s %v", out, err)
			}
		})
	}
}
