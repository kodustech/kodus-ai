//go:build unix

package microvm

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/guest"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation/vmsnap"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/kodyexec"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/machinetrust"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/observer"
)

// envDriver is the driver on a backend whose machines' guest agent is the
// real one on a directory of the host, with a fake docker on its PATH that
// records what it ran.
func envDriver(t *testing.T) (*Driver, driver.MachineRef, string, string) {
	t.Helper()
	d, b, _ := newDriver(t)
	root, bin := t.TempDir(), t.TempDir()
	fake := "#!/bin/sh\necho \"$PWD $*\" >> " + filepath.Join(bin, "ran") + "\n"
	if err := os.WriteFile(filepath.Join(bin, "docker"), []byte(fake), 0o755); err != nil {
		t.Fatal(err)
	}
	fs, err := guest.OpenRoot(root)
	if err != nil {
		t.Fatal(err)
	}
	b.guestFS = fs.WithPath(bin + ":/usr/bin:/bin")
	ctx := context.Background()
	if _, err := d.PrepareClaim(ctx, driver.ClaimNetworkSpec{CellID: cell, OrgID: "org-a", ClaimID: "run-1"}); err != nil {
		t.Fatal(err)
	}
	ref, err := d.Create(ctx, spec("run-1"))
	if err != nil {
		t.Fatal(err)
	}
	return d, ref, root, bin
}

// The checkout goes into the environment VM under the workspace with its
// tree and modes; compose then runs in its project directory there, from
// the cell's compose file, under the claim's project name; the machine's
// one address is the claim's egress source.
func TestARunsCheckoutAndComposeProjectGoIntoItsVM(t *testing.T) {
	d, ref, root, bin := envDriver(t)
	ctx := context.Background()
	src := t.TempDir()
	_ = os.MkdirAll(filepath.Join(src, "repo", "public"), 0o755)
	_ = os.WriteFile(filepath.Join(src, "repo", "server.js"), []byte("console.log(1)\n"), 0o644)
	_ = os.WriteFile(filepath.Join(src, "repo", "public", "index.html"), []byte("<p>"), 0o644)
	_ = os.WriteFile(filepath.Join(src, "repo", "run.sh"), []byte("#!/bin/sh\n"), 0o755)
	big := make([]byte, 3*uploadChunk/2)
	_ = os.WriteFile(filepath.Join(src, "repo", "big.bin"), big, 0o644)
	if err := d.Upload(ctx, ref, src, "workspace", nil); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(filepath.Join(root, "workspace", "repo", "public", "index.html")); string(got) != "<p>" {
		t.Fatalf("index.html %q", got)
	}
	if fi, err := os.Stat(filepath.Join(root, "workspace", "repo", "run.sh")); err != nil || fi.Mode().Perm()&0o100 == 0 {
		t.Fatalf("run.sh lost its mode: %v %v", fi, err)
	}
	if fi, _ := os.Stat(filepath.Join(root, "workspace", "repo", "big.bin")); fi == nil || fi.Size() != int64(len(big)) {
		t.Fatalf("a file of more than one chunk: %v", fi)
	}
	if _, err := os.Stat(filepath.Join(root, ".kody-upload")); err == nil {
		if ents, _ := os.ReadDir(filepath.Join(root, ".kody-upload")); len(ents) > 0 {
			t.Fatalf("the staged archive stayed: %v", ents)
		}
	}
	sources, err := d.Up(ctx, driver.UpRequest{Ref: ref, Compose: []byte("services: {app: {build: ., ports: ['3000', '8080:80', 9000]}}\n"), ProjectDir: filepath.Join(src, "repo")})
	if err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(filepath.Join(root, "workspace", "repo", composeFileName))
	for _, want := range []string{"build: .", "- 3000:3000", "- 8080:80", "- 9000:9000"} {
		if !strings.Contains(string(got), want) {
			t.Fatalf("compose file %q lacks %q: a port the observer could not find after a reset", got, want)
		}
	}
	ran, _ := os.ReadFile(filepath.Join(bin, "ran"))
	if !strings.HasSuffix(strings.TrimSpace(string(ran)), "workspace/repo compose -p "+projectName(ref)+" -f .kodus-compose.yml up -d --build --wait --wait-timeout 540 --quiet-pull") {
		t.Fatalf("ran %q", ran)
	}
	if len(sources) != 1 || sources[0] != ref.PrivateAddress {
		t.Fatalf("sources %v, the machine is %s", sources, ref.PrivateAddress)
	}
	if _, err := d.Up(ctx, driver.UpRequest{Ref: ref, Compose: []byte("x"), ProjectDir: t.TempDir()}); err == nil {
		t.Fatal("a project directory outside the upload")
	}
}

