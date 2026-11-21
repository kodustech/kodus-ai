package preflight

import (
	"context"
	"crypto/x509"
	"fmt"
	"os"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/enrollment"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/hostcheck"
)

// Check names: stable, docs and scripts grep them.
const (
	NameSettings        = "settings"
	NameDocker          = "docker"
	NameDockerAPI       = "docker-api"
	NameCompose         = "docker-compose"
	NameRunsc           = "runsc"
	NameClaimLimitsSock = "claim-limits-socket"
	NameClaimLimitsCg   = "claim-limits-cgroup"
	NameClaimLimitsRoot = "claim-limits-root"
	NameDataRoot        = "docker-data-root"
	NameDiskDocker      = "disk-docker"
	NameDiskBuildState  = "disk-build-state"
	NameDiskMicroVM     = "disk-microvm"
	NameMemory          = "memory-admission"
	NameHostPolicy      = "host-policy"
	NameCellCert        = "cell-cert"
	NameCellID          = "cell-id"
	NameCertValidity    = "cell-cert-validity"
	NameTrustRoots      = "trust-roots"
	NamePolicyKey       = "policy-key"
	NameObserverTLS     = "observer-tls"
	NameClock           = "clock"
)

// Settings is whether the cell accepts its flags and config file
// (cmd/cell parseSettings and selectDriver): a refusal there is exit 2
// before the cell touches anything.
func Settings(err error) Result {
	if err != nil {
		return fail(NameSettings, err.Error(), "fix the flag or the -config file key it names")
	}
	return ok(NameSettings, "the cell accepts its flags and config file")
}

// Docker is what the checks ask the host's Docker (dockercli.CLI, plus the
// two version commands the composition root adds).
type Docker interface {
	// ServerVersion is the engine's version ("27.3.1").
	ServerVersion(ctx context.Context) (string, error)
	// APIVersion is the daemon's API version ("1.47").
	APIVersion(ctx context.Context) (string, error)
	// Runtimes are the OCI runtimes the daemon knows, by name.
	Runtimes(ctx context.Context) ([]string, error)
	CgroupInfo(ctx context.Context) (dockercli.CgroupDaemonInfo, error)
	DaemonEndpoint(ctx context.Context) (string, error)
	// DataRoot is the daemon's DockerRootDir.
	DataRoot(ctx context.Context) (string, error)
	// ComposeVersion is `docker compose version`'s version.
	ComposeVersion(ctx context.Context) (string, error)
}

// FreeFunc is the bytes an unprivileged writer may still write under a
// path (FreeBytes).
type FreeFunc func(path string) (uint64, error)

// GVisor is what the docker-gvisor checks read of the settings.
type GVisor struct {
	// Runtime is the OCI runtime name the driver runs machines with ("runsc").
	Runtime string
	// RuntimeVersion runs the runtime's binary with --version (nil: not
	// reported). No runtime code depends on the version; it is reported.
	RuntimeVersion func(ctx context.Context, path string) (string, error)
	// ClaimLimits are -gvisor-claim-limits required's; nil when off.
	ClaimLimits *ClaimLimits
	// DockerDataRoot and DiskMinFreeGB are -docker-data-root and
	// -disk-min-free-gb (the disk watchdog).
	DockerDataRoot string
	DiskMinFreeGB  int
	// BuildStateDir and BuildStateMinFreeGB: -gvisor-build-state's root and
	// floor; BuildStateDir empty when the build state is off.
	BuildStateDir       string
	BuildStateMinFreeGB int
}

// ClaimLimits is -gvisor-claim-limits required's settings and the driver's
// own rules, which the composition root passes in.
type ClaimLimits struct {
	// Backend is -gvisor-claim-limit-backend (cgroupfs or systemd).
	Backend string
	// CgroupRoot is -gvisor-claim-cgroup-root (cgroupfs); RootSlice
	// -gvisor-claim-root-slice and WantSlice the one the cell's id names
	// (claimlimits.RootSliceName; empty when the id is unknown) for systemd.
	CgroupRoot, RootSlice, WantSlice string
	// ValidateEndpoint and ValidateDaemon are the driver's
	// (dockergvisor.ValidateClaimLimitEndpoint, ValidateClaimLimitDaemon).
	ValidateEndpoint func(endpoint string) error
	ValidateDaemon   func(info dockercli.CgroupDaemonInfo, backend, runtime string) error
	// Stat is os.Stat when nil.
	Stat func(string) (os.FileInfo, error)
}

