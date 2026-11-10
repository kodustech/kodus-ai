//go:build dockersmoke

package dockergvisor

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockercli"
)

// A round's reset of the sample app (Express + pgvector, seeded through
// docker-entrypoint-initdb.d, data.reset: recreate) under runsc, through the
// real driver and the host's Docker, as runReset does it: Reset, then Up,
// then the recipe's steps (RunRecipe). It needs root on a Docker with runsc
// and the app's image built by hand (the smoke has no builder):
//
//	docker build --label kr-reset-smoke=1 -t kr-reset-smoke/app:local experiments/kody-runtime/sample-app/app
//	KGR_APP_DIR=.../sample-app/app KGR_APP_IMAGE=kr-reset-smoke/app:local KGR_RESETS=8 [KGR_HEALTH_START=-1ns] [KGR_GOLDEN=off] \
//	  go test -tags dockersmoke -run TestSmokeResetSampleApp -v ./internal/drivers/dockergvisor/
//
// After each reset it checks the round starts as the first did: the
// seeded rows and their checksum, nothing a previous round wrote, and a new
// app process. The sample's recipe declares the same seed file its compose
// binds into initdb, so the recipe's seed is not run a second time
// (seedRunsAtInit). With the golden data on (the default; KGR_GOLDEN=off
// turns it off) every reset must have restored the first boot's copy.
func TestSmokeResetSampleApp(t *testing.T) {
	dir, file := smokeApp(t)
	golden := os.Getenv("KGR_GOLDEN") != "off"
	m := newSmokeMachine(t, dir, file, !golden, ordersState)
	for i := range smokeResets() {
		tm := m.reset(t, i)
		if golden && tm.RestoreMs == 0 {
			t.Fatalf("reset %d restored no golden data: %+v", i, tm)
		}
	}
	m.report(t)
}

// The same app with the seed the recipe's alone (no initdb bind): a SQL
// file piped into db. The golden data's first boot runs it before the app
// starts, and no reset runs it again.
func TestSmokeResetSQLSeed(t *testing.T) {
	dir, file := smokeApp(t)
	file = dropInitdbBind(t, file)
	m := newSmokeMachine(t, dir, file, false, ordersState)
	for i := range smokeResets() {
		if tm := m.reset(t, i); tm.RestoreMs == 0 {
			t.Fatalf("reset %d restored no golden data: %+v", i, tm)
		}
	}
	m.report(t)
}

// The same app booted by its recipe's steps alone: the compose file seeds
// nothing (no initdb bind), setup writes a marker in the app's container,
// data.migrate creates the tables from the app's container (node and pg),
// and data.seed pipes a SQL file into db that only works after the
// migration. Every reset must start from that same state: the rows and
// their checksum, one migration, a setup that ran in this round's container.
// The migrate runs in the app, so this machine keeps the reset as it was
// (no golden data).
//
//	KGR_APP_DIR=... KGR_APP_IMAGE=kr-reset-smoke/app:local KGR_RESETS=8 \
//	  go test -tags dockersmoke -run TestSmokeResetRecipeSteps -v ./internal/drivers/dockergvisor/
func TestSmokeResetRecipeSteps(t *testing.T) {
	dir, file := smokeApp(t)
	file = dropInitdbBind(t, file)
	writeSmoke(t, filepath.Join(dir, "db", "recipe-seed.sql"), "INSERT INTO orders (id, item, quantity) VALUES (1, 'keyboard', 2), (2, 'monitor', 1);\nSELECT setval('orders_id_seq', 2);\n")
	writeSmoke(t, filepath.Join(dir, ".kodus", "workspace.yaml"), `version: 1
setup:
  - date +%s%N > /tmp/kodus-setup-ran
services:
  compose:
    files: [docker-compose.yml]
    public: app
    health: /health
    health_timeout: 120s
  expose:
    - { service: app, port: 3000, kind: http }
data:
  migrate: >-
    node -e "const {Client}=require('pg'); const c=new Client({connectionString: process.env.DATABASE_URL});
    c.connect().then(()=>c.query('CREATE TABLE IF NOT EXISTS orders (id SERIAL PRIMARY KEY, item TEXT NOT NULL, quantity INTEGER NOT NULL CHECK (quantity > 0)); CREATE TABLE IF NOT EXISTS kodus_migrations (at timestamptz DEFAULT now()); INSERT INTO kodus_migrations DEFAULT VALUES'))
    .then(()=>c.end()).catch((e)=>{console.error(e.message); process.exit(1)})"
  seed: { service: db, sql: db/recipe-seed.sql, user: shop, database: shop }
  reset: recreate
`)
	var marker string
	m := newSmokeMachine(t, dir, file, false, func(t *testing.T, project string) string {
		mk := strings.TrimSpace(composeExec(t, project, "app", "cat", "/tmp/kodus-setup-ran"))
		if mk == "" || mk == marker {
			t.Fatalf("setup did not run in this round's app container (marker %q, last %q)", mk, marker)
		}
		marker = mk
		return psql(t, project, "SELECT count(*) || ' rows ' || md5(string_agg(id || ':' || item || ':' || quantity, ',' ORDER BY id)) || ', migrations ' || (SELECT count(*) FROM kodus_migrations) FROM orders")
	})
	for i := range smokeResets() {
		if tm := m.reset(t, i); tm.RestoreMs != 0 {
			t.Fatalf("reset %d restored golden data under a migrate that runs in the app: %+v", i, tm)
		}
	}
	m.report(t)
}

