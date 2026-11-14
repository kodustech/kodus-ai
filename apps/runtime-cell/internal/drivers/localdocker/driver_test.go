package localdocker

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"go.yaml.in/yaml/v3"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/observer"
)

// fakeDocker records the commands the driver runs and answers them.
type fakeDocker struct {
	calls      []string
	composes   map[string][]byte   // project -> the compose file it was last brought up with
	pulled     map[string][]string // project -> the services the build pulled
	containers []Container
	versionErr error
	port       int
}

func newFake() *fakeDocker {
	return &fakeDocker{composes: map[string][]byte{}, pulled: map[string][]string{}, port: 55000}
}

func (m *fakeDocker) Version(context.Context) (string, error) {
	m.calls = append(m.calls, "version")
	return "29.0.0", m.versionErr
}
func (m *fakeDocker) ComposeUp(_ context.Context, p ComposeProject) error {
	m.calls = append(m.calls, "up "+p.Name)
	b, err := os.ReadFile(p.File)
	m.composes[p.Name] = b
	return err
}
func (m *fakeDocker) ComposeBuild(_ context.Context, p ComposeProject, pullServices []string) error {
	m.calls = append(m.calls, "build "+p.Name)
	m.pulled[p.Name] = pullServices
	return nil
}
func (m *fakeDocker) ComposeExec(_ context.Context, project, service string, stdin []byte, cmd ...string) error {
	m.calls = append(m.calls, fmt.Sprintf("exec %s %s %s", project, service, strings.Join(cmd, " ")))
	if stdin != nil {
		m.calls = append(m.calls, "stdin "+strings.TrimSpace(string(stdin)))
	}
	return nil
}
func (m *fakeDocker) Shell(_ context.Context, dir string, env map[string]string, command string) error {
	m.calls = append(m.calls, "sh "+command)
	return nil
}
func (m *fakeDocker) ComposeDown(_ context.Context, project string, opts DownOptions) error {
	m.calls = append(m.calls, fmt.Sprintf("down %s v=%v", project, opts.Volumes))
	if opts.BuiltImages {
		m.calls = append(m.calls, "rmi "+project)
	}
	kept := m.containers[:0]
	for _, c := range m.containers {
		if c.Labels[labelProject] != project {
			kept = append(kept, c)
		}
	}
	m.containers = kept
	return nil
}
func (m *fakeDocker) ComposeStop(_ context.Context, project string) error {
	m.calls = append(m.calls, "stop "+project)
	return nil
}
func (m *fakeDocker) ComposeStart(_ context.Context, project string) error {
	m.calls = append(m.calls, "start "+project)
	return nil
}
func (m *fakeDocker) ComposePort(_ context.Context, project, service string, port int) (string, error) {
	m.port++
	m.calls = append(m.calls, fmt.Sprintf("port %s %s %d", project, service, port))
	return fmt.Sprintf("127.0.0.1:%d", m.port), nil
}
func (m *fakeDocker) List(_ context.Context, labels map[string]string) ([]Container, error) {
	var out []Container
	for _, c := range m.containers {
		if driver.Matches(c.Labels, labels) {
			out = append(out, c)
		}
	}
	return out, nil
}

func (m *fakeDocker) joined() string { return strings.Join(m.calls, "\n") }

func devEnv(k string) string {
	if k == DevEnv {
		return "1"
	}
	return ""
}

func config(t *testing.T, state string) Config {
	return Config{CellID: "cell-1", StateDir: state, MachinesDir: filepath.Join(state, "machines"), DevInsecure: true, Getenv: devEnv, Out: &bytes.Buffer{}}
}

func newDriver(t *testing.T, m *fakeDocker, state string) *Driver {
	t.Helper()
	d, err := New(context.Background(), m, config(t, state))
	if err != nil {
		t.Fatal(err)
	}
	return d
}

func TestRefusesWithoutFlag(t *testing.T) {
	m := newFake()
	cfg := config(t, t.TempDir())
	cfg.DevInsecure = false
	if _, err := New(context.Background(), m, cfg); !errors.Is(err, ErrNotDev) {
		t.Fatalf("err %v", err)
	}
	if len(m.calls) != 0 {
		t.Fatalf("touched docker before the gate: %v", m.calls)
	}
}

func TestRefusesWithoutEnv(t *testing.T) {
	for _, v := range []string{"", "0", "true"} {
		cfg := config(t, t.TempDir())
		cfg.Getenv = func(string) string { return v }
		if _, err := New(context.Background(), newFake(), cfg); !errors.Is(err, ErrNotDev) {
			t.Fatalf("%q: err %v", v, err)
		}
	}
}

