package dockergvisor

import (
	"context"
	"fmt"
	"os"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/clock"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockercli"
)

// db and app (app depends on db being healthy), both with a healthcheck at
// the recipe's 2 s.
const dbAndApp = `services:
  app:
    image: app
    depends_on:
      db:
        condition: service_healthy
    healthcheck:
      test: ['CMD', 'true']
      interval: 2s
      retries: 30
  db:
    image: db
    healthcheck:
      test: ['CMD', 'true']
      interval: 2s
      retries: 30
`

func canonicalDBAndApp() string {
	svc := func(ip, mac string) string {
		return `{"image":"x","runtime":"runsc","security_opt":["no-new-privileges:true"],"networks":{"kodus-claim":{"ipv4_address":"` + ip + `","mac_address":"` + mac + `"}},"extra_hosts":["app=10.213.5.10","db=10.213.5.11"],
"labels":{"kodus.cell":"cell-1","kodus.org":"","kodus.claim":"claim-1","kodus.role":"","kodus.hard-expires":"2026-10-29T13:00:00Z"}}`
	}
	return `{"services":{"app":` + svc("10.213.5.10", "02:42:0a:d5:05:0a") + `,"db":` + svc("10.213.5.11", "02:42:0a:d5:05:0b") + `},
"networks":{"kodus-claim":{"name":"kodus-claim-1","external":true}}}`
}

// containersJSON is the project's two containers as docker inspect says,
// started at db and app.
func containersJSON(db, app time.Time) string {
	c := func(id, svc, ip string, at time.Time) string {
		return fmt.Sprintf(`{"Id":%q,"Name":"/kodus-claim-1-workload-%s-1","Config":{"Labels":{"kodus.cell":"cell-1","com.docker.compose.service":%q}},"State":{"StartedAt":%q},"NetworkSettings":{"Networks":{"kodus-claim-1":{"IPAddress":%q}}}}`,
			id, svc, svc, at.Format(time.RFC3339Nano), ip)
	}
	return "[" + c("s1", "db", "10.213.5.11", db) + "," + c("s2", "app", "10.213.5.10", app) + "]"
}

// A reset reports its phases to machine.reset (BootTimer): the down, then
// the Up that follows it, split where Docker says the containers started.
// It used to report nothing: the Up after it called itself a boot, so the
// agent logged the reset with no phase at all.
func TestAResetReportsItsDownUpSeedAndReady(t *testing.T) {
	t0 := time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)
	clk := clock.NewFake(t0)
	r := &recorder{answers: map[string]string{"info": `{"runsc":{}}`, "run": "c0ffee\n", "inspect": holderJSON, "network subnet": "10.213.5.0/24 \n", "version": "1.52\n"}}
	var rewritten string
	run := func(ctx context.Context, stdin []byte, bin string, args ...string) ([]byte, error) {
		j := strings.Join(args, " ")
		switch {
		case strings.Contains(j, " down "):
			clk.Advance(600 * time.Millisecond)
		case strings.Contains(j, " config "):
			if i := slices.Index(args, "-f"); i >= 0 {
				b, _ := os.ReadFile(args[i+1])
				rewritten = string(b)
			}
		case strings.Contains(j, " up "):
			// db starts 0.5 s in; app once db passed, 5 s later; the up
			// returns when app passed too, 2.5 s after that.
			upAt := clk.Now()
			r.answers["inspect"] = containersJSON(upAt.Add(500*time.Millisecond), upAt.Add(5500*time.Millisecond))
			clk.Advance(8 * time.Second)
		}
		return r.run(ctx, stdin, bin, args...)
	}
	d, err := New(context.Background(), dockercli.CLI{Run: run}, Config{CellID: "cell-1", HolderImage: "kodus/holder@sha256:abc", WorkDir: t.TempDir(), Clock: clk})
	if err != nil {
		t.Fatal(err)
	}
	ref, err := d.Create(context.Background(), spec())
	if err != nil {
		t.Fatal(err)
	}
	ref.Tags[driver.TagOrg], ref.Tags[driver.TagRole] = "", ""
	dir := t.TempDir()
	r.answers["compose config"] = canonicalDBAndApp()
	r.answers["ps"] = "s1\ns2\n"
	if _, err := d.Up(context.Background(), ref, []byte(dbAndApp), dir); err != nil {
		t.Fatal(err)
	}
	claim := ref.Tags[driver.TagClaim]
	if tm, _ := d.BootTiming(claim); tm.Kind != "boot" || tm.DownMs != 0 || tm.UpMs != 500 || tm.SeedMs != 5000 || tm.ReadyMs != 2500 {
		t.Fatalf("first boot %+v", tm)
	}
	// The cell probes a starting service every 200 ms, not every 2 s.
	if strings.Count(rewritten, "start_interval: 200ms") != 2 {
		t.Fatalf("healthchecks not on the fast start:\n%s", rewritten)
	}

	resetAt := clk.Now()
	if err := d.Reset(context.Background(), ref, driver.SnapshotRef{Kind: "compose_volumes"}); err != nil {
		t.Fatal(err)
	}
	if tm, _ := d.BootTiming(claim); tm.Kind != "boot" {
		t.Fatalf("a reset not up yet already reported: %+v", tm)
	}
	if _, err := d.Up(context.Background(), ref, []byte(dbAndApp), dir); err != nil {
		t.Fatal(err)
	}
	want := driver.BootTiming{Kind: "reset", At: resetAt, TotalMs: 8600, DownMs: 600, UpMs: 500, SeedMs: 5000, ReadyMs: 2500}
	if tm, ok := d.BootTiming(claim); !ok || tm != want {
		t.Fatalf("reset timing %+v, want %+v", tm, want)
	}

	// The next Up with no reset before it is a boot again.
	if _, err := d.Up(context.Background(), ref, []byte(dbAndApp), dir); err != nil {
		t.Fatal(err)
	}
	if tm, _ := d.BootTiming(claim); tm.Kind != "boot" || tm.DownMs != 0 {
		t.Fatalf("an Up after the reset's %+v", tm)
	}
}

// A daemon older than API 1.44 has no start_interval (compose refuses it):
// the healthchecks stay as written. So does one the cell cannot ask.
func TestNoFastStartOnADaemonWithoutStartInterval(t *testing.T) {
	for _, version := range []string{"1.43\n", "", "garbage"} {
		r := &recorder{answers: map[string]string{"info": `{"runsc":{}}`, "version": version}}
		d, err := New(context.Background(), dockercli.CLI{Run: r.run}, Config{CellID: "cell-1", HolderImage: "h", WorkDir: t.TempDir()})
		if err != nil {
			t.Fatal(err)
		}
		if d.healthEvery != 0 {
			t.Errorf("API %q: fast start on", version)
		}
	}
	r := &recorder{answers: map[string]string{"info": `{"runsc":{}}`, "version": "1.44"}}
	d, _ := New(context.Background(), dockercli.CLI{Run: r.run}, Config{CellID: "cell-1", HolderImage: "h", WorkDir: t.TempDir(), HealthStartInterval: -1})
	if d.healthEvery != 0 {
		t.Error("a negative HealthStartInterval left it on")
	}
	d, _ = New(context.Background(), dockercli.CLI{Run: r.run}, Config{CellID: "cell-1", HolderImage: "h", WorkDir: t.TempDir()})
	if d.healthEvery != DefaultHealthStartInterval {
		t.Errorf("API 1.44: %v", d.healthEvery)
	}
}
