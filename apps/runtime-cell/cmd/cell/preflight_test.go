package main

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/microvm"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/hostcheck"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/preflight"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/testpki"
)

// preflightDockerFake is the host's Docker for cell preflight.
type preflightDockerFake struct{ runtimes []string }

func (f preflightDockerFake) ServerVersion(context.Context) (string, error) { return "27.3.1", nil }
func (f preflightDockerFake) APIVersion(context.Context) (string, error)    { return "1.47", nil }
func (f preflightDockerFake) Runtimes(context.Context) ([]string, error)    { return f.runtimes, nil }
func (f preflightDockerFake) CgroupInfo(context.Context) (dockercli.CgroupDaemonInfo, error) {
	return dockercli.CgroupDaemonInfo{Version: "2", Driver: "cgroupfs", Runtimes: map[string]dockercli.RuntimeInfo{"runsc": {Path: "/usr/local/bin/runsc"}}}, nil
}
func (f preflightDockerFake) DaemonEndpoint(context.Context) (string, error) {
	return "unix:///var/run/docker.sock", nil
}
func (f preflightDockerFake) DataRoot(context.Context) (string, error)       { return "/var/lib/docker", nil }
func (f preflightDockerFake) ComposeVersion(context.Context) (string, error) { return "2.29.7", nil }