// CheckGVisor runs the docker-gvisor host checks. When Docker does not
// answer, only that is reported: every other check asks it.
func CheckGVisor(ctx context.Context, d Docker, g GVisor, free FreeFunc) []Result {
	if g.Runtime == "" {
		g.Runtime = "runsc"
	}
	var out []Result
	// dockergvisor.New asks the daemon its runtimes (gvisor.New) and its API
	// version (healthStartInterval) before anything else: no daemon, no cell.
	ver, err := d.ServerVersion(ctx)
	if err != nil {
		return append(out, fail(NameDocker, "the Docker daemon does not answer: "+oneLine(err.Error()),
			"install Docker Engine, start it (systemctl enable --now docker) and run the cell as a user that may use its socket"))
	}
	endpoint, _ := d.DaemonEndpoint(ctx)
	reason := "Docker " + ver
	if endpoint != "" {
		reason += " at " + endpoint
	}
	out = append(out, ok(NameDocker, reason), checkAPI(ctx, d), checkCompose(ctx, d))
	info, infoErr := d.CgroupInfo(ctx)
	out = append(out, checkRunsc(ctx, d, g, info, infoErr))
	if g.ClaimLimits != nil {
		out = append(out, checkClaimLimits(*g.ClaimLimits, g.Runtime, endpoint, info, infoErr)...)
	}
	out = append(out, checkDataRoot(ctx, d, g.DockerDataRoot))
	// cmd/cell diskWatch (agent.DiskWatch): under -disk-min-free-gb free in
	// -docker-data-root the cell stops every claim, a booting one failing as
	// resources/cell_disk_full.
	if g.DiskMinFreeGB > 0 && g.DockerDataRoot != "" {
		out = append(out, FreeDisk(NameDiskDocker, g.DockerDataRoot, uint64(g.DiskMinFreeGB)<<30, Fail,
			"the cell stops every claim under -disk-min-free-gb",
			"free space in Docker's data root (docker system prune), give it a larger disk, or lower -disk-min-free-gb", free))
	}
	// dockergvisor buildstate (Config.MinFree): under the floor the
	// environment states cheapest to keep are removed, then the exported
	// caches, so builds start cold.
	if g.BuildStateDir != "" && g.BuildStateMinFreeGB > 0 {
		out = append(out, FreeDisk(NameDiskBuildState, g.BuildStateDir, uint64(g.BuildStateMinFreeGB)<<30, Warn,
			"under -gvisor-build-state-min-free-gb the cell drops build states and caches, and builds run cold",
			"give the work directory more disk, or lower -gvisor-build-state-min-free-gb", free))
	}
	return out
}

// checkAPI: dockergvisor healthStartInterval turns the fast healthcheck
// (start_interval, API 1.44, Docker 25) off on an older daemon, so every
// service boot waits on its compose file's own interval.
func checkAPI(ctx context.Context, d Docker) Result {
	v, err := d.APIVersion(ctx)
	if err != nil {
		return warn(NameDockerAPI, "the daemon's API version is unreadable: "+oneLine(err.Error()), "check `docker version`")
	}
	if !apiAtLeast(v, 1, 44) {
		return warn(NameDockerAPI, "API "+v+" is older than 1.44: services boot without the fast healthcheck (start_interval)", "upgrade Docker Engine to 25 or later")
	}
	return ok(NameDockerAPI, "API "+v)
}

// checkCompose: every environment boots, resets and stops through `docker
// compose` (internal/composecmd, dockercli ComposeUp).
func checkCompose(ctx context.Context, d Docker) Result {
	v, err := d.ComposeVersion(ctx)
	if err != nil {
		return fail(NameCompose, "`docker compose` does not run: "+oneLine(err.Error()), "install the Docker Compose v2 plugin system-wide (docker-compose-plugin, under /usr/libexec/docker/cli-plugins): the cell runs docker with its own HOME")
	}
	return ok(NameCompose, "Compose "+v)
}

