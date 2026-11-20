package preflight

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/hostcheck"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation/firecracker"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/testpki"
)

// fakeDocker is a host's Docker as the checks ask it.
type fakeDocker struct {
	down       error
	api        string
	runtimes   []string
	info       dockercli.CgroupDaemonInfo
	infoErr    error
	endpoint   string
	dataRoot   string
	composeErr error
}

func (f fakeDocker) ServerVersion(context.Context) (string, error) {
	if f.down != nil {
		return "", f.down
	}
	return "27.3.1", nil
}
func (f fakeDocker) APIVersion(context.Context) (string, error) { return f.api, nil }
func (f fakeDocker) Runtimes(context.Context) ([]string, error) { return f.runtimes, nil }
func (f fakeDocker) CgroupInfo(context.Context) (dockercli.CgroupDaemonInfo, error) {
	return f.info, f.infoErr
}
func (f fakeDocker) DaemonEndpoint(context.Context) (string, error) { return f.endpoint, nil }
func (f fakeDocker) DataRoot(context.Context) (string, error)       { return f.dataRoot, nil }
func (f fakeDocker) ComposeVersion(context.Context) (string, error) {
	if f.composeErr != nil {
		return "", f.composeErr
	}
	return "2.29.7", nil
}

// healthyDocker is a host the docker-gvisor cell starts on.
func healthyDocker() fakeDocker {
	return fakeDocker{
		api: "1.47", runtimes: []string{"io.containerd.runc.v2", "runc", "runsc"}, endpoint: "unix:///var/run/docker.sock", dataRoot: "/var/lib/docker",
		info: dockercli.CgroupDaemonInfo{Version: "2", Driver: "systemd", Runtimes: map[string]dockercli.RuntimeInfo{"runsc": {Path: "/usr/local/bin/runsc", RuntimeArgs: []string{"--systemd-cgroup", "--oci-seccomp"}}}},
	}
}

func plenty(string) (uint64, error) { return 100 << 30, nil }

func byName(rs []Result) map[string]Result {
	m := map[string]Result{}
	for _, r := range rs {
		if _, seen := m[r.Name]; !seen {
			m[r.Name] = r
		}
	}
	return m
}

func statuses(rs []Result, name string) []Status {
	var out []Status
	for _, r := range rs {
		if r.Name == name {
			out = append(out, r.Status)
		}
	}
	return out
}

func gvisorSettings() GVisor {
	return GVisor{Runtime: "runsc", DockerDataRoot: "/var/lib/docker", DiskMinFreeGB: 5}
}

// The driver's rule as dockergvisor.ValidateClaimLimitDaemon states it: the
// test hands the checks a rule of the same shape, as cmd/cell hands the real one.
func strictDaemon(info dockercli.CgroupDaemonInfo, backend, runtime string) error {
	if info.Version != "2" || info.Driver != backend || info.Rootless {
		return errors.New("rootful Docker cgroup v2 must match configured backend")
	}
	if backend == "systemd" && !systemdCgroup(info.Runtimes[runtime]) {
		return errors.New("runsc must enable --systemd-cgroup")
	}
	return nil
}

func unixOnly(e string) error {
	if !strings.HasPrefix(e, "unix:///") {
		return errors.New("not a local socket")
	}
	return nil
}

func TestAHealthyDockerGVisorHostPassesEveryCheck(t *testing.T) {
	rs := CheckGVisor(context.Background(), healthyDocker(), gvisorSettings(), plenty)
	for _, r := range rs {
		if r.Status != OK {
			t.Errorf("%s = %s: %s", r.Name, r.Status, r.Reason)
		}
	}
	for _, want := range []string{NameDocker, NameDockerAPI, NameCompose, NameRunsc, NameDataRoot, NameDiskDocker} {
		if _, ok := byName(rs)[want]; !ok {
			t.Errorf("no %s check in %+v", want, rs)
		}
	}
}

// A Docker that does not answer is the only thing reported: every other
// check would only repeat it.
func TestADockerThatDoesNotAnswerFailsAloneWithHowToStartIt(t *testing.T) {
	d := healthyDocker()
	d.down = errors.New("Cannot connect to the Docker daemon at unix:///var/run/docker.sock\nIs the docker daemon running?")
	rs := CheckGVisor(context.Background(), d, gvisorSettings(), plenty)
	if len(rs) != 1 || rs[0].Name != NameDocker || rs[0].Status != Fail || rs[0].Fix == "" || strings.Contains(rs[0].Reason, "\n") {
		t.Fatalf("results %+v", rs)
	}
}

