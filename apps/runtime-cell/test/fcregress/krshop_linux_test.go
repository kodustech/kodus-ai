//go:build linux

package fcregress

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/kodyexec"
)

// krShopHosts are what demo-shop's build and images reach, through the cell's egress.
var krShopHosts = []string{"registry-1.docker.io", "auth.docker.io", "production.cloudflare.docker.com", "production.cloudfront.docker.com", "registry.npmjs.org"}

// A real Run of a kr-* repository on microVMs, driver level: demo-shop (Express
// + Postgres) set up in an environment VM (its build with the VM's BuildKit,
// compose up to healthy), kept as the environment's template; the Run's two
// sides restored from it, the PR side rebuilt from its checkout on the
// template's build state; each side's round snapshot at first ready and
// memory resets that undo a write; the same probes on both sides. Every
// step is timed. Opt-in: KODY_E2E_KRSHOP_BASE and KODY_E2E_KRSHOP_PR are
// the two checkouts (main and a PR).
func TestFirecrackerRunsKrShopInMicroVMs(t *testing.T) {
	base, pr := os.Getenv("KODY_E2E_KRSHOP_BASE"), os.Getenv("KODY_E2E_KRSHOP_PR")
	if base == "" || pr == "" {
		t.Skip("KODY_E2E_KRSHOP_BASE and KODY_E2E_KRSHOP_PR name demo-shop's main and PR checkouts")
	}
	s := open(t)
	e := startEgress(t, s.Place.Egress().String())
	ctx := context.Background()
	stamp := time.Now().Format("150405")
	var times []string
	lap := func(what string, since time.Time) {
		times = append(times, what+": "+time.Since(since).Round(time.Millisecond).String())
		t.Logf("%s: %d ms", what, time.Since(since).Milliseconds())
	}
	t.Cleanup(func() { t.Logf("demo-shop on microVMs:\n  %s", strings.Join(times, "\n  ")) })
	sh := func(ref driver.MachineRef, cmd string, timeoutMs int64) string {
		t.Helper()
		r, err := s.Driver.Exec(ctx, ref, kodyexec.Request{Command: cmd, Cwd: "workspace/repo", TimeoutMs: timeoutMs})
		if err != nil || r.ExitCode != 0 {
			t.Fatalf("%q in %s: %+v %v", cmd, ref.MachineID, r, err)
		}
		return strings.TrimSpace(r.Stdout)
	}
	allow := func(claim string, n driver.ClaimNetwork, ref driver.MachineRef) {
		t.Helper()
		if err := e.Allow(ctx, claim, "org-fc", n, []string{ref.PrivateAddress}, krShopHosts); err != nil {
			t.Fatal(err)
		}
	}
	envSpec := func(claim string, n driver.ClaimNetwork, setup bool) driver.MachineSpec {
		return machineSpec(claim, n, driver.RoleWorkload, func(m *driver.MachineSpec) {
			m.Setup, m.ImageID, m.ImageRef, m.ClaimSize = setup, "environment", "environment", driver.ClaimSize{MemoryMB: 4096, CPUs: 2}
		})
	}
	compose, err := os.ReadFile(filepath.Join(base, "docker-compose.yml"))
	if err != nil {
		t.Fatal(err)
	}
	// The VM holds one compose project, under the driver's name for it.
	probe := `P=$(docker compose ls -aq | head -n1); port=$(docker compose -p "$P" -f .kodus-compose.yml port app 3000 | sed 's/.*://'); curl -fsS "http://127.0.0.1:$port$URL"`
	get := func(ref driver.MachineRef, url string) string {
		return sh(ref, "URL="+url+"; "+probe, 30_000)
	}

	// The setup: the default branch's build and boot in a fresh environment VM.
	setupClaim := "krs-setup-" + stamp
	sn := claimNet(t, s.Driver, setupClaim)
	start := time.Now()
	src, err := s.Driver.Create(ctx, envSpec(setupClaim, sn, true))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Driver.Destroy(context.Background(), src) })
	allow(setupClaim, sn, src)
	if r, err := s.Driver.Exec(ctx, src, kodyexec.Request{Command: "for i in $(seq 120); do docker info >/dev/null 2>&1 && exit 0; sleep 0.5; done; exit 1", TimeoutMs: 90_000}); err != nil || r.ExitCode != 0 {
		t.Fatalf("dockerd in the setup VM: %+v %v", r, err)
	}
	lap("setup VM boot to dockerd answering", start)
	start = time.Now()
	if err := s.Driver.Upload(ctx, src, base, "workspace/repo", nil); err != nil {
		t.Fatal(err)
	}
	lap("setup upload", start)
	start = time.Now()
	if _, err := s.Driver.Up(ctx, driver.UpRequest{Ref: src, Compose: compose, ProjectDir: filepath.Join(base, ".")}); err != nil {
		r, _ := s.Driver.Exec(ctx, src, kodyexec.Request{Command: "cat /etc/resolv.conf; getent hosts registry-1.docker.io; docker pull pgvector/pgvector:pg16 2>&1 | tail -5; tail -20 /var/log/dockerd.log", TimeoutMs: 120_000})
		t.Fatalf("%v\ndiagnosis: %s %s", err, r.Stdout, r.Stderr)
	}
	lap("setup build + compose up to healthy (cold, pulls included)", start)
	baseOrders := get(src, "/orders")
	t.Logf("setup GET /orders: %s", baseOrders)
	start = time.Now()
	tpl, err := s.Driver.Snapshot(ctx, src, isolation.PurposeTemplate)
	if err != nil {
		t.Fatal(err)
	}
	lap("environment template (4 GiB)", start)
	t.Cleanup(func() { _ = s.Backend.Store().Remove(tpl.Org, tpl.ID) })

	// The Run: both sides from the template.
	side := func(name, checkout string) (driver.MachineRef, string) {
		claim := "krs-" + name + "-" + stamp
		n := claimNet(t, s.Driver, claim) //nolint:contextcheck // the test's helper makes and releases a claim network on its own context, as the other tests'.
		start := time.Now()
		ref, err := s.Driver.CreateFrom(ctx, envSpec(claim, n, false), tpl)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = s.Driver.Destroy(context.WithoutCancel(ctx), ref) })
		allow(claim, n, ref)
		lap(name+" side restored from the template", start)
		// The template's project keeps its name (the environment's); the
		// side's checkout goes where the setup's was and Up rebuilds it.
		if checkout != "" {
			start = time.Now()
			if err := s.Driver.Upload(ctx, ref, checkout, "workspace/repo", nil); err != nil {
				t.Fatal(err)
			}
			prCompose, err := os.ReadFile(filepath.Join(checkout, "docker-compose.yml"))
			if err != nil {
				t.Fatal(err)
			}
			if _, err := s.Driver.Up(ctx, driver.UpRequest{Ref: ref, Compose: prCompose, ProjectDir: checkout}); err != nil {
				t.Fatalf("PR rebuild: %v", err)
			}
			lap(name+" side build on the template's state + up to healthy", start)
		}
		return ref, claim
	}
	baseRef, _ := side("base", "")
	prRef, _ := side("pr", pr)
	getSide := func(ref driver.MachineRef, url string) string { return get(ref, url) }
	start = time.Now()
	b1 := getSide(baseRef, "/orders")
	lap("base first probe after restore", start)
	p1 := getSide(prRef, "/orders")
	bPage, pPage := getSide(baseRef, "/"), getSide(prRef, "/")
	t.Logf("GET /orders base %s | pr %s; GET / differs: %v", b1, p1, bPage != pPage)
	if b1 != baseOrders {
		t.Fatalf("the base side does not answer as the setup did: %s vs %s", b1, baseOrders)
	}

	// Rounds: a snapshot at first ready, then resets that undo a write.
	for _, sd := range []struct {
		name string
		ref  *driver.MachineRef
	}{{"base", &baseRef}, {"pr", &prRef}} {
		start := time.Now()
		round, back, err := s.Driver.SnapshotMachine(ctx, *sd.ref, "round", "")
		if err != nil {
			t.Fatal(err)
		}
		*sd.ref = back
		lap(sd.name+" round snapshot (4 GiB) and back in place", start)
		first := getSide(*sd.ref, "/orders")
		for i := range 3 {
			sh(*sd.ref, `P=$(docker compose ls -aq | head -n1); port=$(docker compose -p "$P" -f .kodus-compose.yml port app 3000 | sed 's/.*://'); curl -fsS -H 'content-type: application/json' -d '{"item":"probe","quantity":1}' "http://127.0.0.1:$port/orders"`, 30_000)
			start := time.Now()
			if *sd.ref, err = s.Driver.ResetToSnapshot(ctx, *sd.ref, round); err != nil {
				t.Fatal(err)
			}
			got := getSide(*sd.ref, "/orders")
			lap(sd.name+" memory reset to the round, to the first probe answer", start)
			if got != first {
				t.Fatalf("%s reset %d: %s, the round answered %s", sd.name, i, got, first)
			}
		}
	}
	// For scale: the reset a compose project gets without a memory snapshot.
	start = time.Now()
	sh(baseRef, `P=$(docker compose ls -aq | head -n1); docker compose -p "$P" -f .kodus-compose.yml down -v && docker compose -p "$P" -f .kodus-compose.yml up -d --wait --wait-timeout 300`, 600_000)
	lap("base compose down -v + up to healthy, inside the VM (no snapshot)", start)
}