// cellFiles writes a cell's identity and hub CA as cell register leaves them.
func cellFiles(t *testing.T) (dir string) {
	t.Helper()
	dir = t.TempDir()
	ca, err := testpki.NewCA("hub")
	if err != nil {
		t.Fatal(err)
	}
	leaf, err := ca.Issue("cell-1", 24*time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if err := ca.WriteFiles(dir, "", leaf); err != nil {
		t.Fatal(err)
	}
	obs, err := ca.Issue("cell-1-observer-client", 24*time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if err := ca.WriteFiles(dir, "obs-", obs); err != nil {
		t.Fatal(err)
	}
	return dir
}

// testProbes is a safe, quiet host: Docker with runsc, plenty of disk and
// memory, a synchronized clock, nothing the shared policy refuses.
func testProbes(t *testing.T) preflightProbes {
	return preflightProbes{
		host:     testHost(isolation.GVisor),
		getenv:   func(string) string { return "" },
		docker:   preflightDockerFake{runtimes: []string{"runc", "runsc"}},
		free:     func(string) (uint64, error) { return 200 << 30, nil },
		now:      time.Now,
		clock:    func() (bool, error) { return true, nil },
		memTotal: func() (int, error) { return 16384, nil },
		hostState: func(policy string) hostcheck.State {
			return hostcheck.State{Policy: policy, SMT: "off", KSM: "off", Swap: "off"}
		},
		microvm: func(microvm.Firecracker) []string {
			t.Error("the microVM prerequisites were read for another driver")
			return nil
		},
	}
}

func gvisorArgs(dir string) []string {
	return []string{
		"-driver", "docker-gvisor", "-gvisor-holder-image", "holder@sha256:1111111111111111111111111111111111111111111111111111111111111111",
		"-cert", filepath.Join(dir, "cert.pem"), "-key", filepath.Join(dir, "key.pem"), "-ca", filepath.Join(dir, "ca.pem"),
		"-workdir", filepath.Join(dir, "work"),
		"-observer", "http", "-gvisor-observer-image", "observer@sha256:2222222222222222222222222222222222222222222222222222222222222222",
		"-observer-cert", filepath.Join(dir, "obs-cert.pem"), "-observer-key", filepath.Join(dir, "obs-key.pem"), "-observer-ca", filepath.Join(dir, "ca.pem"),
	}
}

type preflightOut struct {
	OK     bool               `json:"ok"`
	Driver string             `json:"driver"`
	Checks []preflight.Result `json:"checks"`
	Notes  []string           `json:"notes"`
}

func runPreflightJSON(t *testing.T, p preflightProbes, args ...string) (int, preflightOut) {
	t.Helper()
	var out, errOut bytes.Buffer
	code := runPreflight(append(args, "-json"), &out, &errOut, p)
	var got preflightOut
	if err := json.Unmarshal(out.Bytes(), &got); err != nil {
		t.Fatalf("json %q (stderr %q): %v", out.String(), errOut.String(), err)
	}
	return code, got
}

func check(got preflightOut, name string) (preflight.Result, bool) {
	for _, r := range got.Checks {
		if r.Name == name {
			return r, true
		}
	}
	return preflight.Result{}, false
}

// A docker-gvisor host the cell starts on passes: exit 0, every check ok.
func TestPreflightPassesAHostTheDockerGVisorCellStartsOn(t *testing.T) {
	dir := cellFiles(t)
	code, got := runPreflightJSON(t, testProbes(t), gvisorArgs(dir)...)
	if code != 0 || !got.OK || got.Driver != "docker-gvisor" {
		t.Fatalf("exit %d, %+v", code, got)
	}
	for _, name := range []string{preflight.NameSettings, preflight.NameCellCert, preflight.NameCertValidity, preflight.NameTrustRoots, preflight.NameObserverTLS, preflight.NameClock, preflight.NameHostPolicy, preflight.NameDocker, preflight.NameRunsc, preflight.NameDiskDocker, preflight.NameMemory} {
		r, ok := check(got, name)
		if !ok || r.Status != preflight.OK {
			t.Errorf("%s: %+v (found %v)", name, r, ok)
		}
	}
}

// A Docker without runsc is what the cell refuses at start: preflight
// fails it and exits 1.
func TestPreflightFailsADockerWithoutRunscAndExitsOne(t *testing.T) {
	dir := cellFiles(t)
	p := testProbes(t)
	p.docker = preflightDockerFake{runtimes: []string{"runc"}}
	code, got := runPreflightJSON(t, p, gvisorArgs(dir)...)
	if r, _ := check(got, preflight.NameRunsc); code != 1 || got.OK || r.Status != preflight.Fail {
		t.Fatalf("exit %d, runsc %+v", code, r)
	}
}

// A setting the cell refuses (docker-gvisor without its holder image) is a
// failed check, not a usage error: the host checks still run.
func TestASettingTheCellRefusesFailsAndTheHostIsStillChecked(t *testing.T) {
	dir := cellFiles(t)
	args := gvisorArgs(dir)
	args = append(args[:2:2], args[4:]...) // no -gvisor-holder-image
	code, got := runPreflightJSON(t, testProbes(t), args...)
	r, _ := check(got, preflight.NameSettings)
	if code != 1 || r.Status != preflight.Fail || !strings.Contains(r.Reason, "-gvisor-holder-image") {
		t.Fatalf("exit %d, settings %+v", code, r)
	}
	if _, ok := check(got, preflight.NameRunsc); !ok {
		t.Fatalf("the host was not checked: %+v", got.Checks)
	}
}

// The config file the units run the cell with is the one preflight reads.
func TestPreflightReadsTheCellsConfigFile(t *testing.T) {
	dir := cellFiles(t)
	cfg := filepath.Join(dir, "cell.yaml")
	body := "driver: docker-gvisor\ngvisor-holder-image: holder@sha256:x\ncert: " + filepath.Join(dir, "cert.pem") + "\nkey: " + filepath.Join(dir, "key.pem") + "\nca: " + filepath.Join(dir, "ca.pem") + "\nworkdir: " + filepath.Join(dir, "work") + "\ndisk-min-free-gb: 500\nobserver: http\ngvisor-observer-image: observer@sha256:y\nobserver-cert: " + filepath.Join(dir, "obs-cert.pem") + "\nobserver-key: " + filepath.Join(dir, "obs-key.pem") + "\nobserver-ca: " + filepath.Join(dir, "ca.pem") + "\n"
	if err := os.WriteFile(cfg, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	code, got := runPreflightJSON(t, testProbes(t), "-config", cfg)
	if r, _ := check(got, preflight.NameDiskDocker); code != 1 || r.Status != preflight.Fail || !strings.Contains(r.Reason, "500.0 GiB") {
		t.Fatalf("exit %d, disk %+v", code, r)
	}
}

// Claim limits required: Docker's cgroup facts and the delegated root are
// checked with the driver's own rule.
func TestPreflightChecksClaimLimitsWithTheDriversRule(t *testing.T) {
	dir := cellFiles(t)
	args := append(gvisorArgs(dir), "-gvisor-claim-limits", "required", "-gvisor-claim-limit-backend", "systemd", "-gvisor-claim-root-slice", "other.slice")
	code, got := runPreflightJSON(t, testProbes(t), args...)
	cg, _ := check(got, preflight.NameClaimLimitsCg)
	root, _ := check(got, preflight.NameClaimLimitsRoot)
	if code != 1 || cg.Status != preflight.Fail || root.Status != preflight.Fail || !strings.HasPrefix(root.Reason, "-gvisor-claim-root-slice other.slice is not") {
		t.Fatalf("exit %d, cgroup %+v, root %+v", code, cg, root)
	}
}

// -isolation-backend firecracker is the microvm driver: preflight reports
// what microvm.Open would refuse (its own Prerequisites), on the
// settings the cell would open it with.
func TestPreflightOfAMicroVMCellReportsWhatOpenWouldRefuse(t *testing.T) {
	dir := cellFiles(t)
	p := testProbes(t)
	var asked microvm.Firecracker
	p.microvm = func(f microvm.Firecracker) []string {
		asked = f
		return []string{"no usable /dev/kvm (a host with KVM: bare metal or nested virtualization)", "the jailer needs root (chroot, device nodes, cgroups, taps)"}
	}
	p.docker = nil // a microVM cell never asks Docker
	args := []string{"-driver", "docker-gvisor", "-isolation-backend", "firecracker", "-firecracker-kit", "/opt/kit", "-firecracker-kit-digest", "sha256:" + strings.Repeat("a", 64),
		"-cert", filepath.Join(dir, "cert.pem"), "-key", filepath.Join(dir, "key.pem"), "-ca", filepath.Join(dir, "ca.pem"), "-workdir", filepath.Join(dir, "work")}
	code, got := runPreflightJSON(t, p, args...)
	kvm, _ := check(got, "kvm")
	root, _ := check(got, "root")
	if code != 1 || got.Driver != "microvm" || kvm.Status != preflight.Fail || root.Status != preflight.Fail || kvm.Fix == "" {
		t.Fatalf("exit %d, %+v", code, got)
	}
	if asked.KitDir != "/opt/kit" || asked.StateDir != filepath.Join(dir, "work", "state", "microvm") || asked.HostPolicy != hostcheck.Dedicated {
		t.Fatalf("checked with %+v", asked)
	}
	if r, _ := check(got, preflight.NameHostPolicy); r.Status != preflight.OK || !strings.HasPrefix(r.Reason, hostcheck.Shared) {
		t.Fatalf("a microVM cell is shared by default: %+v", r)
	}
}

func TestPreflightTextIsOneLinePerCheck(t *testing.T) {
	dir := cellFiles(t)
	p := testProbes(t)
	p.clock = func() (bool, error) { return false, nil }
	var out, errOut bytes.Buffer
	code := runPreflight(gvisorArgs(dir), &out, &errOut, p)
	text := out.String()
	if code != 0 || !strings.Contains(text, "\nwarn clock") || !strings.HasSuffix(text, "fail\n") || !strings.Contains(text, "preflight passed:") {
		t.Fatalf("exit %d:\n%s\nstderr %s", code, text, errOut.String())
	}
}

func TestPreflightHelpIsAUsageExit(t *testing.T) {
	var out, errOut bytes.Buffer
	if code := runPreflight([]string{"-h"}, &out, &errOut, testProbes(t)); code != 2 {
		t.Fatalf("exit %d", code)
	}
}

// The shared-bake flags are checked as the cell would at start: a store URL
// remotecache refuses (plain HTTP off loopback), a pull mirror without the
// store it mirrors, an auth file with no store to send it to. A valid pair
// passes.
func TestPreflightChecksTheBakeShareFlags(t *testing.T) {
	dir := cellFiles(t)
	for name, c := range map[string]struct {
		flags []string
		fails string
	}{
		"plain HTTP off loopback": {[]string{"-gvisor-bake-share", "http://registry.example.com/kodus-bake"}, "-gvisor-bake-share"},
		"a mirror alone":          {[]string{"-gvisor-bake-share-pull", "https://mirror.example.com/kodus-bake"}, "-gvisor-bake-share-pull"},
		"an auth file alone":      {[]string{"-gvisor-bake-share-auth-file", "/etc/kodus/bake-share"}, "-gvisor-bake-share-auth-file"},
		"a bad mirror":            {[]string{"-gvisor-bake-share", "https://registry.example.com/kodus-bake", "-gvisor-bake-share-pull", "http://mirror.example.com/kodus-bake"}, "-gvisor-bake-share-pull"},
		"store and mirror":        {[]string{"-gvisor-bake-share", "https://registry.example.com/kodus-bake", "-gvisor-bake-share-pull", "https://mirror.eu.example.com/kodus-bake"}, ""},
	} {
		t.Run(name, func(t *testing.T) {
			_, got := runPreflightJSON(t, testProbes(t), append(gvisorArgs(dir), c.flags...)...)
			r, _ := check(got, preflight.NameSettings)
			if c.fails == "" {
				if r.Status == preflight.Fail {
					t.Fatalf("settings %+v", r)
				}
				return
			}
			if r.Status != preflight.Fail || !strings.Contains(r.Reason, c.fails) {
				t.Fatalf("settings %+v", r)
			}
		})
	}
}