// A command runs under the workspace whatever cwd it names, within the
// protocol's timeout, with its env.
func TestARunsCommandRunsUnderTheWorkspace(t *testing.T) {
	d, ref, root, _ := envDriver(t)
	ctx := context.Background()
	_ = os.MkdirAll(filepath.Join(root, "etc"), 0o755)
	r, err := d.Exec(ctx, ref, kodyexec.Request{Command: "pwd; echo $GREETING", Cwd: "../../etc", TimeoutMs: 5000, Env: []string{"GREETING=hi"}})
	if err != nil || r.ExitCode != 0 || !strings.HasSuffix(strings.Fields(r.Stdout)[0], "/etc") || !strings.Contains(r.Stdout, "hi") {
		t.Fatalf("exec %+v %v", r, err)
	}
	if !strings.HasPrefix(strings.Fields(r.Stdout)[0], root) && !strings.Contains(strings.Fields(r.Stdout)[0], filepath.Base(root)) {
		t.Fatalf("ran outside the workspace: %s", r.Stdout)
	}
	if _, err := d.Exec(ctx, ref, kodyexec.Request{Command: "true", TimeoutMs: 700_000}); err == nil {
		t.Fatal("a timeout past the guest agent's bound")
	}
}

// An environment machine just made is dialled until its guest agent
// answers: it boots for about a second after the VMM runs. Exec used to
// dial once and fail ("the guest does not answer on that port: EOF").
func TestARunsFirstCommandWaitsForTheGuestAgent(t *testing.T) {
	d, ref, _, _ := envDriver(t)
	b := d.cfg.Backend.(*memBackend)
	b.mu.Lock()
	b.dialFails = 3
	b.mu.Unlock()
	if r, err := d.Exec(context.Background(), ref, kodyexec.Request{Command: "true", TimeoutMs: 5000}); err != nil || r.ExitCode != 0 {
		t.Fatalf("exec on a booting machine: %+v %v", r, err)
	}
}