// gvisor.New refuses a daemon without the runsc runtime: the check fails
// first, naming the runtimes Docker has and how to register runsc.
func TestADockerWithoutRunscFailsNamingWhatItHasAndHowToRegisterIt(t *testing.T) {
	d := healthyDocker()
	d.runtimes = []string{"runc"}
	r := byName(CheckGVisor(context.Background(), d, gvisorSettings(), plenty))[NameRunsc]
	if r.Status != Fail || !strings.Contains(r.Reason, "runc") || !strings.Contains(r.Fix, "runsc install") {
		t.Fatalf("runsc %+v", r)
	}
}

func TestRunscReportsItsPathAndVersionWhenItRuns(t *testing.T) {
	g := gvisorSettings()
	g.RuntimeVersion = func(_ context.Context, path string) (string, error) {
		if path != "/usr/local/bin/runsc" {
			t.Errorf("version of %s", path)
		}
		return "runsc version release-20251110.0", nil
	}
	r := byName(CheckGVisor(context.Background(), healthyDocker(), g, plenty))[NameRunsc]
	if r.Status != OK || !strings.Contains(r.Reason, "/usr/local/bin/runsc") || !strings.Contains(r.Reason, "release-20251110.0") {
		t.Fatalf("runsc %+v", r)
	}
}

// An API older than 1.44 boots services without the fast healthcheck
// (dockergvisor healthStartInterval): a warning, not a refusal.
func TestADockerOlderThanAPI144Warns(t *testing.T) {
	d := healthyDocker()
	d.api = "1.43"
	rs := CheckGVisor(context.Background(), d, gvisorSettings(), plenty)
	if r := byName(rs)[NameDockerAPI]; r.Status != Warn || r.Fix == "" {
		t.Fatalf("docker-api %+v", r)
	}
	if (Report{Results: rs}).ExitCode() != 0 {
		t.Fatal("a warning exits 1")
	}
}

func TestADockerWithoutComposeFails(t *testing.T) {
	d := healthyDocker()
	d.composeErr = errors.New("docker: 'compose' is not a docker command.") //nolint:revive // docker's own message, verbatim
	if r := byName(CheckGVisor(context.Background(), d, gvisorSettings(), plenty))[NameCompose]; r.Status != Fail || !strings.Contains(r.Fix, "plugin") {
		t.Fatalf("compose %+v", r)
	}
}

func claimLimits(backend string) *ClaimLimits {
	return &ClaimLimits{
		Backend: backend, CgroupRoot: "/sys/fs/cgroup/kodus.slice/cell", RootSlice: "kodusabc.slice", WantSlice: "kodusabc.slice",
		ValidateEndpoint: unixOnly, ValidateDaemon: strictDaemon,
		Stat: func(string) (os.FileInfo, error) { return fakeDir{}, nil },
	}
}

type fakeDir struct{ os.FileInfo }

func (fakeDir) IsDir() bool { return true }

// Claim limits with the systemd backend on a Docker that uses cgroupfs and
// a runsc without --systemd-cgroup or --oci-seccomp: the cell refuses to start
// (configureClaimLimitsWith); preflight names all three, each with its fix.
func TestClaimLimitsNameEachDaemonFactTheDriverRefuses(t *testing.T) {
	d := healthyDocker()
	d.info = dockercli.CgroupDaemonInfo{Version: "2", Driver: "cgroupfs", Runtimes: map[string]dockercli.RuntimeInfo{"runsc": {Path: "/usr/bin/runsc"}}}
	g := gvisorSettings()
	g.ClaimLimits = claimLimits("systemd")
	rs := CheckGVisor(context.Background(), d, g, plenty)
	var reasons []string
	for _, r := range rs {
		if r.Name == NameClaimLimitsCg {
			if r.Status != Fail || r.Fix == "" {
				t.Errorf("%+v", r)
			}
			reasons = append(reasons, r.Reason+" / "+r.Fix)
		}
	}
	joined := strings.Join(reasons, "\n")
	if len(reasons) != 3 || !strings.Contains(joined, "native.cgroupdriver=systemd") || !strings.Contains(joined, "--systemd-cgroup") || !strings.Contains(joined, "--oci-seccomp") {
		t.Fatalf("claim limit findings:\n%s", joined)
	}
}

