package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/claimlimits"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/awsec2"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockergvisor"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/k8ssandbox"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/microvm"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/hostcheck"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/machinetrust"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/preflight"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/tlsutil"
)

// `cell preflight` takes the cell's own flags and -config file and checks
// the host against what that cell would need (internal/preflight), without
// starting it: before an install, and from `cell update` before a swap.

// preflightTimeout bounds every Docker and runtime command of one run.
const preflightTimeout = 30 * time.Second

// preflightProbes are the host as preflight reads it.
type preflightProbes struct {
	host   hostFacts
	getenv func(string) string
	// docker is the host's Docker (preflightDocker).
	docker preflight.Docker
	free   preflight.FreeFunc
	now    func() time.Time
	// clock is preflight.KernelClockSynced.
	clock    func() (bool, error)
	memTotal func() (int, error)
	// hostState is hostcheck.Probe on "/" under the policy.
	hostState func(policy string) hostcheck.State
	// runtimeVersion runs a runtime binary's --version.
	runtimeVersion func(ctx context.Context, path string) (string, error)
	// microvm is microvm.Prerequisites.
	microvm func(microvm.Firecracker) []string
}

func hostPreflightProbes() preflightProbes {
	return preflightProbes{
		host: probeHost(), getenv: os.Getenv, docker: preflightDocker{}, free: preflight.FreeBytes, now: time.Now,
		clock: preflight.KernelClockSynced, memTotal: readMemTotalMB,
		hostState:      func(policy string) hostcheck.State { return hostcheck.Probe(nil, "/", policy) },
		runtimeVersion: runtimeVersion,
		microvm:        microvm.Prerequisites,
	}
}

// runPreflight is `cell preflight`: exit 0 when no check failed (warnings
// included), 1 when one did, 2 on a usage error of its own.
func runPreflight(args []string, stdout, stderr io.Writer, p preflightProbes) int {
	fs := flag.NewFlagSet("preflight", flag.ContinueOnError)
	fs.SetOutput(stderr)
	asJSON := fs.Bool("json", false, "write the report as one JSON object")
	st, err := parseSettings(fs, args)
	if errors.Is(err, flag.ErrHelp) {
		return 2
	}
	var r preflight.Report
	write := func() int {
		var werr error
		if *asJSON {
			werr = r.WriteJSON(stdout)
		} else {
			werr = r.WriteText(stdout)
		}
		if werr != nil {
			_, _ = fmt.Fprintln(stderr, "cell preflight:", werr)
			return 1
		}
		return r.ExitCode()
	}
	if err != nil {
		r.Add(preflight.Settings(err))
		return write()
	}
	sel, _, err := selectDriver(&st, p.host, p.getenv)
	r.Driver, r.Why = sel.Kind, sel.Why
	r.Add(preflight.Settings(err))
	if sel.Kind == "" {
		return write()
	}
	ctx, cancel := context.WithTimeout(context.Background(), preflightTimeout)
	defer cancel()
	cellID := checkCellFiles(&r, st, p)
	if c, shown := preflight.Clock(p.clock); shown {
		r.Add(c)
	}
	switch sel.Kind {
	case dockergvisor.Kind:
		checkDockerGVisorHost(ctx, &r, st, cellID, p)
	case microvm.Kind:
		checkMicroVMHost(&r, st, cellID, p)
	case k8ssandbox.Kind:
		checkK8sLocal(&r, st)
		r.Notes = append(r.Notes, "k8s-sandbox: the cluster checks (privileged pods refused, the RuntimeClass, the NetworkPolicies; with -k8s-env-namespace the environment gate refusing a privileged pod by name and admitting the driver's) run at cell start (k8ssandbox.Preflight), not here")
	case awsec2.Kind:
		_, err := readAWSConfig(st.AWSConfig)
		r.Add(preflight.Loaded("aws-config", err, st.AWSConfig, "write the aws-ec2 settings (VPC, subnets, groups, launch template, org keys) to -aws-config"))
		r.Notes = append(r.Notes, "aws-ec2: the AWS credentials and the account's resources are read at cell start, not here")
	default:
		r.Notes = append(r.Notes, sel.Kind+": a development driver; no host checks")
	}
	return write()
}

// Names of the k8s-sandbox checks cell preflight runs on its own files and
// flags (the -k8s-env-* consistency is the settings check: checkK8sEnv).
const (
	nameK8sImages      = "k8s-images"
	nameK8sObserverTLS = "k8s-env-observer-tls"
)