// checkRunsc: gvisor.New refuses a daemon without the runtime
// (ErrNoRuntime), and every holder, build and service runs under it.
func checkRunsc(ctx context.Context, d Docker, g GVisor, info dockercli.CgroupDaemonInfo, infoErr error) Result {
	fix := "install gVisor's runsc and register it with Docker as \"" + g.Runtime + "\" (`sudo runsc install` writes /etc/docker/daemon.json), then `sudo systemctl restart docker`"
	names, err := d.Runtimes(ctx)
	if err != nil {
		return fail(NameRunsc, "the daemon's runtimes are unreadable: "+oneLine(err.Error()), fix)
	}
	if !slices.Contains(names, g.Runtime) {
		return fail(NameRunsc, fmt.Sprintf("Docker has no runtime named %s (it has %s)", g.Runtime, strings.Join(names, ", ")), fix)
	}
	reason := "runtime " + g.Runtime + " registered"
	if rt, found := info.Runtimes[g.Runtime]; infoErr == nil && found && rt.Path != "" {
		reason += " at " + rt.Path
		if g.RuntimeVersion != nil {
			if v, err := g.RuntimeVersion(ctx, rt.Path); err == nil && v != "" {
				reason += " (" + v + ")"
			}
		}
	}
	return ok(NameRunsc, reason)
}

// checkClaimLimits: cmd/cell configureClaimLimitsWith and dockergvisor.New
// refuse to start, with -gvisor-claim-limits required, unless Docker is
// rootful on a local Unix socket, on cgroup v2, with the cgroup driver the
// backend names (and runsc in systemd-cgroup mode for systemd), and the
// operator's root exists (claimlimits.New, NewSystemd).
func checkClaimLimits(c ClaimLimits, runtime, endpoint string, info dockercli.CgroupDaemonInfo, infoErr error) []Result {
	var out []Result
	switch err := c.ValidateEndpoint(endpoint); {
	case endpoint == "":
		out = append(out, fail(NameClaimLimitsSock, "the Docker endpoint is unreadable", "use the default context on unix:///var/run/docker.sock"))
	case err != nil:
		out = append(out, fail(NameClaimLimitsSock, "claim limits need a local Unix Docker socket, and the cell talks to "+endpoint,
			"unset DOCKER_HOST and DOCKER_CONTEXT, or point them at unix:///var/run/docker.sock"))
	default:
		out = append(out, ok(NameClaimLimitsSock, endpoint))
	}
	if infoErr != nil {
		out = append(out, fail(NameClaimLimitsCg, "the daemon's cgroup facts are unreadable: "+oneLine(infoErr.Error()), "check `docker info`"))
	} else if err := c.ValidateDaemon(info, c.Backend, runtime); err != nil {
		out = append(out, claimLimitFindings(c, runtime, info, err)...)
	} else {
		out = append(out, ok(NameClaimLimitsCg, fmt.Sprintf("rootful Docker on cgroup v%s with the %s driver", info.Version, info.Driver)))
	}
	out = append(out, checkClaimRoot(c))
	return out
}

// claimLimitFindings names what ValidateClaimLimitDaemon refused, one
// result each; its own error when none of them is it (a rule this package
// does not spell out yet).
func claimLimitFindings(c ClaimLimits, runtime string, info dockercli.CgroupDaemonInfo, refused error) []Result {
	var out []Result
	if info.Version != "2" {
		out = append(out, fail(NameClaimLimitsCg, "Docker reports cgroup v"+info.Version+", claim limits need v2 (unified)",
			"boot the host with the unified hierarchy (systemd.unified_cgroup_hierarchy=1 on the kernel command line) and restart Docker"))
	}
	if info.Rootless {
		out = append(out, fail(NameClaimLimitsCg, "Docker runs rootless", "run rootful Docker for the cell"))
	}
	if info.Driver != c.Backend {
		out = append(out, fail(NameClaimLimitsCg, fmt.Sprintf("Docker's cgroup driver is %s and -gvisor-claim-limit-backend is %s", info.Driver, c.Backend),
			fmt.Sprintf("set \"exec-opts\": [\"native.cgroupdriver=%s\"] in /etc/docker/daemon.json and restart Docker, or change -gvisor-claim-limit-backend", c.Backend)))
	}
	if c.Backend == "systemd" && !systemdCgroup(info.Runtimes[runtime]) {
		out = append(out, fail(NameClaimLimitsCg, runtime+" does not run with --systemd-cgroup",
			"add \"runtimeArgs\": [\"--systemd-cgroup\"] to the "+runtime+" runtime in /etc/docker/daemon.json and restart Docker"))
	}
	if rt, ok := info.Runtimes[runtime]; ok && !ociSeccomp(rt) {
		out = append(out, fail(NameClaimLimitsCg, runtime+" does not apply the container's seccomp profile (--oci-seccomp)",
			"add \"--oci-seccomp\" to the "+runtime+" runtime's \"runtimeArgs\" in /etc/docker/daemon.json and reload Docker (kill -HUP dockerd)"))
	}
	if len(out) == 0 {
		out = append(out, fail(NameClaimLimitsCg, refused.Error(), "see docs/runtime/self-hosted.md, \"Host preflight\""))
	}
	return out
}