func TestClaimLimitsOnCgroupV1FailWithTheKernelFlag(t *testing.T) {
	d := healthyDocker()
	d.info = dockercli.CgroupDaemonInfo{Version: "1", Driver: "cgroupfs"}
	g := gvisorSettings()
	g.ClaimLimits = claimLimits("cgroupfs")
	rs := CheckGVisor(context.Background(), d, g, plenty)
	if got := statuses(rs, NameClaimLimitsCg); len(got) != 1 || got[0] != Fail {
		t.Fatalf("cgroup statuses %v in %+v", got, rs)
	}
	if r := byName(rs)[NameClaimLimitsCg]; !strings.Contains(r.Fix, "systemd.unified_cgroup_hierarchy=1") {
		t.Fatalf("cgroup %+v", r)
	}
}

// A refusal of the driver's rule that none of the named findings explains
// still fails, with the driver's own words: preflight never passes what
// the cell refuses.
func TestARefusalNoFindingExplainsStillFailsWithTheDriversWords(t *testing.T) {
	g := gvisorSettings()
	g.ClaimLimits = claimLimits("systemd")
	g.ClaimLimits.ValidateDaemon = func(dockercli.CgroupDaemonInfo, string, string) error { return errors.New("a new rule") }
	r := byName(CheckGVisor(context.Background(), healthyDocker(), g, plenty))[NameClaimLimitsCg]
	if r.Status != Fail || r.Reason != "a new rule" {
		t.Fatalf("cgroup %+v", r)
	}
}

func TestClaimLimitsOverATCPDockerFail(t *testing.T) {
	d := healthyDocker()
	d.endpoint = "tcp://10.0.0.5:2376"
	g := gvisorSettings()
	g.ClaimLimits = claimLimits("systemd")
	if r := byName(CheckGVisor(context.Background(), d, g, plenty))[NameClaimLimitsSock]; r.Status != Fail || !strings.Contains(r.Reason, "tcp://10.0.0.5:2376") {
		t.Fatalf("socket %+v", r)
	}
}

func TestClaimLimitRootsTheCellNeverCreatesFailWhenAbsent(t *testing.T) {
	g := gvisorSettings()
	g.ClaimLimits = claimLimits("cgroupfs")
	g.ClaimLimits.Stat = func(string) (os.FileInfo, error) { return nil, fs.ErrNotExist }
	d := healthyDocker()
	d.info.Driver = "cgroupfs"
	if r := byName(CheckGVisor(context.Background(), d, g, plenty))[NameClaimLimitsRoot]; r.Status != Fail || !strings.Contains(r.Fix, "never creates") {
		t.Fatalf("root %+v", r)
	}
	g.ClaimLimits = claimLimits("systemd")
	g.ClaimLimits.RootSlice = "other.slice"
	if r := byName(CheckGVisor(context.Background(), healthyDocker(), g, plenty))[NameClaimLimitsRoot]; r.Status != Fail || !strings.Contains(r.Reason, "kodusabc.slice") {
		t.Fatalf("slice %+v", r)
	}
}

// Under -disk-min-free-gb the cell stops every claim (diskWatch): a fail.
// A -docker-data-root that is not the daemon's makes the watchdog read the
// wrong disk: a warning that names the right one.
func TestDiskUnderTheWatchdogFloorFailsAndAWrongDataRootWarns(t *testing.T) {
	d := healthyDocker()
	d.dataRoot = "/data/docker"
	low := func(p string) (uint64, error) {
		if p != "/var/lib/docker" {
			t.Errorf("free of %s", p)
		}
		return 2 << 30, nil
	}
	rs := byName(CheckGVisor(context.Background(), d, gvisorSettings(), low))
	if r := rs[NameDiskDocker]; r.Status != Fail || !strings.Contains(r.Reason, "2.0 GiB") || !strings.Contains(r.Reason, "5.0 GiB") {
		t.Fatalf("disk %+v", r)
	}
	if r := rs[NameDataRoot]; r.Status != Warn || !strings.Contains(r.Fix, "-docker-data-root /data/docker") {
		t.Fatalf("data root %+v", r)
	}
}

func TestBuildStateUnderItsFloorWarns(t *testing.T) {
	g := gvisorSettings()
	g.BuildStateDir, g.BuildStateMinFreeGB = "/var/lib/kodus-cell/compose/buildkit", 20
	free := func(p string) (uint64, error) {
		if strings.HasSuffix(p, "buildkit") {
			return 10 << 30, nil
		}
		return 100 << 30, nil
	}
	if r := byName(CheckGVisor(context.Background(), healthyDocker(), g, free))[NameDiskBuildState]; r.Status != Warn {
		t.Fatalf("build state %+v", r)
	}
}