// An observer is a small microVM of the sandbox base: its TLS files are
// laid in it and the guest agent's observer mode started there, which the
// cell reaches over the VM's vsock only (DialObserver refuses any machine
// that is not an observer). The observer finds each exposed service at the
// workload VM's address on that service's port.
func TestAnObserverIsASmallVMReachedOverItsVsock(t *testing.T) {
	d, ref, root, bin := envDriver(t)
	b := d.cfg.Backend.(*memBackend)
	tls := t.TempDir()
	for _, f := range []string{"cert.pem", "key.pem", "ca.pem"} {
		_ = os.WriteFile(filepath.Join(tls, f), []byte("pem "+f), 0o600)
	}
	d.cfg.ObserverTLSDir = tls
	ctx := context.Background()
	obs := spec("run-1")
	obs.Role = driver.RoleObserver
	_ = os.WriteFile(filepath.Join(bin, "nohup"), []byte("#!/bin/sh\necho \"$*\" >> "+filepath.Join(bin, "observer")+"\n"), 0o755)
	oref, err := d.Create(ctx, obs)
	if err != nil {
		t.Fatal(err)
	}
	if got := b.specs[oref.MachineID]; got.Shape != isolation.ShapeSandbox || got.Memory != "512m" {
		t.Fatalf("observer spec %+v", got)
	}
	if k, _ := os.ReadFile(filepath.Join(root, ".kodus-observer", "key.pem")); string(k) != "pem key.pem" {
		t.Fatalf("observer key %q", k)
	}
	var started []byte
	// The observer starts in the background; under -race with the whole
	// module's tests in parallel it took more than 2 s.
	for deadline := time.Now().Add(15 * time.Second); time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
		if started, _ = os.ReadFile(filepath.Join(bin, "observer")); len(started) > 0 {
			break
		}
	}
	if !strings.Contains(string(started), "/usr/local/bin/kody-guest observer -vsock 7443 -cell-id cell-1 -cert .kodus-observer/cert.pem") {
		t.Fatalf("observer started as %q", started)
	}
	if _, err := d.DialObserver(ctx, oref.MachineID); err != nil {
		t.Fatalf("dial the observer: %v", err)
	}
	if _, err := d.DialObserver(ctx, ref.MachineID); err == nil {
		t.Fatal("the workload was dialled as an observer")
	}
	targets, err := d.Targets(ctx, ref.MachineID, []observer.Target{{Service: "app", Port: 3000}})
	if err != nil || len(targets) != 1 || targets[0].Address != ref.PrivateAddress+":3000" {
		t.Fatalf("targets %+v %v", targets, err)
	}
}

// A setup's machine the bake pinned outlives its claim's release until the
// bake keeps it as the environment's template; the claim's network goes
// then; a Run's workload of that image is restored from the template.
func TestASetupsBakeIsTheEnvironmentsTemplate(t *testing.T) {
	d, b, _ := newDriver(t)
	b.snapshots = true
	ctx := context.Background()
	n, _ := d.PrepareClaim(ctx, driver.ClaimNetworkSpec{CellID: cell, OrgID: "org-a", ClaimID: "setup-1"})
	s := spec("setup-1")
	s.Setup = true
	src, err := d.Create(ctx, s)
	if err != nil {
		t.Fatal(err)
	}
	if err := d.PinBakeSource(t.Context(), src); err != nil {
		t.Fatal(err)
	}
	if err := d.Destroy(ctx, src); err != nil {
		t.Fatal(err)
	}
	if err := d.ReleaseClaim(ctx, n); err != nil {
		t.Fatal(err)
	}
	if left, _ := d.List(ctx, nil); len(left) != 1 {
		t.Fatalf("the pinned setup machine went with its claim: %v", left)
	}
	img, err := d.Bake(ctx, driver.BakeSpec{CellID: cell, OrgID: "org-a", EnvironmentID: "env-1", Source: src})
	if err != nil || img.ImageID == "" {
		t.Fatalf("bake %+v %v", img, err)
	}
	if left, _ := d.List(ctx, nil); len(left) != 0 || len(b.forgot) != 1 {
		t.Fatalf("after the bake: machines %v, released %v", left, b.forgot)
	}
	_, _ = d.PrepareClaim(ctx, driver.ClaimNetworkSpec{CellID: cell, OrgID: "org-a", ClaimID: "run-2"})
	run := spec("run-2")
	run.ImageID = img.ImageID
	if _, err := d.Create(ctx, run); err != nil || len(b.restores) != 1 {
		t.Fatalf("a Run's workload of the bake: %v (restores %d)", err, len(b.restores))
	}
}