// ociSeccomp mirrors dockergvisor.OCISeccomp (preflight does not import the driver).
func ociSeccomp(rt dockercli.RuntimeInfo) bool {
	on := false
	for _, a := range rt.RuntimeArgs {
		switch {
		case a == "--oci-seccomp" || a == "--oci-seccomp=true":
			on = true
		case strings.HasPrefix(a, "--oci-seccomp="):
			return false
		}
	}
	return on
}

func systemdCgroup(rt dockercli.RuntimeInfo) bool {
	on := false
	for _, a := range rt.RuntimeArgs {
		switch {
		case a == "--systemd-cgroup" || a == "--systemd-cgroup=true":
			on = true
		case strings.HasPrefix(a, "--systemd-cgroup="):
			return false
		}
	}
	return on
}

// checkClaimRoot: the cell never creates or delegates its root
// (claimlimits.New opens -gvisor-claim-cgroup-root; NewSystemd wants the
// slice its id names, already active). Whether a systemd slice is active is
// read over D-Bus at start, not here.
func checkClaimRoot(c ClaimLimits) Result {
	if c.Backend == "systemd" {
		if c.WantSlice != "" && c.RootSlice != c.WantSlice {
			return fail(NameClaimLimitsRoot, fmt.Sprintf("-gvisor-claim-root-slice %s is not the slice this cell's id names (%s)", c.RootSlice, c.WantSlice),
				"create and start "+c.WantSlice+" with the description \"Kodus Runtime claim root <cell id>\", and pass it as -gvisor-claim-root-slice")
		}
		return ok(NameClaimLimitsRoot, "root slice "+c.RootSlice+" (its active state is checked at start)")
	}
	stat := c.Stat
	if stat == nil {
		stat = os.Stat
	}
	fi, err := stat(c.CgroupRoot)
	if err != nil || !fi.IsDir() {
		return fail(NameClaimLimitsRoot, "the delegated cgroup root "+c.CgroupRoot+" does not exist",
			"create it under /sys/fs/cgroup, enable cpu, memory and pids in its parent's cgroup.subtree_control and give it to the cell's user; the cell never creates it")
	}
	return ok(NameClaimLimitsRoot, c.CgroupRoot)
}

// checkDataRoot: the disk watchdog (cmd/cell diskWatch) reads
// -docker-data-root, not the daemon's: a different one watches a disk
// Docker does not write.
func checkDataRoot(ctx context.Context, d Docker, configured string) Result {
	root, err := d.DataRoot(ctx)
	if err != nil {
		return warn(NameDataRoot, "the daemon's data root is unreadable: "+oneLine(err.Error()), "check `docker info --format '{{.DockerRootDir}}'`")
	}
	if configured != "" && root != configured {
		return warn(NameDataRoot, fmt.Sprintf("Docker writes to %s and -docker-data-root is %s: the disk watchdog reads the wrong disk", root, configured),
			"set -docker-data-root "+root)
	}
	return ok(NameDataRoot, root)
}

// FreeDisk is a free-space check: below need, status (Fail or Warn) with why.
func FreeDisk(name, path string, need uint64, below Status, why, fix string, free FreeFunc) Result {
	got, err := free(path)
	if err != nil {
		return Result{Name: name, Status: below, Reason: "free space under " + path + " is unreadable: " + oneLine(err.Error()), Fix: "create " + path + " on the disk the cell will use"}
	}
	if got < need {
		return Result{Name: name, Status: below, Reason: fmt.Sprintf("%s has %s free, under %s: %s", path, gib(got), gib(need), why), Fix: fix}
	}
	return ok(name, fmt.Sprintf("%s has %s free (needs %s)", path, gib(got), gib(need)))
}

func gib(b uint64) string { return strconv.FormatFloat(float64(b)/(1<<30), 'f', 1, 64) + " GiB" }

