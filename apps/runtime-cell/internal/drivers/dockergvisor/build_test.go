package dockergvisor

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"maps"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/buildprogress"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose/sandbox"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/machinetrust"
)

// A build runs on the claim network at the builder's fixed address, which
// the claim's policy names from PrepareClaim on; the image goes with the
// machine.
func TestBuildsRunOnTheClaimNetworkAndGoWithTheMachine(t *testing.T) {
	d, docker := withEgress(t)
	d.cfg.BuilderImage = "moby/buildkit@sha256:abc"
	ctx := context.Background()
	n, err := d.PrepareClaim(ctx, driver.ClaimNetworkSpec{CellID: "cell-1", OrgID: "org-a", ClaimID: "claim-1"})
	if err != nil {
		t.Fatal(err)
	}
	subnet := netip.MustParsePrefix(docker.subnets[n.WorkloadGroupID])
	want := builderAddress(subnet).String()
	if len(n.Sources) != 1 || n.Sources[0] != want {
		t.Fatalf("network sources %v, want the builder %s", n.Sources, want)
	}
	ref := driver.MachineRef{MachineID: "kodus-claim-1-workload", Tags: map[string]string{driver.TagClaim: "claim-1"}}
	built, _, err := d.build(ctx, ref, []sandbox.Build{{Service: "api", Context: t.TempDir(), Dockerfile: "Dockerfile"}}, n.WorkloadGroupID, d.resolvPath(n.WorkloadGroupID), subnet, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	b := docker.builds[0]
	if b.Network != n.WorkloadGroupID || b.Address != want || b.Resolv != d.resolvPath(n.WorkloadGroupID) || b.Runtime != "runsc" {
		t.Fatalf("build ran as %+v", b)
	}
	if tag := built["api"]; !docker.images[tag] {
		t.Fatalf("image %q not loaded", tag)
	}
	if err := d.Destroy(ctx, ref); err != nil {
		t.Fatal(err)
	}
	if len(docker.images) != 0 {
		t.Fatalf("built images left behind: %v", docker.images)
	}
}

func TestAProjectThatBuildsNeedsABuilder(t *testing.T) {
	d, _ := withEgress(t)
	_, _, err := d.build(context.Background(), driver.MachineRef{MachineID: "m"}, []sandbox.Build{{Service: "api"}}, "net", "resolv", netip.MustParsePrefix("10.213.1.0/24"), nil, nil)
	if !errors.Is(err, ErrNoBuilder) {
		t.Fatalf("err %v, want ErrNoBuilder", err)
	}
}

// A reset brings the same checkout up again: the machine's own image of a
// build stands while its input is the same, and a changed input builds.
func TestAResetReusesTheMachinesOwnImageUntilTheInputChanges(t *testing.T) {
	d, docker := withEgress(t)
	d.cfg.BuilderImage = "moby/buildkit@sha256:abc"
	ctx := context.Background()
	n, err := d.PrepareClaim(ctx, driver.ClaimNetworkSpec{CellID: "cell-1", OrgID: "org-a", ClaimID: "claim-1"})
	if err != nil {
		t.Fatal(err)
	}
	subnet := netip.MustParsePrefix(docker.subnets[n.WorkloadGroupID])
	ref := driver.MachineRef{MachineID: "kodus-claim-1-workload", Tags: map[string]string{driver.TagClaim: "claim-1"}}
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "Dockerfile"), []byte("FROM alpine:3.20\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	up := func() {
		t.Helper()
		if _, _, err := d.build(ctx, ref, []sandbox.Build{{Service: "api", Context: dir, Dockerfile: "Dockerfile"}}, n.WorkloadGroupID, d.resolvPath(n.WorkloadGroupID), subnet, nil, nil); err != nil {
			t.Fatal(err)
		}
	}
	up()
	up()
	if len(docker.builds) != 1 {
		t.Fatalf("%d builds for one checkout brought up twice", len(docker.builds))
	}
	if err := os.WriteFile(filepath.Join(dir, "Dockerfile"), []byte("FROM alpine:3.21\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	up()
	if len(docker.builds) != 2 {
		t.Fatalf("a changed Dockerfile reused the old image (%d builds)", len(docker.builds))
	}
	if err := d.Destroy(ctx, ref); err != nil {
		t.Fatal(err)
	}
	if len(docker.images) != 0 {
		t.Fatalf("built images left behind: %v", docker.images)
	}
}

// Services that name the same build (api, worker and webhooks of one
// Dockerfile and target, kodus-ai's compose) get one build: the others are
// tagged from its image. A build that asks for other secrets builds on its
// own (S-28: each build gets only the secrets it asked for).
func TestServicesThatNameTheSameBuildBuildItOnce(t *testing.T) {
	d, docker := withEgress(t)
	d.cfg.BuilderImage = "moby/buildkit@sha256:abc"
	ctx := context.Background()
	n, err := d.PrepareClaim(ctx, driver.ClaimNetworkSpec{CellID: "cell-1", OrgID: "org-a", ClaimID: "claim-1"})
	if err != nil {
		t.Fatal(err)
	}
	subnet := netip.MustParsePrefix(docker.subnets[n.WorkloadGroupID])
	ref := driver.MachineRef{MachineID: "kodus-claim-1-workload", Tags: map[string]string{driver.TagClaim: "claim-1"}}
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "Dockerfile"), []byte("FROM alpine:3.20\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	same := func(service string) sandbox.Build {
		return sandbox.Build{Service: service, Context: dir, Dockerfile: "Dockerfile", Target: "api", Args: map[string]string{"API_CLOUD_MODE": "false"}}
	}
	withSecret := same("billing")
	withSecret.Secrets = map[string]string{"NPM_TOKEN": "npm-token"}
	built, _, err := d.build(ctx, ref, []sandbox.Build{same("api"), same("worker"), same("webhooks"), withSecret}, n.WorkloadGroupID, d.resolvPath(n.WorkloadGroupID), subnet, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(docker.builds) != 2 {
		t.Fatalf("%d builds for three services of one build and one with its own secrets, want 2", len(docker.builds))
	}
	for _, svc := range []string{"api", "worker", "webhooks", "billing"} {
		if tag := built[svc]; tag != builtTag(ref.MachineID, svc) || !docker.images[tag] {
			t.Fatalf("%s: image %q not under its own claim tag", svc, built[svc])
		}
	}
	if err := d.Destroy(ctx, ref); err != nil {
		t.Fatal(err)
	}
	if len(docker.images) != 0 {
		t.Fatalf("built images left behind: %v", docker.images)
	}
}

// A builder killed at its memory limit is out_of_memory, not a toolchain
// failure: the blocker asks for memory, not for a fix in the repository.
func TestABuildKilledAtItsMemoryLimitIsOutOfMemory(t *testing.T) {
	d, docker := bakeDriver(t)
	d.cfg.MemLimit = "12g"
	docker.buildErr = &dockercli.ExitError{Command: "docker run --rm --name kodus-build-x", Code: dockercli.ExitKilled}
	_, _, err := d.build(context.Background(), machine("claim-1", bakeEnv), []sandbox.Build{{Service: "api", Context: project(t), Dockerfile: "Dockerfile"}}, "net", "resolv", bakeSubnet, nil, nil)
	if !errors.Is(err, driver.ErrOutOfMemory) || !strings.Contains(err.Error(), "12g") {
		t.Fatalf("err %v, want out of memory naming the limit", err)
	}
	docker.buildErr = &dockercli.ExitError{Command: "docker run", Code: 1, Stderr: "go: build failed"}
	_, _, err = d.build(context.Background(), machine("claim-2", bakeEnv), []sandbox.Build{{Service: "api", Context: project(t), Dockerfile: "Dockerfile"}}, "net", "resolv", bakeSubnet, nil, nil)
	if err == nil || errors.Is(err, driver.ErrOutOfMemory) {
		t.Fatalf("a failed compile became out of memory: %v", err)
	}
	// What the build printed decides nothing: a test that echoes the words
	// of an OOM still failed with its own status.
	docker.buildErr = &dockercli.ExitError{Command: "docker run", Code: 1, Stderr: "make: exit status 137"}
	_, _, err = d.build(context.Background(), machine("claim-3", bakeEnv), []sandbox.Build{{Service: "api", Context: project(t), Dockerfile: "Dockerfile"}}, "net", "resolv", bakeSubnet, nil, nil)
	if err == nil || errors.Is(err, driver.ErrOutOfMemory) {
		t.Fatalf("a build that printed an OOM's words became out of memory: %v", err)
	}
}

// A build used to log only its total (build.timing): a one-line change that
// took 7.7 minutes did not say which step did. build.steps names the
// slowest steps from BuildKit's progress, and the claim's own progress sink
// still gets every line.
func TestABuildLogsItsSlowestSteps(t *testing.T) {
	d, docker := withEgress(t)
	d.cfg.BuilderImage = "moby/buildkit@sha256:abc"
	var logs bytes.Buffer
	d.cfg.Log = slog.New(slog.NewJSONHandler(&logs, nil))
	docker.buildOutput = []string{
		"#5 [internal] load build context", "#5 DONE 44.1s",
		"#7 [build 3/6] RUN go mod download", "#7 CACHED",
		"#8 [build 5/6] RUN go build ./pkg/cmd/grafana", "#8 1.000 compiling", "#8 DONE 380.2s",
	}
	ctx := context.Background()
	n, err := d.PrepareClaim(ctx, driver.ClaimNetworkSpec{CellID: "cell-1", OrgID: "org-a", ClaimID: "claim-1"})
	if err != nil {
		t.Fatal(err)
	}
	var progress []string
	pctx := dockercli.WithOutput(ctx, func(l string) { progress = append(progress, l) })
	ref := driver.MachineRef{MachineID: "kodus-claim-1-workload", Tags: map[string]string{driver.TagClaim: "claim-1"}}
	_, steps, err := d.build(pctx, ref, []sandbox.Build{{Service: "api", Context: t.TempDir(), Dockerfile: "Dockerfile"}}, n.WorkloadGroupID, d.resolvPath(n.WorkloadGroupID), netip.MustParsePrefix(docker.subnets[n.WorkloadGroupID]), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	// The same steps go to the boot's timing (claim.ready timing.buildSteps).
	if steps.Steps != 3 || steps.Cached != 1 || len(steps.Slowest) != 2 || steps.Slowest[0] != (driver.BuildStep{Service: "api", Name: "[build 5/6] RUN go build ./pkg/cmd/grafana", Ms: 380_200}) {
		t.Fatalf("boot steps %+v", steps)
	}
	if len(progress) < len(docker.buildOutput) || progress[0] != docker.buildOutput[0] {
		t.Fatalf("the claim's progress lost the build's lines: %q", progress)
	}
	var line struct {
		Msg     string `json:"msg"`
		Service string `json:"service"`
		OK      bool   `json:"ok"`
		Steps   int    `json:"steps"`
		Cached  int    `json:"cached"`
		Slowest []struct {
			Name string `json:"name"`
			Ms   int64  `json:"ms"`
		} `json:"slowest"`
	}
	for _, l := range strings.Split(logs.String(), "\n") {
		if strings.Contains(l, `"msg":"build.steps"`) {
			if err := json.Unmarshal([]byte(l), &line); err != nil {
				t.Fatal(err)
			}
		}
	}
	if line.Msg != "build.steps" || line.Service != "api" || !line.OK || line.Steps != 3 || line.Cached != 1 || len(line.Slowest) != 2 ||
		line.Slowest[0].Name != "[build 5/6] RUN go build ./pkg/cmd/grafana" || line.Slowest[0].Ms != 380_200 {
		t.Fatalf("build.steps: %+v\n%s", line, logs.String())
	}
}

// A boot of several services keeps the slowest steps of all of them, each
// with its service, and adds up the counts.
func TestABootsStepsAreTheSlowestOfEveryBuild(t *testing.T) {
	var acc driver.BuildSteps
	for _, svc := range []string{"api", "worker"} {
		s := buildprogress.Summary{Steps: 6, Done: 5, Cached: 1}
		for i := 0; i < 5; i++ {
			s.Slowest = append(s.Slowest, buildprogress.Step{Name: svc + " step", Ms: int64(len(svc)*100 - i)})
		}
		acc = addBuildSteps(acc, svc, s)
	}
	if acc.Steps != 12 || acc.Done != 10 || acc.Cached != 2 || len(acc.Slowest) != slowestSteps {
		t.Fatalf("%+v", acc)
	}
	if acc.Slowest[0].Service != "worker" || acc.Slowest[0].Ms != 600 || acc.Slowest[5].Service != "api" {
		t.Fatalf("slowest %+v", acc.Slowest)
	}
}

// The cell's own builder with the trust files: the network says its source
// trusts the cell CA, and each build gets the trust bundle and the claim
// secrets it asked for (G6), placeholders only. A stock builder, or a cell without the
// files, gets neither and its source stays untrusted.
func TestATrustedBuilderGetsTheBundleAndTheClaimsSecrets(t *testing.T) {
	trust := machinetrust.Files{Bundle: "/cell/trust/ca-bundle.pem", CellCA: "/cell/trust/cell-ca.pem"}
	for _, tc := range []struct {
		name    string
		own     bool
		trust   machinetrust.Files
		trusted bool
	}{
		{"own builder with the files", true, trust, true},
		{"stock builder", false, trust, false},
		{"no trust files", true, machinetrust.Files{}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d, docker := withEgress(t)
			d.cfg.BuilderImage, d.cfg.BuilderTrustsCellCA, d.cfg.Trust = "kodus-runtime-builder@sha256:abc", tc.own, tc.trust
			ctx, secrets := context.Background(), map[string]string{"NPM_TOKEN": "kodus-ph-a"}
			n, err := d.PrepareClaim(ctx, driver.ClaimNetworkSpec{CellID: "cell-1", OrgID: "org-a", ClaimID: "claim-1"})
			if err != nil {
				t.Fatal(err)
			}
			if n.SourcesTrustCellCA != tc.trusted {
				t.Fatalf("network says the builder trusts the cell CA: %v", n.SourcesTrustCellCA)
			}
			subnet := netip.MustParsePrefix(docker.subnets[n.WorkloadGroupID])
			ref := driver.MachineRef{MachineID: "kodus-claim-1-workload", Tags: map[string]string{driver.TagClaim: "claim-1"}}
			asked := []sandbox.Build{{Service: "api", Context: t.TempDir(), Dockerfile: "Dockerfile", Secrets: map[string]string{"NPM_TOKEN": "NPM_TOKEN"}}}
			if _, _, err := d.build(ctx, ref, asked, n.WorkloadGroupID, d.resolvPath(n.WorkloadGroupID), subnet, secrets, nil); err != nil {
				t.Fatal(err)
			}
			b := docker.builds[0]
			if tc.trusted && (b.CABundle != trust.Bundle || b.Secrets["NPM_TOKEN"] != "kodus-ph-a" || len(b.Secrets) != 1) {
				t.Fatalf("trusted build ran as %+v", b)
			}
			if !tc.trusted && (b.CABundle != "" || b.Secrets != nil) {
				t.Fatalf("untrusted build got the bundle or secrets: %q %v", b.CABundle, b.Secrets)
			}
		})
	}
}

// G6: a build gets only the claim secrets it asked for, under the id it
// reads them by; a build that asked for none gets none, and one the claim
// does not hold is not invented.
func TestABuildGetsOnlyTheSecretsItAskedFor(t *testing.T) {
	claim := map[string]string{"NPM_TOKEN": "kodus-ph-npm", "STRIPE_KEY": "kodus-ph-stripe", "AWS_SECRET": "kodus-ph-aws"}
	for _, tc := range []struct {
		name  string
		asked map[string]string
		want  map[string]string
	}{
		{"asked for none", nil, nil},
		{"asked for one", map[string]string{"NPM_TOKEN": "NPM_TOKEN"}, map[string]string{"NPM_TOKEN": "kodus-ph-npm"}},
		{"asked under another id", map[string]string{"NPM_AUTH": "NPM_TOKEN"}, map[string]string{"NPM_AUTH": "kodus-ph-npm"}},
		{"asked for one the claim lacks", map[string]string{"GH_TOKEN": "GH_TOKEN"}, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d, docker := withEgress(t)
			d.cfg.BuilderImage, d.cfg.BuilderTrustsCellCA = "kodus-runtime-builder@sha256:abc", true
			d.cfg.Trust = machinetrust.Files{Bundle: "/cell/trust/ca-bundle.pem", CellCA: "/cell/trust/cell-ca.pem"}
			ctx := context.Background()
			n, err := d.PrepareClaim(ctx, driver.ClaimNetworkSpec{CellID: "cell-1", OrgID: "org-a", ClaimID: "claim-1"})
			if err != nil {
				t.Fatal(err)
			}
			subnet := netip.MustParsePrefix(docker.subnets[n.WorkloadGroupID])
			ref := driver.MachineRef{MachineID: "kodus-claim-1-workload", Tags: map[string]string{driver.TagClaim: "claim-1"}}
			b := sandbox.Build{Service: "api", Context: t.TempDir(), Dockerfile: "Dockerfile", Secrets: tc.asked}
			if _, _, err := d.build(ctx, ref, []sandbox.Build{b}, n.WorkloadGroupID, d.resolvPath(n.WorkloadGroupID), subnet, claim, nil); err != nil {
				t.Fatal(err)
			}
			if got := docker.builds[0].Secrets; !maps.Equal(got, tc.want) {
				t.Fatalf("build got secrets %v, want %v", got, tc.want)
			}
		})
	}
}