// Before and after on the same host at the same load: two machines of the
// sample app, one with the golden data and one without, reset in turns.
//
//	KGR_APP_DIR=... KGR_APP_IMAGE=kr-reset-smoke/app:local KGR_RESETS=12 \
//	  go test -tags dockersmoke -run TestSmokeResetInterleaved -v ./internal/drivers/dockergvisor/
func TestSmokeResetInterleaved(t *testing.T) {
	dir, file := smokeApp(t)
	before := newSmokeMachine(t, dir, file, true, ordersState)
	after := newSmokeMachine(t, dir, file, false, ordersState)
	for i := range smokeResets() {
		before.reset(t, i)
		after.reset(t, i)
	}
	t.Log("before (recreate):")
	before.report(t)
	t.Log("after (golden data):")
	after.report(t)
}

// ordersState is the seeded rows and their checksum.
func ordersState(t *testing.T, project string) string {
	return psql(t, project, "SELECT count(*) || ' rows ' || md5(coalesce(string_agg(id || ':' || item || ':' || quantity, ',' ORDER BY id), '')) FROM orders")
}

func smokeResets() int {
	if n, err := strconv.Atoi(os.Getenv("KGR_RESETS")); err == nil && n > 0 {
		return n
	}
	return 6
}

// dropInitdbBind takes the sample's initdb bind out of its compose file.
func dropInitdbBind(t *testing.T, file []byte) []byte {
	t.Helper()
	at := bytes.Index(file, []byte("        volumes:\n            - ./db/seed.sql"))
	end := bytes.Index(file[max(at, 0):], []byte("        healthcheck:"))
	if at < 0 || end < 0 {
		t.Fatal("the sample's compose file changed: no initdb bind to drop")
	}
	return append(file[:at:at], file[at+end:]...)
}

// smokeApp copies the sample app and its compose file, the image prebuilt.
func smokeApp(t *testing.T) (string, []byte) {
	appDir, image := os.Getenv("KGR_APP_DIR"), os.Getenv("KGR_APP_IMAGE")
	if appDir == "" || image == "" {
		t.Skip("KGR_APP_DIR and KGR_APP_IMAGE not set")
	}
	dir := t.TempDir()
	if out, err := exec.Command("cp", "-a", appDir+"/.", dir).CombinedOutput(); err != nil {
		t.Fatalf("copy the app: %v %s", err, out)
	}
	file, err := os.ReadFile(filepath.Join(dir, "docker-compose.yml"))
	if err != nil {
		t.Fatal(err)
	}
	return dir, bytes.Replace(file, []byte("build: ."), []byte("image: "+image), 1)
}