// checkK8sLocal checks what a k8s-sandbox cell needs that is readable
// without the API server: every image by digest, and with environment
// Runs on, the observer TLS files and -observer-server-name against them.
func checkK8sLocal(r *preflight.Report, st settings) {
	k, e := st.K8s, st.K8s.Env
	var bad []string
	for flag, v := range map[string]string{
		"-k8s-holder-image": k.HolderImage, "-k8s-sandbox-image": k.SandboxImage, "-k8s-probe-image": k.ProbeImage,
		"-k8s-env-builder-image": e.BuilderImage, "-k8s-env-observer-image": e.ObserverImage,
	} {
		if v != "" && !imageRef.MatchString(v) {
			bad = append(bad, flag+" "+v)
		}
	}
	var err error
	if len(bad) > 0 {
		slices.Sort(bad)
		err = fmt.Errorf("not by digest (repository@sha256:<64 hex>): %s", strings.Join(bad, ", "))
	}
	r.Add(preflight.Loaded(nameK8sImages, err, "every image is by digest", "reference each image as repository@sha256:<digest>, as the chart does"))
	if e.on() {
		r.Add(preflight.Loaded(nameK8sObserverTLS, k8sEnvFiles(e.ObserverTLSDir, st.ObsServerName), e.ObserverTLSDir,
			"write cert.pem and key.pem (a certificate for -observer-server-name) and ca.pem (the CA of -observer-cert) to -k8s-env-observer-tls-dir"))
	}
}

// checkCellFiles checks what run() loads before any driver: the identity
// (enrollment.LoadCertHolder, resolveCellID), the trust roots (loadRoots),
// the machine trust (trustSettings.write), the policy key (tlsutil.PrivateKey
// with -egress-control) and the observer client TLS (observerClient with
// -observer http). It returns the cell id, the certificate's CN ("" when the
// certificate did not load).
func checkCellFiles(r *preflight.Report, st settings, p preflightProbes) string {
	leaf, rs := preflight.CheckIdentity(preflight.Identity{
		Cert: st.Cert, Key: st.Key, ConfiguredID: st.CellID, ResolveID: resolveCellID, AutoRenew: st.AutoRenew, Now: p.now(),
	})
	r.Add(rs...)
	_, err := loadRoots(rootFiles{Hub: st.CA, Local: st.LocalCA, CellCA: st.Trust.CellCA, Issuer: st.Issuer, Observer: observerCAFile(st)}, st.EgressEPs != "", st.Dev)
	r.Add(preflight.Loaded(preflight.NameTrustRoots, err, "hub CA "+st.CA,
		"copy the hub CA to -ca (cell register writes it there), and give the enforcers a cell-local CA of their own (-local-ca)"))
	if st.Trust.CellCA != "" {
		r.Add(preflight.Loaded("machine-trust", readMachineTrust(st.Trust), "-cell-ca-cert "+st.Trust.CellCA,
			"point -cell-ca-cert at the injector's CA certificate, and -machine-roots at a PEM bundle (or leave it empty for the system store)"))
	}
	if st.EgressEPs != "" {
		_, err := tlsutil.PrivateKey(st.PolicyKey)
		r.Add(preflight.Loaded(preflight.NamePolicyKey, err, st.PolicyKey, "write the ed25519 key that signs egress policies to -policy-key"))
	}
	if st.ObsMode == observerHTTP {
		_, err := tlsutil.Client(st.ObsCert, st.ObsKey, st.ObsCA)
		r.Add(preflight.Loaded(preflight.NameObserverTLS, err, st.ObsCert, "write the observer client certificate, key and CA to -observer-cert, -observer-key and -observer-ca"))
	}
	if leaf == nil {
		return ""
	}
	return leaf.Subject.CommonName
}

// readMachineTrust reads what trustSettings.write would bundle, writing
// nothing.
func readMachineTrust(t trustSettings) error {
	if _, err := os.ReadFile(t.CellCA); err != nil {
		return fmt.Errorf("-cell-ca-cert: %w", err)
	}
	files := machinetrust.SystemRootFiles
	if t.Roots != "" {
		files = []string{t.Roots}
	}
	_, _, err := machinetrust.ReadRoots(files)
	return err
}

func readAWSConfig(path string) (awsConfig, error) {
	var ac awsConfig
	b, err := os.ReadFile(path) //nolint:gosec // G304: the operator's -aws-config
	if err != nil {
		return ac, err
	}
	return ac, json.Unmarshal(b, &ac)
}