func TestFreeBytesReadsTheNearestDirectoryThatExists(t *testing.T) {
	dir := t.TempDir()
	got, err := FreeBytes(filepath.Join(dir, "not", "yet", "made"))
	if err != nil || got == 0 {
		t.Fatalf("free %d, %v", got, err)
	}
}

func TestMemoryAdmissionFailsOnlyWhenClaimLimitsRequireIt(t *testing.T) {
	err := errors.New("memory: the host's 900 MB leave nothing past the 1024 MB reserve")
	if r := Memory(true, 0, err); r.Status != Fail {
		t.Fatalf("required %+v", r)
	}
	if r := Memory(false, 0, err); r.Status != Warn {
		t.Fatalf("optional %+v", r)
	}
	if r := Memory(false, 3072, nil); r.Status != OK || !strings.Contains(r.Reason, "3072") {
		t.Fatalf("ok %+v", r)
	}
}

// A shared cell refuses a host with SMT on (checkSharedHost); a dedicated
// one starts and reports it.
func TestAnUnsafeHostFailsASharedCellAndWarnsADedicatedOne(t *testing.T) {
	h := hostcheck.State{Policy: hostcheck.Shared, SMT: "on", KSM: "off", Swap: "off"}
	if r := HostPolicy(h); r.Status != Fail || !strings.Contains(r.Reason, "SMT") {
		t.Fatalf("shared %+v", r)
	}
	h.Policy = hostcheck.Dedicated
	if r := HostPolicy(h); r.Status != Warn {
		t.Fatalf("dedicated %+v", r)
	}
	h.SMT = "off"
	if r := HostPolicy(h); r.Status != OK {
		t.Fatalf("safe %+v", r)
	}
}

func writeIdentity(t *testing.T, cn string, ttl time.Duration) (cert, key string, notBefore, notAfter time.Time) {
	t.Helper()
	ca, err := testpki.NewCA("hub")
	if err != nil {
		t.Fatal(err)
	}
	leaf, err := ca.Issue(cn, ttl)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	if err := ca.WriteFiles(dir, "", leaf); err != nil {
		t.Fatal(err)
	}
	return filepath.Join(dir, "cert.pem"), filepath.Join(dir, "key.pem"), leaf.Leaf.NotBefore, leaf.Leaf.NotAfter
}

// The cell's 24 h certificate: valid, due for renewal (a third left), expired
// (the hub refuses it and it cannot renew over mTLS), or not yet valid (the
// host's clock is behind).
func TestTheCellCertificateIsJudgedOnThisHostsClock(t *testing.T) {
	cert, key, nb, na := writeIdentity(t, "cell-1", 24*time.Hour)
	for _, c := range []struct {
		name string
		now  time.Time
		want Status
		in   string
	}{
		{"valid", nb.Add(time.Hour), OK, "renews at"},
		{"due", na.Add(-time.Hour), Warn, "due for renewal"},
		{"expired", na.Add(time.Minute), Fail, "expired"},
		{"clock behind", nb.Add(-time.Hour), Fail, "clock is behind"},
	} {
		t.Run(c.name, func(t *testing.T) {
			leaf, rs := CheckIdentity(Identity{Cert: cert, Key: key, Now: c.now, AutoRenew: true})
			if leaf == nil {
				t.Fatalf("no leaf: %+v", rs)
			}
			r := byName(rs)[NameCertValidity]
			if r.Status != c.want || !strings.Contains(r.Reason, c.in) {
				t.Fatalf("validity %+v", r)
			}
			if c.want != OK && r.Fix == "" {
				t.Fatalf("no fix: %+v", r)
			}
		})
	}
}

func TestAMissingKeyOrAWrongCellIDFails(t *testing.T) {
	cert, key, nb, _ := writeIdentity(t, "cell-1", 24*time.Hour)
	if leaf, rs := CheckIdentity(Identity{Cert: cert, Key: key + ".gone", Now: nb}); leaf != nil || byName(rs)[NameCellCert].Status != Fail || !strings.Contains(byName(rs)[NameCellCert].Fix, "cell register") {
		t.Fatalf("missing key: %+v", rs)
	}
	resolve := func(configured, cn string) (string, error) {
		if configured != "" && configured != cn {
			return "", errors.New("-cell-id is not the CN")
		}
		return cn, nil
	}
	_, rs := CheckIdentity(Identity{Cert: cert, Key: key, Now: nb.Add(time.Minute), ConfiguredID: "cell-2", ResolveID: resolve})
	if r := byName(rs)[NameCellID]; r.Status != Fail {
		t.Fatalf("cell id %+v in %+v", r, rs)
	}
}