// smokeMachine is one machine of the app on its own driver and claim,
// booted as the agent boots it (Up, RunRecipe).
type smokeMachine struct {
	d      *Driver
	ref    driver.MachineRef
	claim  string
	dir    string
	file   []byte
	state  func(*testing.T, string) string
	first  string
	appPID string
	totals []int64
	phases []driver.BootTiming
	// recipeMs is the last RunRecipe.
	recipeMs int64
}

func newSmokeMachine(t *testing.T, appDir string, file []byte, noGolden bool, state func(*testing.T, string) string) *smokeMachine {
	t.Helper()
	ctx := context.Background()
	// Each machine its own copy of the checkout, as each claim has.
	dir := t.TempDir()
	if out, err := exec.Command("cp", "-a", appDir+"/.", dir).CombinedOutput(); err != nil {
		t.Fatalf("copy the app: %v %s", err, out)
	}
	// KGR_HEALTH_START: the fast start's cadence ("200ms"), "-1ns" off.
	health, _ := time.ParseDuration(os.Getenv("KGR_HEALTH_START"))
	cell := fmt.Sprintf("smoke-%d", time.Now().UnixNano()%1_000_000)
	d, err := New(ctx, dockercli.CLI{}, Config{CellID: cell, HolderImage: "alpine:3.20", WorkDir: t.TempDir(), MemLimit: "2g", CPUs: "2", HealthStartInterval: health, NoGoldenData: noGolden,
		Log: slog.New(slog.NewTextHandler(smokeLog{t}, &slog.HandlerOptions{Level: slog.LevelInfo}))})
	if err != nil {
		t.Fatal(err)
	}
	claim := "c" + cell
	n, err := d.PrepareClaim(ctx, driver.ClaimNetworkSpec{CellID: cell, OrgID: "org-smoke", ClaimID: claim})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	ref, err := d.Create(ctx, driver.MachineSpec{CellID: cell, EnvironmentID: "env", Role: driver.RoleWorkload, OrgID: "org-smoke", ClaimID: claim,
		ImageID: "img", ClaimGroupID: n.WorkloadGroupID, KMSKeyRef: "local", ExpiresAt: now.Add(time.Hour), HardExpiresAt: now.Add(2 * time.Hour)})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := d.Destroy(context.WithoutCancel(ctx), ref); err != nil {
			t.Errorf("destroy: %v", err)
		}
		if err := d.ReleaseClaim(context.WithoutCancel(ctx), n); err != nil {
			t.Errorf("release: %v", err)
		}
		// Nothing of the machine is left: no golden volume either.
		out, _ := exec.Command("docker", "volume", "ls", "-q", "--filter", "label="+labelGoldenOf+"="+ref.MachineID).Output()
		if len(bytes.TrimSpace(out)) > 0 {
			t.Errorf("golden volumes outlived the machine: %s", out)
		}
	})
	m := &smokeMachine{d: d, ref: ref, claim: claim, dir: dir, file: file, state: state}
	start := time.Now()
	m.up(t)
	tm, _ := d.BootTiming(claim)
	t.Logf("%s boot %d ms (snapshot %d ms)", ref.MachineID, time.Since(start).Milliseconds(), tm.SnapshotMs)
	m.first = state(t, ref.MachineID)
	t.Logf("first boot: %s", m.first)
	m.appPID = appStarted(t, ref.MachineID)
	return m
}

func (m *smokeMachine) up(t *testing.T) {
	t.Helper()
	ctx := context.Background()
	if _, err := m.d.Up(ctx, m.ref, m.file, m.dir); err != nil {
		t.Fatal(err)
	}
	at := time.Now()
	if err := m.d.RunRecipe(ctx, m.ref, m.dir); err != nil {
		t.Fatal(err)
	}
	m.recipeMs = time.Since(at).Milliseconds()
}