// checkDockerGVisorHost is what wireDockerGVisor and dockergvisor.New need of
// the host: the host policy (checkSharedHost), Docker and runsc, claim
// limits (configureClaimLimits), the disks and the memory admission
// (observeDriver).
func checkDockerGVisorHost(ctx context.Context, r *preflight.Report, st settings, cellID string, p preflightProbes) {
	if policy, err := hostPolicyFor(st.HostPolicy, dockergvisor.Kind); err == nil {
		r.Add(preflight.HostPolicy(p.hostState(policy)))
	}
	g := preflight.GVisor{
		Runtime: "runsc", RuntimeVersion: p.runtimeVersion,
		DockerDataRoot: st.DockerDataRoot, DiskMinFreeGB: st.DiskMinFreeGB,
	}
	if st.GVisorBuildState {
		// dockergvisor.New: the state's root is <work dir>/buildkit, the
		// driver's work dir <-workdir>/compose (wireDockerGVisor).
		g.BuildStateDir, g.BuildStateMinFreeGB = filepath.Join(st.WorkDir, "compose", "buildkit"), st.GVisorBuildStateMinFreeGB
	}
	required := st.GVisorClaimLimits == "required"
	if required {
		c := &preflight.ClaimLimits{
			Backend: st.GVisorClaimLimitBackend, CgroupRoot: st.GVisorClaimCgroupRoot, RootSlice: st.GVisorClaimRootSlice,
			ValidateEndpoint: dockergvisor.ValidateClaimLimitEndpoint, ValidateDaemon: dockergvisor.ValidateClaimLimitDaemon,
		}
		if cellID != "" {
			c.WantSlice = claimlimits.RootSliceName(cellID)
		}
		g.ClaimLimits = c
	}
	r.Add(preflight.CheckGVisor(ctx, p.docker, g, p.free)...)
	if st.MemoryAdmission {
		mb, err := allocatableMemoryMB(st.MemoryAllocatableMB, st.MemoryReserveMB, p.memTotal)
		r.Add(preflight.Memory(required, mb, err))
	}
	r.Notes = append(r.Notes, "docker-gvisor: the images (-gvisor-holder-image and the others) are pulled when first used, and -gvisor-egress-container is joined per claim; neither is checked here")
}

// checkMicroVMHost is what wireMicroVM and microvm.Open need of the host:
// the host policy (shared by default), every prerequisite Open refuses
// with (microvm.Prerequisites), the state disk and the memory admission.
func checkMicroVMHost(r *preflight.Report, st settings, cellID string, p preflightProbes) {
	policy, err := hostPolicyFor(st.HostPolicy, microvm.Kind)
	if err != nil {
		return
	}
	r.Add(preflight.HostPolicy(p.hostState(policy)))
	f, err := microvmConfig(st, cellID, machinetrust.Files{}, nil)
	if err != nil {
		r.Add(preflight.Settings(err))
		return
	}
	// The host policy is its own result above; Open refuses the same
	// findings for a shared cell.
	f.HostPolicy = hostcheck.Dedicated
	r.Add(preflight.MicroVM(p.microvm(f))...)
	// firecracker diskRoom: an environment with no measured need yet boots
	// with a -firecracker-data-gb data disk, refused without room for it.
	r.Add(preflight.FreeDisk(preflight.NameDiskMicroVM, f.StateDir, uint64(max(st.MicroVM.DataGB, 0))<<30, preflight.Warn, //nolint:gosec // G115: clamped at zero
		"an environment's first machine needs a -firecracker-data-gb data disk and is refused without room for it",
		"give the state disk more room, or lower -firecracker-data-gb", p.free))
	if st.MemoryAdmission {
		mb, err := allocatableMemoryMB(st.MemoryAllocatableMB, st.MemoryReserveMB, p.memTotal)
		r.Add(preflight.Memory(false, mb, err))
	}
}

// preflightDocker is the host's Docker for preflight: dockercli's reads and
// the two versions it does not ask.
type preflightDocker struct{ dockercli.CLI }

func (d preflightDocker) ServerVersion(ctx context.Context) (string, error) {
	out, err := dockercli.ExecCommand(ctx, nil, "docker", "version", "--format", "{{.Server.Version}}")
	return strings.TrimSpace(string(out)), err
}

// ComposeVersion runs compose as the cell does (dockercli's minimal
// environment, so a plugin only under the operator's ~/.docker is not
// found, as the cell would not find it).
func (d preflightDocker) ComposeVersion(ctx context.Context) (string, error) {
	out, err := dockercli.ExecCommand(ctx, nil, "docker", "compose", "version")
	return strings.TrimPrefix(strings.TrimSpace(string(out)), "Docker Compose version "), err
}

// runtimeVersion is the first line of `<path> --version` (runsc's names its
// release).
func runtimeVersion(ctx context.Context, path string) (string, error) {
	out, err := dockercli.ExecCommand(ctx, nil, path, "--version")
	line, _, _ := strings.Cut(strings.TrimSpace(string(out)), "\n")
	return line, err
}