// A Run's decoy credentials file and, for a claim with org secrets, the
// cell's trust files go into every service of its VM, read-only, with the
// trust variables over the compose file's own.
func TestTheRunsDecoyAndTrustFilesGoIntoEveryService(t *testing.T) {
	d, ref, root, _ := envDriver(t)
	trust := t.TempDir()
	_ = os.WriteFile(filepath.Join(trust, "b.pem"), []byte("bundle"), 0o644)
	_ = os.WriteFile(filepath.Join(trust, "c.pem"), []byte("cellca"), 0o644)
	d.cfg.Trust = machinetrust.Files{Bundle: filepath.Join(trust, "b.pem"), CellCA: filepath.Join(trust, "c.pem")}
	src := t.TempDir()
	_ = os.MkdirAll(filepath.Join(src, "repo"), 0o755)
	ctx := context.Background()
	if err := d.Upload(ctx, ref, src, "workspace", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Up(ctx, driver.UpRequest{
		Ref: ref, Compose: []byte("services:\n  app: {image: a, environment: {SSL_CERT_FILE: /mine}}\n  db: {image: b}\n"), ProjectDir: filepath.Join(src, "repo"),
		Canaries: []driver.Canary{{Slot: driver.CanarySlotNpmrc, Value: "npm_decoy"}}, CellTrust: true,
	}); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(filepath.Join(root, "workspace", "repo", composeFileName))
	for _, want := range []string{"target: /run/secrets/npmrc", "target: /etc/kodus/ca-bundle.pem", "target: /etc/kodus/cell-ca.pem", "SSL_CERT_FILE: /etc/kodus/ca-bundle.pem"} {
		if strings.Count(string(got), want) != 2 {
			t.Fatalf("compose file lacks %q in both services:\n%s", want, got)
		}
	}
	if b, _ := os.ReadFile(filepath.Join(root, "workspace", "repo", ".kodus-cell", "npmrc")); !strings.Contains(string(b), "npm_decoy") {
		t.Fatalf("decoy %q", b)
	}
}

// A probe round's service logs come from the VM's dockerd through the
// guest agent: every service of the claim's project, in the round's window,
// oldest first, the newest kept within the cap; a non-workload has none.
func TestARoundsServiceLogsAreReadFromTheVMsDocker(t *testing.T) {
	d, ref, _, bin := envDriver(t)
	fake := `#!/bin/sh
echo "$*" >> ` + filepath.Join(bin, "ran") + `
case "$*" in
*" ps -a --format json") printf '{"Service":"api","State":"running"}\n{"Service":"db","State":"running"}\n' ;;
*" api") printf '2026-11-13T05:00:02Z GET /orders 200\n2026-11-13T05:00:04Z GET / 200\n' ;;
*" db") printf '2026-11-13T05:00:03Z checkpoint\n' ;;
esac
`
	if err := os.WriteFile(filepath.Join(bin, "docker"), []byte(fake), 0o755); err != nil {
		t.Fatal(err)
	}
	since, until := time.Date(2026, 11, 13, 5, 0, 0, 0, time.UTC), time.Date(2026, 11, 13, 5, 1, 0, 0, time.UTC)
	got, err := d.ServiceLogs(context.Background(), "run-1", ref, since, until, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].Service != "db" || got[0].Text != "checkpoint" || got[1].Service != "api" || got[1].Text != "GET / 200" {
		t.Fatalf("lines %+v: want the two newest, oldest first", got)
	}
	ran, _ := os.ReadFile(filepath.Join(bin, "ran"))
	want := "compose -p " + projectName(ref) + " logs --no-color --no-log-prefix --timestamps --since 2026-11-13T05:00:00Z --until 2026-11-13T05:01:00Z --tail 2 api"
	if !strings.Contains(string(ran), want) {
		t.Fatalf("ran %q, want %q", ran, want)
	}
	obs := ref
	obs.Tags = map[string]string{driver.TagRole: string(driver.RoleObserver)}
	if _, err := d.ServiceLogs(context.Background(), "run-1", obs, since, until, 2); err == nil {
		t.Fatal("service logs of a machine that is not a workload")
	}
}

// A Run's workload of a template this cell cannot restore (it holds none of
// that id, or one of another org, kit or host: the backend refuses it)
// boots cold, as an environment machine from the claim's checkout; nothing
// of the template is read. Any other restore failure stays a failure.
func TestARunsWorkloadOfATemplateNotHereBootsCold(t *testing.T) {
	d, b, _ := newDriver(t)
	ctx := context.Background()
	if _, err := d.PrepareClaim(ctx, driver.ClaimNetworkSpec{CellID: cell, OrgID: "org-a", ClaimID: "run-1"}); err != nil {
		t.Fatal(err)
	}
	run := spec("run-1")
	run.ImageID = "ksn-0123456789abcdef0123456789abcdef"
	ref, err := d.Create(ctx, run)
	if err != nil {
		t.Fatalf("a template of another cell: %v", err)
	}
	if len(b.restores) != 1 || b.specs[ref.MachineID].Shape != isolation.ShapeEnvironment {
		t.Fatalf("restores %d, machine %+v: want one refused restore, then a cold environment machine", len(b.restores), b.specs[ref.MachineID])
	}
	b.mu.Lock()
	b.restoreErr = errors.New("disk read failed")
	b.mu.Unlock()
	if _, err := d.PrepareClaim(ctx, driver.ClaimNetworkSpec{CellID: cell, OrgID: "org-a", ClaimID: "run-2"}); err != nil {
		t.Fatal(err)
	}
	broken := spec("run-2")
	broken.ImageID = run.ImageID
	if _, err := d.Create(ctx, broken); err == nil {
		t.Fatal("a restore that failed for another reason booted cold")
	}
}

// A workload's health is the guest kernel's oom_kill counter while its
// guest agent answers; a machine whose agent no longer answers, or that is
// gone, no longer runs.
func TestAWorkloadsHealthIsItsKernelsOOMCounter(t *testing.T) {
	d, ref, _, _ := envDriver(t)
	vmstat := filepath.Join(t.TempDir(), "vmstat")
	_ = os.WriteFile(vmstat, []byte("nr_free_pages 100\noom_kill 3\npgfault 9\n"), 0o644)
	d.vmstatFile = vmstat
	h, err := d.MachineHealth(context.Background(), ref)
	if err != nil || !h.Running || h.OOMKills != 3 {
		t.Fatalf("health %+v %v", h, err)
	}
	b := d.cfg.Backend.(*memBackend)
	b.mu.Lock()
	b.dialFails = 1 << 20
	b.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if h, err := d.MachineHealth(ctx, ref); err != nil || h.Running {
		t.Fatalf("a machine whose agent does not answer: %+v %v", h, err)
	}
	gone := ref
	gone.MachineID = "kodus-gone-workload"
	if h, err := d.MachineHealth(context.Background(), gone); err != nil || h.Running {
		t.Fatalf("a machine that is gone: %+v %v", h, err)
	}
}

// A machine a Run's canaries were planted in (its services' decoy file)
// is tainted before they are written, so it never becomes a template or a
// session (S-28); a machine without canaries keeps its record clean.
func TestAMachineWithTheRunsCanariesNeverBecomesASnapshot(t *testing.T) {
	d, ref, _, _ := envDriver(t)
	b := d.cfg.Backend.(*memBackend)
	src := t.TempDir()
	_ = os.MkdirAll(filepath.Join(src, "repo"), 0o755)
	ctx := context.Background()
	if err := d.Upload(ctx, ref, src, "workspace", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Up(ctx, driver.UpRequest{Ref: ref, Compose: []byte("services: {app: {image: a}}\n"), ProjectDir: filepath.Join(src, "repo")}); err != nil {
		t.Fatal(err)
	}
	if got := b.specs[ref.MachineID].Taints; slices.Contains(got, isolation.TaintCanaries) {
		t.Fatalf("a machine without canaries was tainted: %v", got)
	}
	if _, err := d.Up(ctx, driver.UpRequest{Ref: ref, Compose: []byte("services: {app: {image: a}}\n"), ProjectDir: filepath.Join(src, "repo"), Canaries: []driver.Canary{{Slot: driver.CanarySlotNpmrc, Value: "npm_decoy"}}}); err != nil {
		t.Fatal(err)
	}
	if got := b.specs[ref.MachineID].Taints; !slices.Contains(got, isolation.TaintCanaries) {
		t.Fatalf("taints %v: the machine holds the Run's canaries", got)
	}
	if err := vmsnap.Admit(vmsnap.Facts{Org: "org-a", Setup: true, Taints: b.specs[ref.MachineID].Taints}, isolation.PurposeTemplate, "org-a"); err == nil {
		t.Fatal("a machine with canaries would become a template")
	}
}

// S-28 (c): a setup machine whose builds are handed the org's secrets is
// recorded as handed secrets before compose builds, even when its spec did
// not say so, and never becomes a template: the environment boots cold.
func TestASetupWhoseBuildsGetSecretsNeverBecomesATemplate(t *testing.T) {
	d, ref, _, _ := envDriver(t)
	b := d.cfg.Backend.(*memBackend)
	src := t.TempDir()
	_ = os.MkdirAll(filepath.Join(src, "repo"), 0o755)
	ctx := context.Background()
	if err := d.Upload(ctx, ref, src, "workspace", nil); err != nil {
		t.Fatal(err)
	}
	if got := b.specs[ref.MachineID].Taints; slices.Contains(got, isolation.TaintSecrets) {
		t.Fatalf("a machine without secrets was tainted: %v", got)
	}
	if _, err := d.Up(ctx, driver.UpRequest{Ref: ref, Compose: []byte("services: {app: {build: .}}\n"), ProjectDir: filepath.Join(src, "repo"), BuildSecrets: map[string]string{"NPM_TOKEN": "kodus-ph-a"}}); err != nil {
		t.Fatal(err)
	}
	taints := b.specs[ref.MachineID].Taints
	if !slices.Contains(taints, isolation.TaintSecrets) {
		t.Fatalf("taints %v: the machine's builds were handed secrets", taints)
	}
	if err := vmsnap.Admit(vmsnap.Facts{Org: "org-a", Setup: true, Taints: taints}, isolation.PurposeTemplate, "org-a"); !errors.Is(err, vmsnap.ErrRefused) {
		t.Fatalf("a setup whose builds got secrets would become a template: %v", err)
	}
}

// An environment's data disk is sized from its setup: the bake measures
// the setup disk's high-water mark and the environment's next machines boot
// with 1.5 times it in whole GiB (at least 2, at most the cell's ceiling),
// kept across a restart of the cell; an environment with no need yet boots
// at the ceiling.
func TestAnEnvironmentsDataDiskIsSizedFromItsSetupsPeak(t *testing.T) {
	d, b, _ := newDriver(t)
	b.snapshots = true
	d.cfg.DataCeilingGB = 20
	d.cfg.NeedsFile = filepath.Join(t.TempDir(), "environment-disks.json")
	ctx := context.Background()
	n, _ := d.PrepareClaim(ctx, driver.ClaimNetworkSpec{CellID: cell, OrgID: "org-a", ClaimID: "setup-1"})
	s := spec("setup-1")
	s.Setup = true
	src, err := d.Create(ctx, s)
	if err != nil {
		t.Fatal(err)
	}
	if got := b.specs[src.MachineID].DiskSize; got != "" {
		t.Fatalf("a first setup asked a %q data disk, want the ceiling", got)
	}
	if err := d.PinBakeSource(t.Context(), src); err != nil {
		t.Fatal(err)
	}
	b.mu.Lock()
	b.dataPeak = 5<<30 + 1 // 5 GiB and a byte: ×1.5 = 7.5 GiB, so 8
	b.mu.Unlock()
	if _, err := d.Bake(ctx, driver.BakeSpec{CellID: cell, OrgID: "org-a", EnvironmentID: "env-1", Source: src}); err != nil {
		t.Fatal(err)
	}
	_ = d.ReleaseClaim(ctx, n)
	_, _ = d.PrepareClaim(ctx, driver.ClaimNetworkSpec{CellID: cell, OrgID: "org-a", ClaimID: "run-2"})
	ref, err := d.Create(ctx, spec("run-2"))
	if err != nil {
		t.Fatal(err)
	}
	if got := b.specs[ref.MachineID].DiskSize; got != "8g" {
		t.Fatalf("the environment's next machine asked %q, want 8g", got)
	}
	other := spec("run-3")
	other.EnvironmentID = "env-2"
	_, _ = d.PrepareClaim(ctx, driver.ClaimNetworkSpec{CellID: cell, OrgID: "org-a", ClaimID: "run-3"})
	if ref, err := d.Create(ctx, other); err != nil || b.specs[ref.MachineID].DiskSize != "" {
		t.Fatalf("another environment took this one's need: %v", err)
	}
	again, err := New(d.cfg)
	if err != nil {
		t.Fatal(err)
	}
	if got := again.diskSizeOf("org-a", "env-1"); got != "8g" {
		t.Fatalf("after a restart the need is %q", got)
	}
	for peak, want := range map[int64]int64{0: 2, 1 << 30: 2, 3 << 30: 5, 19 << 30: 20} {
		if got := d.needOf(peak) >> 30; got != want {
			t.Errorf("a %d GiB peak needs %d GiB, want %d", peak>>30, got, want)
		}
	}
}

// A boot that fails on a full data disk is the cell's disk capacity, named:
// below the ceiling the environment's next machines get the ceiling; at the
// ceiling the blocker says so. A boot that fails with room left stays the
// repository's.
func TestABootThatFillsItsDataDiskIsDiskCapacity(t *testing.T) {
	d, ref, _, bin := envDriver(t)
	d.cfg.DataCeilingGB = 20
	d.cfg.NeedsFile = ""
	if ref.Tags[driver.TagOrg] != "org-a" || ref.Tags[driver.TagEnv] != "env-1" {
		t.Fatalf("the machine's tags %v", ref.Tags)
	}
	src := t.TempDir()
	_ = os.MkdirAll(filepath.Join(src, "repo"), 0o755)
	ctx := context.Background()
	if err := d.Upload(ctx, ref, src, "workspace", nil); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(bin, "docker"), []byte("#!/bin/sh\necho 'no space left on device' >&2\nexit 1\n"), 0o755)
	df := func(size, avail int64) {
		_ = os.WriteFile(filepath.Join(bin, "df"), []byte(fmt.Sprintf("#!/bin/sh\necho '  Size Avail'\necho '%d %d'\n", size, avail)), 0o755)
	}
	df(8<<30, 4<<30)
	if _, err := d.Up(ctx, driver.UpRequest{Ref: ref, Compose: []byte("services: {app: {image: a}}\n"), ProjectDir: filepath.Join(src, "repo")}); errors.Is(err, driver.ErrDiskCapacity) || !errors.Is(err, driver.ErrWorkloadBoot) {
		t.Fatalf("a failed boot with room left: %v", err)
	}
	df(8<<30, 10<<20)
	_, err := d.Up(ctx, driver.UpRequest{Ref: ref, Compose: []byte("services: {app: {image: a}}\n"), ProjectDir: filepath.Join(src, "repo")})
	if !errors.Is(err, driver.ErrDiskCapacity) || !strings.Contains(err.Error(), "8 GiB") || !strings.Contains(err.Error(), "20 GiB") {
		t.Fatalf("a full 8 GiB disk: %v", err)
	}
	if got := d.diskSizeOf("org-a", "env-1"); got != "" {
		t.Fatalf("after filling 8 GiB the environment's next disk is %q, want the ceiling", got)
	}
	df(20<<30, 10<<20)
	if _, err := d.Up(ctx, driver.UpRequest{Ref: ref, Compose: []byte("services: {app: {image: a}}\n"), ProjectDir: filepath.Join(src, "repo")}); !errors.Is(err, driver.ErrDiskCapacity) || !strings.Contains(err.Error(), "ceiling (-firecracker-data-gb)") {
		t.Fatalf("a full disk at the ceiling: %v", err)
	}
}