// Memory checks the admission's figure (cmd/cell observeDriver,
// allocatableMemoryMB, ADR-070): a cell that requires admission (claim
// limits) refuses to start without one; any other admits by free slots.
func Memory(required bool, mb int, err error) Result {
	switch {
	case err != nil && required:
		return fail(NameMemory, oneLine(err.Error())+": claim limits require memory admission", "set -memory-allocatable-mb, or lower -memory-reserve-mb under the host's memory")
	case err != nil:
		return warn(NameMemory, oneLine(err.Error())+": the cell admits claims by free slots, not by memory", "set -memory-allocatable-mb, or lower -memory-reserve-mb under the host's memory")
	}
	return ok(NameMemory, fmt.Sprintf("the cell may commit %d MB to claims", mb))
}

// HostPolicy reads what makes a host fit to run many orgs' sandboxes
// (hostcheck): a shared cell refuses an unsafe host (cmd/cell
// checkSharedHost for docker-gvisor, firecracker.Missing for microVMs), a
// dedicated one starts and reports it.
func HostPolicy(h hostcheck.State) Result {
	unsafe := h.Unsafe()
	if len(unsafe) == 0 {
		return ok(NameHostPolicy, fmt.Sprintf("%s: SMT %s, KSM %s, swap %s, no unmitigated CPU vulnerability", h.Policy, h.SMT, h.KSM, h.Swap))
	}
	reason := h.Policy + ": " + strings.Join(unsafe, "; ")
	if h.Policy == hostcheck.Shared {
		return fail(NameHostPolicy, reason, "fix each finding as it says, or run -host-policy dedicated when every sandbox on the cell is one org's")
	}
	return warn(NameHostPolicy, reason, "fine for one org's sandboxes; fix each finding before the cell runs -host-policy shared")
}

// Identity is the cell's client certificate as the settings name it.
type Identity struct {
	Cert, Key string
	// ResolveID is cmd/cell resolveCellID (-cell-id against the CN).
	ConfiguredID string
	ResolveID    func(configured, cn string) (string, error)
	AutoRenew    bool
	Now          time.Time
}

// CheckIdentity loads the certificate and key as the cell does at start
// (enrollment.LoadCertHolder: no pair, no cell), checks -cell-id against its
// CN, and its validity on this host's clock: the hub refuses an expired
// certificate and a cell cannot renew one over mTLS (enrollment.Renewer
// renews at enrollment.RenewAt, a third of the validity before expiry).
// It returns the leaf (nil when it did not load).
func CheckIdentity(id Identity) (*x509.Certificate, []Result) {
	holder, err := enrollment.LoadCertHolder(id.Cert, id.Key)
	if err != nil {
		return nil, []Result{fail(NameCellCert, "cannot load -cert "+id.Cert+" with -key "+id.Key+": "+oneLine(err.Error()),
			"run `cell register` with a registration token (it writes the key, certificate, hub CA and issuer), or point -cert and -key at them")}
	}
	leaf := holder.Leaf()
	out := []Result{ok(NameCellCert, fmt.Sprintf("%s (CN %s, serial %s)", id.Cert, leaf.Subject.CommonName, leaf.SerialNumber.Text(16)))}
	if id.ResolveID != nil {
		if _, err := id.ResolveID(id.ConfiguredID, leaf.Subject.CommonName); err != nil {
			out = append(out, fail(NameCellID, err.Error(), "drop -cell-id, or set it to the certificate's CN"))
		}
	}
	renewAt := enrollment.RenewAt(leaf)
	stamp := func(t time.Time) string { return t.UTC().Format(time.RFC3339) }
	switch {
	case id.Now.Before(leaf.NotBefore):
		out = append(out, fail(NameCertValidity, "the certificate is not valid until "+stamp(leaf.NotBefore)+": this host's clock is behind",
			"sync the clock (chrony or systemd-timesyncd: timedatectl set-ntp true)"))
	case !id.Now.Before(leaf.NotAfter):
		out = append(out, fail(NameCertValidity, "the certificate expired at "+stamp(leaf.NotAfter)+": the hub refuses the cell, which cannot renew it over mTLS",
			"register the cell again: `cell register` with a new registration token"))
	case !id.Now.Before(renewAt):
		fix := "run `cell renew`, or start the cell with -auto-renew"
		if id.AutoRenew {
			fix = "the cell renews it at start (-auto-renew); if it stays due, check that the hub's /cells/renew answers"
		}
		out = append(out, warn(NameCertValidity, "due for renewal since "+stamp(renewAt)+", expires "+stamp(leaf.NotAfter), fix))
	default:
		out = append(out, ok(NameCertValidity, "valid until "+stamp(leaf.NotAfter)+", renews at "+stamp(renewAt)))
	}
	return leaf, out
}