func TestWarnsAndReportsNoIsolation(t *testing.T) {
	cfg := config(t, t.TempDir())
	out := &bytes.Buffer{}
	cfg.Out = out
	d, err := New(context.Background(), newFake(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "NO ISOLATION") || !strings.Contains(out.String(), "untrusted code") || strings.Count(out.String(), "\n") < 5 {
		t.Fatalf("banner %q", out.String())
	}
	if d.Capabilities().Isolation != driver.IsolationNone || driver.ProductionIsolation(d.Capabilities().Isolation) {
		t.Fatal("isolation must be none and never production")
	}
}

func TestRefusesWithoutDaemon(t *testing.T) {
	m := newFake()
	m.versionErr = errors.New("Cannot connect to the Docker daemon")
	if _, err := New(context.Background(), m, config(t, t.TempDir())); err == nil {
		t.Fatal("started without a daemon")
	}
}

var t0 = time.Date(2026, 10, 30, 12, 0, 0, 0, time.UTC)

func spec(role driver.Role) driver.MachineSpec {
	return driver.MachineSpec{CellID: "cell-1", EnvironmentID: "env", Role: role, OrgID: "org-a", ClaimID: "Claim-1",
		ImageID: "img-1", ClaimGroupID: "kodus-claim-1", KMSKeyRef: "local", ExpiresAt: t0.Add(5 * time.Minute), HardExpiresAt: t0.Add(time.Hour)}
}

const sampleCompose = `services:
  web:
    build: .
    container_name: fixed
    ports: ["0.0.0.0:3000:3000"]
    labels: ["team=a"]
  db:
    image: postgres:16
    ports: ["5432:5432"]
`

func writeRepo(t *testing.T, files map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	for n, c := range files {
		if err := os.WriteFile(filepath.Join(dir, n), []byte(c), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func TestLifecycle(t *testing.T) {
	ctx := context.Background()
	m := newFake()
	state := t.TempDir()
	d := newDriver(t, m, state)
	net, err := d.PrepareClaim(ctx, driver.ClaimNetworkSpec{CellID: "cell-1", OrgID: "org-a", ClaimID: "Claim-1", Expose: []driver.ExposePort{{Service: "web", Port: 3000, Kind: "http"}}})
	if err != nil {
		t.Fatal(err)
	}
	work, err := d.Create(ctx, spec(driver.RoleWorkload))
	if err != nil {
		t.Fatal(err)
	}
	obs, err := d.Create(ctx, spec(driver.RoleObserver))
	if err != nil {
		t.Fatal(err)
	}
	if work.MachineID != "kodus-claim-1-workload" || work.PrivateAddress != "127.0.0.1" || work.ImageID != "img-1" {
		t.Fatalf("ref %+v", work)
	}

	// The cell uploads the checkout; the upload boots the project.
	repo := writeRepo(t, map[string]string{"compose.yaml": sampleCompose, "Dockerfile": "FROM scratch\n"})
	if err := d.Transport().Upload(ctx, work, repo, "workspace"); err != nil {
		t.Fatal(err)
	}
	if err := d.Transport().Upload(ctx, obs, repo, "workspace"); err != nil {
		t.Fatal(err)
	}
	if got := strings.Count(m.joined(), "up "); got != 1 {
		t.Fatalf("observer upload must not boot: %v", m.calls)
	}
	var doc struct {
		Services map[string]struct {
			Ports         []string          `yaml:"ports"`
			ContainerName string            `yaml:"container_name"`
			Labels        map[string]string `yaml:"labels"`
		} `yaml:"services"`
	}
	if err := yaml.Unmarshal(m.composes[work.MachineID], &doc); err != nil {
		t.Fatal(err)
	}
	web, db := doc.Services["web"], doc.Services["db"]
	if len(web.Ports) != 1 || web.Ports[0] != "127.0.0.1::3000" || len(db.Ports) != 0 || web.ContainerName != "" {
		t.Fatalf("ports/names not rewritten: %+v", doc.Services)
	}
	if web.Labels["kodus.claim"] != "Claim-1" || web.Labels["kodus.cell"] != "cell-1" || web.Labels["team"] != "a" || db.Labels["kodus.hard-expires"] != driver.FormatTime(t0.Add(time.Hour)) {
		t.Fatalf("labels %+v / %+v", web.Labels, db.Labels)
	}
	addr, ok := d.HostAddress("Claim-1", "web", 3000)
	if !ok || addr != "127.0.0.1:55001" {
		t.Fatalf("host address %q %v", addr, ok)
	}
	ts, err := d.Targets("Claim-1", []observer.Target{{Service: "web", Port: 3000, Kind: "http", Address: "127.0.0.1:3000"}})
	if err != nil || ts[0].Address != "127.0.0.1:55001" {
		t.Fatalf("targets %+v %v", ts, err)
	}

	// SetExpiry never passes the ceiling.
	if err := d.SetExpiry(ctx, work, t0.Add(2*time.Hour)); err != nil {
		t.Fatal(err)
	}
	refs, _ := d.List(ctx, map[string]string{driver.TagClaim: "Claim-1", driver.TagRole: "workload"})
	if len(refs) != 1 || refs[0].Tags[driver.TagExpires] != driver.FormatTime(t0.Add(time.Hour)) {
		t.Fatalf("expiry %+v", refs)
	}

	if err := d.Suspend(ctx, work, driver.SuspendStop); err != nil {
		t.Fatal(err)
	}
	if err := d.Resume(ctx, work); err != nil {
		t.Fatal(err)
	}
	if addr, _ := d.HostAddress("Claim-1", "web", 3000); addr != "127.0.0.1:55002" {
		t.Fatalf("resume must re-read ports: %q", addr)
	}
	if err := d.Reset(ctx, work, driver.SnapshotRef{Kind: "disk"}); err == nil {
		t.Fatal("disk reset accepted")
	}
	if err := d.Reset(ctx, work, driver.SnapshotRef{Kind: "compose_volumes"}); err != nil {
		t.Fatal(err)
	}
	if err := d.Destroy(ctx, obs); err != nil {
		t.Fatal(err)
	}
	if err := d.Destroy(ctx, work); err != nil {
		t.Fatal(err)
	}
	if err := d.ReleaseClaim(ctx, net); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"version",
		"build kodus-claim-1-workload",
		"up kodus-claim-1-workload",
		"port kodus-claim-1-workload web 3000",
		"stop kodus-claim-1-workload",
		"start kodus-claim-1-workload",
		"port kodus-claim-1-workload web 3000",
		"down kodus-claim-1-workload v=true",
		"up kodus-claim-1-workload",
		"port kodus-claim-1-workload web 3000",
		// the reset above keeps the built images for its up; the destroy drops them
		"down kodus-claim-1-workload v=true",
		"rmi kodus-claim-1-workload",
	}
	if m.joined() != strings.Join(want, "\n") {
		t.Fatalf("calls:\n%s", m.joined())
	}
	if refs, _ := d.List(ctx, map[string]string{driver.TagCell: "cell-1"}); len(refs) != 0 {
		t.Fatalf("left behind %+v", refs)
	}
	if _, err := os.Stat(filepath.Join(state, "machines", work.MachineID)); !os.IsNotExist(err) {
		t.Fatalf("machine files left: %v", err)
	}
}

func TestSingleContainerFromDockerfile(t *testing.T) {
	ctx := context.Background()
	m := newFake()
	d := newDriver(t, m, t.TempDir())
	if _, err := d.PrepareClaim(ctx, driver.ClaimNetworkSpec{ClaimID: "Claim-1", Expose: []driver.ExposePort{{Service: "api", Port: 8080, Kind: "http"}}}); err != nil {
		t.Fatal(err)
	}
	work, _ := d.Create(ctx, spec(driver.RoleWorkload))
	if err := d.Boot(ctx, work, writeRepo(t, map[string]string{"Dockerfile": "FROM scratch\n"})); err != nil {
		t.Fatal(err)
	}
	c := string(m.composes[work.MachineID])
	if !strings.Contains(c, "api:") || !strings.Contains(c, "context: .") || !strings.Contains(c, "127.0.0.1::8080") {
		t.Fatalf("compose %s", c)
	}
	if err := d.Boot(ctx, work, t.TempDir()); !errors.Is(err, ErrNoEnvironment) {
		t.Fatalf("empty checkout: %v", err)
	}
}

func TestBootRefusesForgedLabelsAndUnknownServices(t *testing.T) {
	ctx := context.Background()
	for name, files := range map[string]map[string]string{
		"a checkout label could forge kodus:expires": {"compose.yaml": "services: { web: { image: w, labels: { kodus.expires: '2099-01-01T00:00:00Z' } } }\n"},
		"the claim exposes a service nobody runs":    {"compose.yaml": "services: { other: { image: w } }\n"},
	} {
		m := newFake()
		d := newDriver(t, m, t.TempDir())
		if _, err := d.PrepareClaim(ctx, driver.ClaimNetworkSpec{ClaimID: "Claim-1", Expose: []driver.ExposePort{{Service: "web", Port: 80, Kind: "http"}}}); err != nil {
			t.Fatal(err)
		}
		work, _ := d.Create(ctx, spec(driver.RoleWorkload))
		if err := d.Boot(ctx, work, writeRepo(t, files)); err == nil {
			t.Errorf("%s: booted", name)
		}
		if strings.Contains(m.joined(), "up ") {
			t.Errorf("%s: something ran:\n%s", name, m.joined())
		}
	}
}

// The build pulls only the registry images: compose pull would look for the
// project's own images in a registry too.
func TestBootPullsOnlyRegistryImages(t *testing.T) {
	ctx := context.Background()
	m := newFake()
	d := newDriver(t, m, t.TempDir())
	if _, err := d.PrepareClaim(ctx, driver.ClaimNetworkSpec{ClaimID: "Claim-1", Expose: []driver.ExposePort{{Service: "api", Port: 3001, Kind: "http"}}}); err != nil {
		t.Fatal(err)
	}
	work, _ := d.Create(ctx, spec(driver.RoleWorkload))
	repo := writeRepo(t, map[string]string{"compose.yaml": `services:
  api: { build: ., image: "app-dev:latest" }
  worker: { build: ., image: "app-dev:latest" }
  db: { image: "postgres:16" }
networks: { shared: { external: true } }
`})
	if err := d.Boot(ctx, work, repo); err != nil {
		t.Fatal(err)
	}
	if got := m.pulled[work.MachineID]; len(got) != 1 || got[0] != "db" {
		t.Fatalf("pulled %v", got)
	}
	c := string(m.composes[work.MachineID])
	if strings.Contains(c, "app-dev:latest") || !strings.Contains(c, work.MachineID+"-api") || strings.Contains(c, "external") {
		t.Fatalf("compose %s", c)
	}
}

func TestExpiryPersistsAcrossRestart(t *testing.T) {
	ctx := context.Background()
	state := t.TempDir()
	d := newDriver(t, newFake(), state)
	work, err := d.Create(ctx, spec(driver.RoleWorkload))
	if err != nil {
		t.Fatal(err)
	}
	if err := d.SetExpiry(ctx, work, t0.Add(20*time.Minute)); err != nil {
		t.Fatal(err)
	}
	// A new driver over the same state dir: the cell restarted.
	d2 := newDriver(t, newFake(), state)
	refs, err := d2.List(ctx, map[string]string{driver.TagCell: "cell-1"})
	if err != nil || len(refs) != 1 {
		t.Fatalf("refs %+v %v", refs, err)
	}
	if got := refs[0].Tags[driver.TagExpires]; got != driver.FormatTime(t0.Add(20*time.Minute)) {
		t.Fatalf("expires after restart %s", got)
	}
	if refs[0].Tags[driver.TagHardExpires] != driver.FormatTime(t0.Add(time.Hour)) {
		t.Fatalf("hard expires %s", refs[0].Tags[driver.TagHardExpires])
	}
}

func TestSweep(t *testing.T) {
	ctx := context.Background()
	m := newFake()
	d := newDriver(t, m, t.TempDir())
	live, _ := d.Create(ctx, spec(driver.RoleWorkload))
	stale := spec(driver.RoleWorkload)
	stale.ClaimID = "old"
	staleRef, _ := d.Create(ctx, stale)
	if err := d.SetExpiry(ctx, staleRef, t0.Add(-time.Minute)); err != nil {
		t.Fatal(err)
	}
	// An orphan: labelled by this cell, unknown to the state file (it was
	// lost). Nobody can date it, so it goes. Another cell's project stays.
	m.containers = []Container{
		{Name: "orphan-web-1", Labels: map[string]string{"kodus.cell": "cell-1", "kodus.claim": "gone", "kodus.role": "workload", "kodus.machine": "kodus-gone-workload", labelProject: "kodus-gone-workload", "kodus.hard-expires": driver.FormatTime(t0.Add(time.Hour))}},
		{Name: "live-web-1", Labels: map[string]string{"kodus.cell": "cell-1", "kodus.machine": live.MachineID, labelProject: live.MachineID}},
		{Name: "other-web-1", Labels: map[string]string{"kodus.cell": "cell-2", "kodus.machine": "kodus-x-workload"}},
		// This cell's label on a developer's own stack, with no machine
		// name: before, its compose project name stood in and the sweep took
		// it down with its volumes and images.
		{Name: "mystack-db-1", Labels: map[string]string{"kodus.cell": "cell-1", labelProject: "mystack"}},
	}
	gone, err := d.Sweep(ctx, t0)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(gone, ",") != "kodus-old-workload,kodus-gone-workload" && strings.Join(gone, ",") != "kodus-gone-workload,kodus-old-workload" {
		t.Fatalf("swept %v", gone)
	}
	if strings.Contains(m.joined(), live.MachineID+" v=") || strings.Contains(m.joined(), "kodus-x-workload") || strings.Contains(m.joined(), "mystack") {
		t.Fatalf("swept a live or foreign project: %s", m.joined())
	}
	// Past the hard ceiling, renewals do not save it.
	gone, _ = d.Sweep(ctx, t0.Add(time.Hour))
	if len(gone) != 1 || gone[0] != live.MachineID {
		t.Fatalf("hard ceiling sweep %v", gone)
	}
}