func TestAnUnsynchronizedClockWarnsAndAnUnreadableOneSaysNothing(t *testing.T) {
	if r, shown := Clock(func() (bool, error) { return false, nil }); !shown || r.Status != Warn {
		t.Fatalf("unsynced %+v", r)
	}
	if r, shown := Clock(func() (bool, error) { return true, nil }); !shown || r.Status != OK {
		t.Fatalf("synced %+v", r)
	}
	if _, shown := Clock(func() (bool, error) { return false, errors.New("not linux") }); shown {
		t.Fatal("an unreadable clock is reported")
	}
}

// Every line firecracker.Missing names on a host that lacks everything
// finds a fix of its own: the table cannot drift from the backend's words.
func TestEveryMicroVMPrerequisiteTheBackendNamesHasItsOwnFix(t *testing.T) {
	state := filepath.Join(t.TempDir(), "vm")
	checks := &firecracker.Checks{
		EUID:     func() int { return 1000 },
		LookPath: func(string) (string, error) { return "", errors.New("not found") },
		Stat:     func(string) (os.FileInfo, error) { return nil, fs.ErrNotExist },
		ReadFile: func(p string) ([]byte, error) {
			if strings.HasSuffix(p, "smt/active") {
				return []byte("1"), nil
			}
			return []byte("cpu io"), nil
		},
		Reflink: func(string, string) error { return errors.New("operation not supported") },
	}
	noCgroup := *checks
	noCgroup.ReadFile = func(string) ([]byte, error) { return nil, fs.ErrNotExist }
	cases := []firecracker.Config{
		{StateDir: state, Checks: checks, Host: isolation.Host{Arch: "x86_64"}, HostPolicy: firecracker.HostShared},
		{StateDir: state, Checks: &noCgroup, Host: isolation.Host{Arch: "x86_64"}},
		{StateDir: state, Checks: checks, Host: isolation.Host{Arch: "x86_64"}, KitProblem: "manifest.json is sha256:00, not the pinned sha256:11"},
		{StateDir: "", Checks: checks, Host: isolation.Host{Arch: "x86_64"}},
	}
	seen := 0
	for _, cfg := range cases {
		for _, line := range firecracker.Missing(cfg, false) {
			seen++
			if name, fix := microVMFix(line); name == "microvm" || fix == "" {
				t.Errorf("no fix of its own for %q", line)
			}
		}
	}
	if seen < 10 {
		t.Fatalf("only %d lines: the fake host lacks too little", seen)
	}
	rs := MicroVM([]string{"no usable /dev/kvm (a host with KVM: bare metal or nested virtualization)"})
	if len(rs) != 1 || rs[0].Name != "kvm" || rs[0].Status != Fail {
		t.Fatalf("kvm %+v", rs)
	}
	if rs := MicroVM(nil); len(rs) != 1 || rs[0].Status != OK {
		t.Fatalf("none missing %+v", rs)
	}
}

// One line per check with its fix, then the verdict; -json is one object
// with ok false when a check failed, and the exit code follows the fails.
func TestTheReportIsOneLinePerCheckOrOneJSONObject(t *testing.T) {
	r := Report{Driver: "docker-gvisor", Why: "-driver docker-gvisor"}
	r.Add(ok(NameDocker, "Docker 27.3.1"), warn(NameDockerAPI, "API 1.43", "upgrade"), fail(NameRunsc, "no runsc", "runsc install"))
	r.Notes = []string{"the images are pulled at the first claim"}
	var text bytes.Buffer
	if err := r.WriteText(&text); err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(text.String()), "\n")
	if len(lines) != 6 || !strings.HasPrefix(lines[3], "fail runsc") || !strings.Contains(lines[3], "fix: runsc install") || lines[5] != "preflight failed: 1 ok, 1 warn, 1 fail" {
		t.Fatalf("text:\n%s", text.String())
	}
	if r.ExitCode() != 1 {
		t.Fatal("a fail exits 0")
	}
	var js bytes.Buffer
	if err := r.WriteJSON(&js); err != nil {
		t.Fatal(err)
	}
	var got struct {
		OK     bool     `json:"ok"`
		Driver string   `json:"driver"`
		Checks []Result `json:"checks"`
	}
	if err := json.Unmarshal(js.Bytes(), &got); err != nil || got.OK || got.Driver != "docker-gvisor" || len(got.Checks) != 3 || got.Checks[2].Fix != "runsc install" {
		t.Fatalf("json %s (%v)", js.String(), err)
	}
}
