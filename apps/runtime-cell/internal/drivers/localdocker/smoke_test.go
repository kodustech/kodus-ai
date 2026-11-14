//go:build dockersmoke

package localdocker

import (
	"context"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/recipe"
)

// TestSmokeRealDocker boots a tiny HTTP server through the driver on the
// local Docker, GETs it on the published 127.0.0.1 port and destroys it.
//
//	KODY_RUNTIME_DEV=1 go test -tags dockersmoke -run Smoke -v ./internal/drivers/localdocker/
func TestSmokeRealDocker(t *testing.T) {
	if err := exec.Command("docker", "version", "--format", "{{.Server.Version}}").Run(); err != nil {
		t.Skip("docker is not available:", err)
	}
	const image = "busybox:1.36"
	if exec.Command("docker", "image", "inspect", image).Run() != nil {
		t.Logf("pulling %s (removed at the end)", image)
		if out, err := exec.Command("docker", "pull", "-q", image).CombinedOutput(); err != nil {
			t.Skipf("cannot pull %s: %v: %s", image, err, out)
		}
		t.Cleanup(func() {
			out, err := exec.Command("docker", "image", "rm", image).CombinedOutput()
			t.Logf("removed pulled image %s: %v %s", image, err, strings.TrimSpace(string(out)))
		})
	}

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	state := t.TempDir()
	d, err := New(ctx, CLI{}, Config{CellID: "cell-smoke", StateDir: state, MachinesDir: filepath.Join(state, "machines"),
		DevInsecure: true, Getenv: func(string) string { return "1" }})
	if err != nil {
		t.Fatal(err)
	}
	claim := "smoke-" + time.Now().UTC().Format("150405")
	if _, err := d.PrepareClaim(ctx, driver.ClaimNetworkSpec{CellID: "cell-smoke", OrgID: "org", ClaimID: claim,
		Expose: []driver.ExposePort{{Service: "web", Port: 8080, Kind: "http"}}}); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	ref, err := d.Create(ctx, driver.MachineSpec{CellID: "cell-smoke", EnvironmentID: "env", Role: driver.RoleWorkload, OrgID: "org", ClaimID: claim,
		ImageID: "local", ClaimGroupID: "kodus-" + claim, KMSKeyRef: "local", ExpiresAt: now.Add(5 * time.Minute), HardExpiresAt: now.Add(10 * time.Minute)})
	if err != nil {
		t.Fatal(err)
	}
	destroyed := false
	t.Cleanup(func() {
		if !destroyed {
			_ = d.Destroy(context.Background(), ref)
		}
	})

	repo := t.TempDir()
	compose := `services:
  web:
    image: ` + image + `
    command: ["sh", "-c", "mkdir -p /www && echo kody-smoke-ok > /www/index.html && exec httpd -f -p 8080 -h /www"]
    ports: ["0.0.0.0:8080:8080"]
`
	if err := os.WriteFile(filepath.Join(repo, "compose.yaml"), []byte(compose), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := d.Transport().Upload(ctx, ref, repo, "workspace"); err != nil {
		t.Fatal("boot:", err)
	}
	addr, ok := d.HostAddress(claim, "web", 8080)
	if !ok || !strings.HasPrefix(addr, "127.0.0.1:") {
		t.Fatalf("published on %q", addr)
	}
	t.Logf("booted %s, published on %s", ref.MachineID, addr)

	var body string
	deadline := time.Now().Add(30 * time.Second)
	for {
		resp, err := http.Get("http://" + addr + "/")
		if err == nil {
			b, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			body = strings.TrimSpace(string(b))
			t.Logf("GET http://%s/ -> %d %q", addr, resp.StatusCode, body)
			if resp.StatusCode == 200 {
				break
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("app never answered: %v", err)
		}
		time.Sleep(500 * time.Millisecond)
	}
	if body != "kody-smoke-ok" {
		t.Fatalf("body %q", body)
	}

	if err := d.Destroy(ctx, ref); err != nil {
		t.Fatal("destroy:", err)
	}
	destroyed = true
	refs, err := d.List(ctx, map[string]string{driver.TagCell: "cell-smoke"})
	if err != nil || len(refs) != 0 {
		t.Fatalf("left behind %+v %v", refs, err)
	}
	out, _ := exec.Command("docker", "ps", "-aq", "--filter", "label=kodus.machine="+ref.MachineID).Output()
	if strings.TrimSpace(string(out)) != "" {
		t.Fatalf("containers left: %s", out)
	}
	t.Logf("destroyed %s; no containers left", ref.MachineID)
}

// TestSmokeRecipe boots testdata/recipe-app from its .kodus/workspace.yaml
// (busybox httpd + postgres with a SQL seed), GETs the exposed web port,
// writes a row, resets (down -v, up, seed, ready), checks the seed is back
// and the row is gone, then destroys everything it made.
func TestSmokeRecipe(t *testing.T) {
	if err := exec.Command("docker", "version", "--format", "{{.Server.Version}}").Run(); err != nil {
		t.Skip("docker is not available:", err)
	}
	for _, image := range []string{"busybox:1.36", "pgvector/pgvector:pg16"} {
		if exec.Command("docker", "image", "inspect", image).Run() == nil {
			continue
		}
		t.Logf("pulling %s (removed at the end)", image)
		if out, err := exec.Command("docker", "pull", "-q", image).CombinedOutput(); err != nil {
			t.Skipf("cannot pull %s: %v: %s", image, err, out)
		}
		t.Cleanup(func() {
			out, err := exec.Command("docker", "image", "rm", image).CombinedOutput()
			t.Logf("removed pulled image %s: %v %s", image, err, strings.TrimSpace(string(out)))
		})
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	state := t.TempDir()
	d, err := New(ctx, CLI{}, Config{CellID: "cell-smoke", StateDir: state, MachinesDir: filepath.Join(state, "machines"),
		DevInsecure: true, Getenv: func(string) string { return "1" }, Out: io.Discard})
	if err != nil {
		t.Fatal(err)
	}
	claim := "recipe-" + time.Now().UTC().Format("150405")
	if _, err := d.PrepareClaim(ctx, driver.ClaimNetworkSpec{CellID: "cell-smoke", OrgID: "org", ClaimID: claim}); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	ref, err := d.Create(ctx, driver.MachineSpec{CellID: "cell-smoke", EnvironmentID: "env", Role: driver.RoleWorkload, OrgID: "org", ClaimID: claim,
		ImageID: "local", ClaimGroupID: "kodus-" + claim, KMSKeyRef: "local", ExpiresAt: now.Add(5 * time.Minute), HardExpiresAt: now.Add(10 * time.Minute)})
	if err != nil {
		t.Fatal(err)
	}
	destroyed := false
	t.Cleanup(func() {
		if !destroyed {
			_ = d.Destroy(context.Background(), ref)
		}
	})
	if err := d.Transport().Upload(ctx, ref, "testdata/recipe-app", "workspace"); err != nil {
		t.Fatal("boot:", err)
	}
	rep, _ := d.LastBoot(claim)
	t.Logf("boot: total %dms (build/pull %dms, up %dms, seed %dms, ready %dms)", rep.TotalMs, rep.BuildMs, rep.UpMs, rep.SeedMs, rep.ReadyMs)
	man, _ := d.Manifest(claim)
	t.Logf("manifest: services %+v expose %+v seedSha %.12s", man.Services, man.Expose, man.SeedSha)

	web, ok := d.HostAddress(claim, "web", 8080)
	db, ok2 := d.HostAddress(claim, "db", 5432)
	if !ok || !ok2 || !strings.HasPrefix(web, "127.0.0.1:") || !strings.HasPrefix(db, "127.0.0.1:") {
		t.Fatalf("published on %q %q", web, db)
	}
	resp, err := http.Get("http://" + web + "/")
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	t.Logf("GET http://%s/ -> %d %q; postgres published on %s", web, resp.StatusCode, strings.TrimSpace(string(b)), db)
	if resp.StatusCode != 200 || strings.TrimSpace(string(b)) != "kody-smoke-ok" {
		t.Fatal("web did not answer")
	}
	psql := func(sql string) string {
		out, err := exec.Command("docker", "compose", "-p", ref.MachineID, "exec", "-T", "db", "psql", "-U", "postgres", "-tAc", sql).CombinedOutput()
		if err != nil {
			t.Fatalf("psql %q: %v %s", sql, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	psql("INSERT INTO items VALUES (2, 'written by the test')")
	if got := psql("SELECT string_agg(name, ',' ORDER BY id) FROM items"); got != "seeded,written by the test" {
		t.Fatalf("before reset %q", got)
	}
	if err := d.Reset(ctx, ref, driver.SnapshotRef{Kind: "compose_volumes", Ref: "seed"}); err != nil {
		t.Fatal("reset:", err)
	}
	rep, _ = d.LastBoot(claim)
	t.Logf("reset: total %dms (down %dms, up %dms, seed %dms, ready %dms)", rep.TotalMs, rep.DownMs, rep.UpMs, rep.SeedMs, rep.ReadyMs)
	if got := psql("SELECT string_agg(name, ',' ORDER BY id) FROM items"); got != "seeded" {
		t.Fatalf("after reset %q", got)
	}
	t.Log("after reset: only the seed row is left")

	if err := d.Destroy(ctx, ref); err != nil {
		t.Fatal("destroy:", err)
	}
	destroyed = true
	out, _ := exec.Command("docker", "ps", "-aq", "--filter", "label=kodus.machine="+ref.MachineID).Output()
	vols, _ := exec.Command("docker", "volume", "ls", "-q", "--filter", "label=com.docker.compose.project="+ref.MachineID).Output()
	if strings.TrimSpace(string(out)) != "" || strings.TrimSpace(string(vols)) != "" {
		t.Fatalf("left containers %q volumes %q", out, vols)
	}
	t.Logf("destroyed %s; no containers or volumes left", ref.MachineID)
}

// TestSmokeCheckout boots a real checkout through the driver, the way a cell
// does: its .kodus/workspace.yaml (the recipe the claim sent), the health
// path of its public service, one reset, then the destroy, which must leave
// no container and no image the project built. For a recipe like kodus-ai's,
// where a unit test cannot tell whether the stack really comes up.
//
//	KODY_RUNTIME_SMOKE_DIR=/path/to/checkout KODY_RUNTIME_DEV=1 \
//	  go test -tags dockersmoke -run SmokeCheckout -timeout 60m -v ./internal/drivers/localdocker/
func TestSmokeCheckout(t *testing.T) {
	repo := os.Getenv("KODY_RUNTIME_SMOKE_DIR")
	if repo == "" {
		t.Skip("KODY_RUNTIME_SMOKE_DIR is not set")
	}
	if err := exec.Command("docker", "version", "--format", "{{.Server.Version}}").Run(); err != nil {
		t.Skip("docker is not available:", err)
	}
	rec, err := recipe.Load(repo)
	if err != nil || rec == nil || rec.Services.Compose.Health == "" {
		t.Fatalf("the checkout needs a recipe with a health path: %v", err)
	}
	pub, _ := rec.PublicHTTP()
	public := driver.ExposePort{Service: pub.Service, Port: pub.Port, Kind: pub.Kind}

	ctx, cancel := context.WithTimeout(context.Background(), 55*time.Minute)
	defer cancel()
	state := t.TempDir()
	d, err := New(ctx, CLI{}, Config{CellID: "cell-smoke", StateDir: state, MachinesDir: filepath.Join(state, "machines"),
		DevInsecure: true, Getenv: func(string) string { return "1" }})
	if err != nil {
		t.Fatal(err)
	}
	claim := "smoke-" + time.Now().UTC().Format("150405")
	if _, err := d.PrepareClaim(ctx, driver.ClaimNetworkSpec{CellID: "cell-smoke", OrgID: "org", ClaimID: claim, Expose: []driver.ExposePort{public}}); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	ref, err := d.Create(ctx, driver.MachineSpec{CellID: "cell-smoke", EnvironmentID: "env", Role: driver.RoleWorkload, OrgID: "org", ClaimID: claim,
		ImageID: "local", ClaimGroupID: "kodus-" + claim, KMSKeyRef: "local", ExpiresAt: now.Add(time.Hour), HardExpiresAt: now.Add(2 * time.Hour)})
	if err != nil {
		t.Fatal(err)
	}
	destroyed := false
	t.Cleanup(func() {
		if !destroyed {
			_ = d.Destroy(context.Background(), ref)
		}
	})

	healthy := func(stage string) {
		t.Helper()
		addr, ok := d.HostAddress(claim, public.Service, public.Port)
		if !ok {
			t.Fatalf("%s: %s/%d not published", stage, public.Service, public.Port)
		}
		resp, err := http.Get("http://" + addr + rec.Services.Compose.Health)
		if err != nil {
			t.Fatalf("%s: %v", stage, err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("%s: GET %s -> %d", stage, rec.Services.Compose.Health, resp.StatusCode)
		}
		t.Logf("%s: GET http://%s%s -> 200", stage, addr, rec.Services.Compose.Health)
	}
	// On a failed boot, keep what the services said before the destroy wipes
	// them: KODY_RUNTIME_SMOKE_LOGS names the file.
	logs := func() {
		if f := os.Getenv("KODY_RUNTIME_SMOKE_LOGS"); f != "" {
			out, _ := exec.Command("docker", "compose", "-p", ref.MachineID, "logs", "--no-color", "--tail", "300").CombinedOutput()
			_ = os.WriteFile(f, out, 0o600)
			t.Logf("service logs in %s", f)
		}
	}
	if err := d.Transport().Upload(ctx, ref, repo, "workspace"); err != nil {
		logs()
		t.Fatal("boot:", err)
	}
	if r, ok := d.LastBoot(claim); ok {
		t.Logf("boot %+v", r)
	}
	healthy("boot")
	if err := d.Reset(ctx, ref, driver.SnapshotRef{Kind: "compose_volumes"}); err != nil {
		t.Fatal("reset:", err)
	}
	if r, ok := d.LastBoot(claim); ok {
		t.Logf("reset %+v", r)
		// data.reset: snapshot restores; a recreate here means it fell back
		// (localdocker.reset.snapshot_fallback in the log says why).
		if rec, _ := recipe.Load(repo); rec != nil && rec.ResetStrategy() == recipe.ResetSnapshot && (r.RestoreMs == 0 || r.DownMs != 0) {
			t.Errorf("the snapshot reset fell back to recreate: %+v", r)
		}
	}
	healthy("reset")

	if err := d.Destroy(ctx, ref); err != nil {
		t.Fatal("destroy:", err)
	}
	destroyed = true
	if out, _ := exec.Command("docker", "ps", "-aq", "--filter", "label=kodus.machine="+ref.MachineID).Output(); strings.TrimSpace(string(out)) != "" {
		t.Fatalf("containers left: %s", out)
	}
	if out, _ := exec.Command("docker", "image", "ls", "-q", "--filter", "label=com.docker.compose.project="+ref.MachineID).Output(); strings.TrimSpace(string(out)) != "" {
		t.Fatalf("built images left: %s", out)
	}
	for _, label := range []string{"kodus.machine=" + ref.MachineID, "com.docker.compose.project=" + ref.MachineID} {
		if out, _ := exec.Command("docker", "volume", "ls", "-q", "--filter", "label="+label).Output(); strings.TrimSpace(string(out)) != "" {
			t.Fatalf("volumes left (%s): %s", label, out)
		}
	}
	t.Logf("destroyed %s; no containers, built images or volumes left", ref.MachineID)
}