// reset writes a row, resets as runReset does, and checks the round
// starts as the first boot did, on a new app process.
func (m *smokeMachine) reset(t *testing.T, i int) driver.BootTiming {
	t.Helper()
	row := "round-" + strconv.Itoa(i)
	psql(t, m.ref.MachineID, "INSERT INTO orders (item, quantity) VALUES ('"+row+"', 1)")
	if got := psql(t, m.ref.MachineID, "SELECT count(*) FROM orders WHERE item = '"+row+"'"); got != "1" {
		t.Fatalf("reset %d: the round's write did not land (%s)", i, got)
	}
	start := time.Now()
	if err := m.d.Reset(context.Background(), m.ref, driver.SnapshotRef{Kind: "compose_volumes"}); err != nil {
		t.Fatal(err)
	}
	m.up(t)
	total := time.Since(start).Milliseconds()
	m.totals = append(m.totals, total)
	tm, _ := m.d.BootTiming(m.claim)
	m.phases = append(m.phases, tm)
	t.Logf("%s reset %d: %d ms (driver %s total=%d down=%d restore=%d up=%d seed=%d ready=%d; recipe steps %d)", m.ref.MachineID, i, total, tm.Kind, tm.TotalMs, tm.DownMs, tm.RestoreMs, tm.UpMs, tm.SeedMs, tm.ReadyMs, m.recipeMs)
	if got := m.state(t, m.ref.MachineID); got != m.first {
		t.Fatalf("reset %d: %s, the first boot had %s", i, got, m.first)
	}
	if got := psql(t, m.ref.MachineID, "SELECT count(*) FROM orders WHERE item LIKE 'round-%'"); got != "0" {
		t.Fatalf("reset %d: %s rows of earlier rounds are back", i, got)
	}
	if p := appStarted(t, m.ref.MachineID); p == m.appPID {
		t.Fatalf("reset %d: the app process is the previous round's (%s)", i, p)
	} else {
		m.appPID = p
	}
	return tm
}

// report logs the medians of the resets, whole and per phase.
func (m *smokeMachine) report(t *testing.T) {
	med := func(f func(driver.BootTiming) int64) int64 {
		v := make([]int64, 0, len(m.phases))
		for _, p := range m.phases {
			v = append(v, f(p))
		}
		slices.Sort(v)
		return v[len(v)/2]
	}
	totals := slices.Clone(m.totals)
	slices.Sort(totals)
	t.Logf("median reset %d ms over %d (min %d, max %d); driver medians total=%d down=%d restore=%d up=%d seed=%d ready=%d",
		totals[len(totals)/2], len(totals), totals[0], totals[len(totals)-1],
		med(func(b driver.BootTiming) int64 { return b.TotalMs }), med(func(b driver.BootTiming) int64 { return b.DownMs }),
		med(func(b driver.BootTiming) int64 { return b.RestoreMs }), med(func(b driver.BootTiming) int64 { return b.UpMs }),
		med(func(b driver.BootTiming) int64 { return b.SeedMs }), med(func(b driver.BootTiming) int64 { return b.ReadyMs }))
}

// smokeLog sends the driver's golden data events to the test's log.
type smokeLog struct{ t *testing.T }

func (w smokeLog) Write(p []byte) (int, error) {
	if line := string(p); strings.Contains(line, "data.golden") {
		w.t.Log(strings.TrimSpace(line))
	}
	return len(p), nil
}

func writeSmoke(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func psql(t *testing.T, project, q string) string {
	t.Helper()
	return strings.TrimSpace(composeExec(t, project, "db", "psql", "-U", "shop", "-d", "shop", "-tAc", q))
}

func composeExec(t *testing.T, project, service string, cmd ...string) string {
	t.Helper()
	out, err := exec.Command("docker", append([]string{"compose", "-p", project, "exec", "-T", service}, cmd...)...).CombinedOutput()
	if err != nil {
		t.Fatalf("%s %q: %v %s", service, cmd, err, out)
	}
	return string(out)
}

// appStarted is the app container's id and start: a new process has
// another.
func appStarted(t *testing.T, project string) string {
	t.Helper()
	out, err := exec.Command("docker", "compose", "-p", project, "ps", "-q", "app").Output()
	if err != nil {
		t.Fatal(err)
	}
	id := strings.TrimSpace(string(out))
	at, err := exec.Command("docker", "inspect", "-f", "{{.State.StartedAt}}", id).Output()
	if err != nil {
		t.Fatal(err)
	}
	return id + "@" + strings.TrimSpace(string(at))
}