// Loaded is a file the cell loads at start, ok when err is nil: the trust
// roots (cmd/cell loadRoots), the policy key (tlsutil.PrivateKey) and the
// observer client TLS (tlsutil.Client).
func Loaded(name string, err error, okReason, fix string) Result {
	if err != nil {
		return fail(name, oneLine(err.Error()), fix)
	}
	return ok(name, okReason)
}

// Clock reads whether the kernel says its clock is synchronized. The cell's
// certificate lives 24 h and renews at a third left (enrollment.RenewAt),
// a lease's hard ceiling is a wall-clock time (driver.Ceiling) and cell
// update reads the release index's expiry against it. Nil, or unreadable:
// no result (not Linux).
func Clock(synced func() (bool, error)) (Result, bool) {
	if synced == nil {
		return Result{}, false
	}
	on, err := synced()
	if err != nil {
		return Result{}, false
	}
	if !on {
		return warn(NameClock, "the kernel reports its clock as not synchronized (adjtimex)", "enable time sync: timedatectl set-ntp true, or chrony"), true
	}
	return ok(NameClock, "the kernel clock is synchronized"), true
}

// microVMFixes are the fixes for firecracker.Missing's lines, by the start
// of each line (a test runs Missing on a host lacking everything and checks
// that each line finds its own).
var microVMFixes = []struct{ prefix, name, fix string }{
	{"no usable /dev/kvm", "kvm", "run on bare metal or a VM with nested virtualization, and let the cell's user open /dev/kvm read-write"},
	{"no microVM kit", "microvm-kit", "extract the signed kit and pass -firecracker-kit and -firecracker-kit-digest"},
	{"the microVM kit:", "microvm-kit", "extract the signed kit for this host's architecture again, and pass the digest of its manifest.json as -firecracker-kit-digest"},
	{"the kit is for", "microvm-kit", "use the kit built for this host's architecture"},
	{"the jailer needs root", "root", "run the cell as root"},
	{"cgroup v2 at", "cgroup-v2", "boot the host with the unified hierarchy (systemd.unified_cgroup_hierarchy=1)"},
	{"the memory, cpu and pids cgroup controllers", "cgroup-v2", "enable memory, cpu and pids in /sys/fs/cgroup/cgroup.subtree_control"},
	{"the ip command", "binaries", "install iproute2"},
	{"the nft command", "binaries", "install nftables"},
	{"the sysctl command", "binaries", "install procps"},
	{"/dev/net/tun", "tun", "load the tun module (modprobe tun)"},
	{"no state directory", "microvm-state-dir", "set -firecracker-state-dir or -state-dir"},
	{"the state directory", "microvm-state-dir", "put -firecracker-state-dir on XFS with reflink=1 or btrfs, with a short path, writable by root"},
	{"a shared cell's host:", NameHostPolicy, "fix the finding as it says, or run -host-policy dedicated when every sandbox on the cell is one org's"},
}

// MicroVM turns firecracker.Missing's lines (what microvm.Open refuses the
// cell with, all of them at once) into results, one each; none: ok.
func MicroVM(missing []string) []Result {
	if len(missing) == 0 {
		return []Result{ok("microvm", "KVM, the kit, root, cgroup v2, ip, nft, sysctl, /dev/net/tun and a state directory that reflinks")}
	}
	out := make([]Result, 0, len(missing))
	for _, m := range missing {
		name, fix := microVMFix(m)
		out = append(out, fail(name, m, fix))
	}
	return out
}

func microVMFix(line string) (name, fix string) {
	for _, f := range microVMFixes {
		if strings.HasPrefix(line, f.prefix) {
			return f.name, f.fix
		}
	}
	return "microvm", "see docs/runtime/self-hosted.md, \"Host preflight\""
}

// apiAtLeast compares a "major.minor" API version (as dockergvisor does).
func apiAtLeast(v string, major, minor int) bool {
	a, b, found := strings.Cut(v, ".")
	if !found {
		return false
	}
	ma, err1 := strconv.Atoi(a)
	mi, err2 := strconv.Atoi(b)
	if err1 != nil || err2 != nil {
		return false
	}
	return ma > major || (ma == major && mi >= minor)
}

// oneLine keeps a command's error on the check's line.
func oneLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexAny(s, "\r\n"); i >= 0 {
		s = s[:i]
	}
	return s
}
