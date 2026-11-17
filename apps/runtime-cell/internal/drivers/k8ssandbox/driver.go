// Package k8ssandbox is the k8s-sandbox MachineDriver (docs/runtime/
// kubernetes.md): a cell's machines are pods in one sandbox namespace the
// chart made, on an isolated RuntimeClass (gVisor or Kata), with no service
// account token, no host namespaces or paths, Pod Security restricted, and
// the chart's default-deny NetworkPolicies, which let a claim pod reach the
// cell's proxy and resolver only. The cell's Role is pods (and pods/exec)
// in that namespace; the driver never creates a namespace or a policy.
//
// It runs code sandboxes (its Parts: Sandboxes and Sweeper) and, with
// Config.Env, environment Runs from prebuilt images, one pod per compose
// service in the cell's environment namespace (env.go; Parts gains
// Composer, Recipes, Resetter and ServiceLogs). Without Config.Env every
// Run is refused with driver.ErrUnsupported (NoRuns); builds, observers,
// previews, bakes and snapshots are refused either way.
package k8ssandbox

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/kodyexec"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/machinetrust"
)

// Kind is the driver's name in -driver and in the cell's hello.
const Kind = "k8s-sandbox"

// Container names in a claim pod.
const (
	containerMain    = "main"
	containerSandbox = "sandbox"
)

// GuestUser is the sandbox image's user (uid and gid 1000), the guest
// agent's; GuestCommand starts the guest agent on the exec stream.
const GuestUser = 1000

var GuestCommand = []string{"/usr/local/bin/kody-guest", "-stdio", "-root", "/workspace"}

type Config struct {
	CellID string
	// Namespace is the cell's sandbox namespace: every pod it makes lives
	// there, and only there.
	Namespace    string
	RuntimeClass string // gvisor | kata | the cluster's own name
	// HolderImage runs a Create machine; SandboxImage a code sandbox (with
	// the guest agent). Both by digest.
	HolderImage  string
	SandboxImage string
	// EgressAddress is the cell's proxy and resolver as claim pods reach
	// them (the egress Service's address): their only DNS server, and the
	// address the resolver steers every allowed name to.
	EgressAddress string
	// MaxClaimSize is the most one claim may ask; DefaultClaimSize what a
	// claim that asks none runs at (the sandbox size).
	MaxClaimSize     driver.ClaimSize
	DefaultClaimSize driver.ClaimSize
	// Arch is what the claim pods run on (x86_64, arm64).
	Arch string
	// ReadyTimeout bounds how long a pod may take to run (image pull
	// included); Poll is how often it is asked.
	ReadyTimeout time.Duration
	Poll         time.Duration
	Now          func() time.Time
	// CellCA is the injector's cell CA certificate (machinetrust.CellCA:
	// one CA certificate, never its key). Set: a code sandbox of a claim
	// with org secrets trusts it (sandboxTrust). Empty: such a sandbox is
	// refused (Capabilities SandboxCellTrust false).
	CellCA []byte
	// Env, set, runs environment Runs (env.go); nil: code sandboxes only.
	Env *EnvConfig
}

type Driver struct {
	k    KubeAPI
	exec Execer
	cfg  Config
	envs envStates
}

// New checks the configuration only; the preflight (Preflight) is what
// proves the cluster enforces it.
func New(k KubeAPI, exec Execer, cfg Config) (*Driver, error) {
	if cfg.CellID == "" || cfg.Namespace == "" || cfg.RuntimeClass == "" || cfg.HolderImage == "" || cfg.EgressAddress == "" {
		return nil, errors.New("k8ssandbox: cell id, namespace, runtime class, holder image and egress address required")
	}
	if cfg.MaxClaimSize.IsZero() {
		cfg.MaxClaimSize = driver.ClaimSize{MemoryMB: 8192, CPUs: 4}
	}
	if cfg.DefaultClaimSize.IsZero() {
		cfg.DefaultClaimSize = driver.ClaimSize{MemoryMB: 2048, CPUs: 2}
	}
	if cfg.Arch == "" {
		cfg.Arch = "x86_64"
	}
	if cfg.ReadyTimeout == 0 {
		cfg.ReadyTimeout = 5 * time.Minute
	}
	if cfg.Poll == 0 {
		cfg.Poll = time.Second
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if len(cfg.CellCA) > 0 {
		ca, err := machinetrust.CellCA(cfg.CellCA)
		if err != nil {
			return nil, fmt.Errorf("k8ssandbox: %w", err)
		}
		cfg.CellCA = ca
	}
	if cfg.Env != nil {
		env := *cfg.Env
		if err := env.defaults(cfg); err != nil {
			return nil, err
		}
		cfg.Env = &env
	}
	return &Driver{k: k, exec: exec, cfg: cfg}, nil
}

func (d *Driver) Kind() string { return Kind }

func (d *Driver) Capabilities() driver.Capabilities {
	return driver.Capabilities{
		Isolation: driver.IsolationSandboxedContainer, NestedContainers: d.cfg.RuntimeClass == "kata",
		Arch: []string{"x86_64", "arm64"}, HostArch: d.cfg.Arch,
		MaxClaimSize: d.cfg.MaxClaimSize, DefaultClaimSize: d.cfg.DefaultClaimSize,
		SandboxCellTrust: len(d.cfg.CellCA) > 0,
	}
}

// Parts returns code sandboxes and the sweep of pods past their ceiling,
// and with Config.Env the compose boot, the recipe's steps, the reset of
// compose volumes and the services' logs.
func (d *Driver) Parts() driver.Parts {
	p := driver.Parts{Sandboxes: d, Sweeper: d}
	if d.cfg.Env != nil {
		p.Composer, p.Recipes, p.Resetter, p.ServiceLogs = d, d, envResetter{d}, d
	}
	return p
}

// Label values cannot hold ':' or timestamps; ids go in labels, times in
// annotations.
const prefix = "kodus.io/"

func label(tag string) string { return prefix + strings.TrimPrefix(tag, "kodus:") }

func (d *Driver) claimLabels(org, claim string) map[string]any {
	return map[string]any{label(driver.TagCell): d.cfg.CellID, label(driver.TagOrg): org, label(driver.TagClaim): claim}
}

// PrepareClaim creates nothing: the chart's policies already isolate every
// claim pod (no ingress, egress to the cell's proxy and resolver only). The
// claim's group is its id, the label its pods carry.
func (d *Driver) PrepareClaim(_ context.Context, spec driver.ClaimNetworkSpec) (driver.ClaimNetwork, error) {
	if err := driver.ValidateClaimID(spec.ClaimID); err != nil {
		return driver.ClaimNetwork{}, err
	}
	if len(spec.Expose) > 0 {
		return driver.ClaimNetwork{}, fmt.Errorf("%w: k8ssandbox exposes no claim port: the observer pod and previews are not wired on Kubernetes yet", driver.ErrUnsupported)
	}
	return driver.ClaimNetwork{WorkloadGroupID: spec.ClaimID, ObserverGroupID: spec.ClaimID, EgressAddress: d.cfg.EgressAddress}, nil
}

// ReleaseClaim deletes this cell's pods of the claim. The selector names
// this cell, so another cell's pods are never touched.
func (d *Driver) ReleaseClaim(ctx context.Context, n driver.ClaimNetwork) error {
	if n.WorkloadGroupID == "" {
		return nil
	}
	if err := driver.ValidateClaimID(n.WorkloadGroupID); err != nil {
		return err
	}
	pods, err := d.k.ListPods(ctx, d.cfg.Namespace, map[string]string{label(driver.TagCell): d.cfg.CellID, label(driver.TagClaim): n.WorkloadGroupID})
	if err != nil {
		return err
	}
	var errs []error
	for _, p := range pods {
		if !d.owns(p) {
			continue
		}
		if err := ignoreNotFound(d.k.DeletePod(ctx, d.cfg.Namespace, str(meta(p)["name"]))); err != nil {
			errs = append(errs, err)
		}
	}
	if err := d.cleanupEnv(ctx, n.WorkloadGroupID); err != nil {
		errs = append(errs, err)
	}
	return errors.Join(errs...)
}

func meta(o Object) map[string]any {
	md, _ := o["metadata"].(map[string]any)
	return md
}

// owns reports whether a pod carries this cell's label.
func (d *Driver) owns(o Object) bool {
	labels, _ := meta(o)["labels"].(map[string]any)
	return labels[label(driver.TagCell)] == d.cfg.CellID
}

func ignoreNotFound(err error) error {
	if errors.Is(err, ErrNotFound) {
		return nil
	}
	return err
}

func podName(spec driver.MachineSpec) string {
	return fmt.Sprintf("%s-%s", spec.Role, strings.ToLower(spec.ClaimID))
}

// size is the claim's size, else its machine size, else the default; never
// zero (requests equal limits: every pod is Guaranteed).
func (d *Driver) size(spec driver.MachineSpec) (memMB, cpus int) {
	memMB, cpus = spec.ClaimSize.MemoryMB, spec.ClaimSize.CPUs
	if memMB == 0 && spec.Size.MemoryGB > 0 {
		memMB = spec.Size.MemoryGB * 1024
	}
	if cpus == 0 {
		cpus = spec.Size.CPU
	}
	if memMB == 0 {
		memMB = d.cfg.DefaultClaimSize.MemoryMB
	}
	if cpus == 0 {
		cpus = d.cfg.DefaultClaimSize.CPUs
	}
	return memMB, cpus
}

// podShape is what differs between a machine pod and a sandbox pod.
type podShape struct {
	container string
	image     string
	// workspaceMB > 0 mounts /workspace (and a small /tmp) in memory, and
	// runs the pod read-only as the guest user.
	workspaceMB int
	// trust: the sandbox of a claim with org secrets gets the cell's trust files (sandboxTrust).
	trust bool
}

// pod is a claim pod: on the RuntimeClass, restricted (non-root, no
// capability, no escalation, RuntimeDefault seccomp), no token, no
// service links, its DNS the cell's resolver only, ended by the kubelet at
// the claim's hard ceiling whatever happens to the cell.
func (d *Driver) pod(spec driver.MachineSpec, shape podShape) (Object, error) {
	deadline := int64(spec.HardExpiresAt.Sub(d.cfg.Now()).Seconds())
	if deadline < 1 {
		return nil, errors.New("k8ssandbox: hardExpiresAt passed")
	}
	memMB, cpus := d.size(spec)
	labels := d.claimLabels(spec.OrgID, spec.ClaimID)
	labels[label(driver.TagRole)] = string(spec.Role)
	labels[label(driver.TagEnv)] = spec.EnvironmentID
	tags := spec.AllTags()
	limits := map[string]any{"cpu": strconv.Itoa(cpus), "memory": fmt.Sprintf("%dMi", memMB)}
	container := map[string]any{
		"name": shape.container, "image": shape.image, "imagePullPolicy": "IfNotPresent",
		"command": []any{"sleep", "infinity"},
		"securityContext": map[string]any{
			"allowPrivilegeEscalation": false, "privileged": false, "readOnlyRootFilesystem": shape.workspaceMB > 0,
			"runAsNonRoot": true, "capabilities": map[string]any{"drop": []any{"ALL"}},
		},
		"resources": map[string]any{"limits": limits, "requests": limits},
	}
	podSec := map[string]any{"runAsNonRoot": true, "runAsUser": GuestUser, "runAsGroup": GuestUser, "seccompProfile": map[string]any{"type": "RuntimeDefault"}}
	podSpec := map[string]any{
		"runtimeClassName":             d.cfg.RuntimeClass,
		"automountServiceAccountToken": false,
		"enableServiceLinks":           false,
		"hostNetwork":                  false, "hostPID": false, "hostIPC": false,
		"restartPolicy":                 "Never",
		"terminationGracePeriodSeconds": 5,
		"activeDeadlineSeconds":         deadline,
		"dnsPolicy":                     "None",
		"dnsConfig":                     map[string]any{"nameservers": []any{d.cfg.EgressAddress}},
		"securityContext":               podSec,
		"containers":                    []any{container},
	}
	if shape.workspaceMB > 0 {
		podSec["fsGroup"] = GuestUser
		// What the commands write lives in the sandbox's memory, counted in
		// its limit: half of it for the checkout, a little for /tmp.
		podSpec["volumes"] = []any{
			map[string]any{"name": "workspace", "emptyDir": map[string]any{"medium": "Memory", "sizeLimit": fmt.Sprintf("%dMi", shape.workspaceMB)}},
			map[string]any{"name": "tmp", "emptyDir": map[string]any{"medium": "Memory", "sizeLimit": "512Mi"}},
		}
		container["volumeMounts"] = []any{
			map[string]any{"name": "workspace", "mountPath": "/workspace"},
			map[string]any{"name": "tmp", "mountPath": "/tmp"},
		}
	}
	if shape.trust {
		d.sandboxTrust(podSpec, container, shape.image)
	}
	return Object{
		"apiVersion": "v1", "kind": "Pod",
		"metadata": map[string]any{"name": podName(spec), "namespace": d.cfg.Namespace, "labels": labels, "annotations": map[string]any{
			label(driver.TagExpires): tags[driver.TagExpires], label(driver.TagHardExpires): tags[driver.TagHardExpires], prefix + "image": spec.ImageID,
		}},
		"spec": podSpec,
	}, nil
}

func (d *Driver) check(spec driver.MachineSpec) error {
	if err := spec.ValidateFor(d.Capabilities()); err != nil {
		return err
	}
	if err := driver.ValidateClaimID(spec.ClaimID); err != nil {
		return err
	}
	if spec.CellID != d.cfg.CellID {
		return fmt.Errorf("k8ssandbox: spec is for cell %s, not %s", spec.CellID, d.cfg.CellID)
	}
	return nil
}

func (d *Driver) ref(spec driver.MachineSpec, name, address string) driver.MachineRef {
	id := d.cfg.Namespace + "/" + name
	return driver.MachineRef{MachineID: id, DriverRef: id, PrivateAddress: address, ImageID: spec.ImageID, Tags: spec.AllTags()}
}

// Create makes a machine pod of the holder image. Nothing runs a Run on it
// (NoRuns); it is the machine the conformance suite and a lease track.
func (d *Driver) Create(ctx context.Context, spec driver.MachineSpec) (driver.MachineRef, error) {
	if err := d.check(spec); err != nil {
		return driver.MachineRef{}, err
	}
	p, err := d.pod(spec, podShape{container: containerMain, image: d.cfg.HolderImage})
	if err != nil {
		return driver.MachineRef{}, err
	}
	if _, err := d.k.CreatePod(ctx, d.cfg.Namespace, p, false); err != nil {
		return driver.MachineRef{}, err
	}
	return d.ref(spec, podName(spec), ""), nil
}

// ErrNoSandboxImage means the cell runs no sandboxes (no sandbox image).
var ErrNoSandboxImage = errors.New("k8ssandbox: no sandbox image configured")

// SandboxesEnabled reports whether the driver makes sandboxes.
func (d *Driver) SandboxesEnabled() bool { return d.cfg.SandboxImage != "" }

// CreateSandbox makes the sandbox pod and waits until it runs: the claim's
// egress policy names its address, which exists only then. A pod that
// fails or does not run in ReadyTimeout is deleted. A sandbox that must
// trust the cell CA gets the trust files (sandboxTrust); without CellCA it
// is refused (Capabilities SandboxCellTrust false).
func (d *Driver) CreateSandbox(ctx context.Context, req driver.SandboxRequest) (driver.MachineRef, error) {
	spec := req.Spec
	if !d.SandboxesEnabled() {
		return driver.MachineRef{}, ErrNoSandboxImage
	}
	if req.CellTrust && len(d.cfg.CellCA) == 0 {
		return driver.MachineRef{}, fmt.Errorf("%w: this k8s-sandbox cell has no cell CA (-cell-ca-cert) for its pods to trust", driver.ErrUnsupported)
	}
	if spec.Role != driver.RolePool {
		spec.Role = driver.RoleWorkload // a blank pool sandbox keeps its role until a claim takes it
	}
	spec.ImageID, spec.ImageRef = "sandbox", d.cfg.SandboxImage
	if err := d.check(spec); err != nil {
		return driver.MachineRef{}, err
	}
	memMB, _ := d.size(spec)
	p, err := d.pod(spec, podShape{container: containerSandbox, image: d.cfg.SandboxImage, workspaceMB: max(memMB/2, 1), trust: req.CellTrust})
	if err != nil {
		return driver.MachineRef{}, err
	}
	name := podName(spec)
	if _, err := d.k.CreatePod(ctx, d.cfg.Namespace, p, false); err != nil {
		return driver.MachineRef{}, err
	}
	ip, err := d.waitRunning(ctx, name)
	if err != nil {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
		defer cancel()
		return driver.MachineRef{}, errors.Join(err, ignoreNotFound(d.k.DeletePod(cleanup, d.cfg.Namespace, name)))
	}
	return d.ref(spec, name, ip), nil
}

// waitRunning polls the pod until it runs with an address, and names why
// when it cannot (Failed, a waiting reason such as ErrImagePull).
func (d *Driver) waitRunning(ctx context.Context, name string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, d.cfg.ReadyTimeout)
	defer cancel()
	last := "Pending"
	for {
		p, err := d.k.GetPod(ctx, d.cfg.Namespace, name)
		if err != nil && ctx.Err() == nil {
			return "", err
		}
		st := podStatus(p)
		switch {
		case st.phase == "Running" && st.ip != "":
			return st.ip, nil
		case st.phase == "Failed" || st.phase == "Succeeded":
			return "", fmt.Errorf("k8ssandbox: pod %s ended (%s): %s", name, st.phase, st.why)
		case st.why != "":
			last = st.why
		}
		select {
		case <-ctx.Done():
			return "", fmt.Errorf("k8ssandbox: pod %s did not run in %s: %s", name, d.cfg.ReadyTimeout, last)
		case <-time.After(d.cfg.Poll):
		}
	}
}

type status struct{ phase, ip, why string }

func podStatus(p Object) status {
	st, _ := p["status"].(map[string]any)
	s := status{phase: str(st["phase"]), ip: str(st["podIP"])}
	if m := str(st["message"]); m != "" {
		s.why = str(st["reason"]) + ": " + m
	}
	cs, _ := st["containerStatuses"].([]any)
	for _, c := range cs {
		cm, _ := c.(map[string]any)
		state, _ := cm["state"].(map[string]any)
		if w, ok := state["waiting"].(map[string]any); ok && str(w["reason"]) != "" && str(w["reason"]) != "ContainerCreating" {
			s.why = strings.TrimSpace(str(w["reason"]) + " " + str(w["message"]))
		}
	}
	return s
}

func str(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

func split(ref driver.MachineRef) (string, string) {
	ns, name, _ := strings.Cut(ref.DriverRef, "/")
	return ns, name
}

// ownPod reads the pod named by ref in this cell's namespace and checks it
// is this cell's; nil without error when it is gone.
func (d *Driver) ownPod(ctx context.Context, ref driver.MachineRef) (Object, string, error) {
	ns, name := split(ref)
	if ns != d.cfg.Namespace || name == "" {
		return nil, name, fmt.Errorf("%w: %s is not in namespace %s", driver.ErrNotOwned, ref.DriverRef, d.cfg.Namespace)
	}
	p, err := d.k.GetPod(ctx, ns, name)
	if errors.Is(err, ErrNotFound) {
		return nil, name, nil
	}
	if err != nil {
		return nil, name, err
	}
	if !d.owns(p) {
		return nil, name, fmt.Errorf("%w: pod %s/%s", driver.ErrNotOwned, ns, name)
	}
	return p, name, nil
}

// DialGuest starts the guest agent in this cell's sandbox pod, on an exec
// stream (pods/exec over WebSocket).
func (d *Driver) DialGuest(ctx context.Context, ref driver.MachineRef) (io.ReadWriteCloser, error) {
	if d.exec == nil {
		return nil, errors.New("k8ssandbox: no exec client")
	}
	p, name, err := d.ownPod(ctx, ref)
	if err != nil {
		return nil, err
	}
	if p == nil {
		return nil, fmt.Errorf("k8ssandbox: sandbox %s is gone", ref.MachineID)
	}
	return d.exec.Exec(ctx, d.cfg.Namespace, name, containerSandbox, GuestCommand)
}

// Destroy deletes the pod only when it carries this cell's label, and the
// claim's objects in the environment namespace with it.
func (d *Driver) Destroy(ctx context.Context, ref driver.MachineRef) error {
	p, name, err := d.ownPod(ctx, ref)
	if err != nil || p == nil {
		return err
	}
	labels, _ := meta(p)["labels"].(map[string]any)
	err = ignoreNotFound(d.k.DeletePod(ctx, d.cfg.Namespace, name))
	if role := str(labels[label(driver.TagRole)]); role == string(driver.RoleWorkload) {
		err = errors.Join(err, d.cleanupEnv(ctx, str(labels[label(driver.TagClaim)])))
	}
	d.envs.forget(ref.MachineID)
	return err
}

// List asks the cluster for this cell's pods only: a selector naming
// another cell finds nothing.
func (d *Driver) List(ctx context.Context, selector map[string]string) ([]driver.MachineRef, error) {
	if cell, ok := selector[driver.TagCell]; ok && cell != d.cfg.CellID {
		return nil, nil
	}
	ls := map[string]string{}
	for k, v := range selector {
		if k == driver.TagExpires || k == driver.TagHardExpires {
			continue
		}
		ls[label(k)] = v
	}
	ls[label(driver.TagCell)] = d.cfg.CellID
	pods, err := d.k.ListPods(ctx, d.cfg.Namespace, ls)
	if err != nil {
		return nil, err
	}
	var out []driver.MachineRef
	for _, p := range pods {
		if !d.owns(p) {
			continue
		}
		md := meta(p)
		tags := map[string]string{}
		for _, src := range []string{"labels", "annotations"} {
			m, _ := md[src].(map[string]any)
			for k, v := range m {
				if strings.HasPrefix(k, prefix) {
					tags["kodus:"+strings.TrimPrefix(k, prefix)] = fmt.Sprint(v)
				}
			}
		}
		if !driver.Matches(tags, selector) {
			continue
		}
		ref := fmt.Sprintf("%v/%v", md["namespace"], md["name"])
		out = append(out, driver.MachineRef{MachineID: ref, DriverRef: ref, PrivateAddress: podStatus(p).ip, ImageID: tags["kodus:image"], Tags: tags})
	}
	return out, nil
}

// SetExpiry patches only the kodus.io/expires annotation of this cell's
// pod, held under the ceiling the pod carries (not the one the caller's ref
// says).
func (d *Driver) SetExpiry(ctx context.Context, ref driver.MachineRef, at time.Time) error {
	p, name, err := d.ownPod(ctx, ref)
	if err != nil {
		return err
	}
	if p == nil {
		return fmt.Errorf("k8ssandbox: pod %s is gone: %w", ref.DriverRef, ErrNotFound)
	}
	annotations, _ := meta(p)["annotations"].(map[string]any)
	ceiling := map[string]string{}
	if v, ok := annotations[label(driver.TagHardExpires)].(string); ok {
		ceiling[driver.TagHardExpires] = v
	}
	at, err = driver.ClampToCeiling(at, ceiling)
	if err != nil {
		return fmt.Errorf("k8ssandbox: pod %s: %w", ref.DriverRef, err)
	}
	return d.k.PatchPodAnnotations(ctx, d.cfg.Namespace, name, map[string]string{label(driver.TagExpires): driver.FormatTime(at)})
}

// Sweep deletes this cell's pods past their hard ceiling, or with none that
// parses (driver.Expired): a cell that crashed before it released them. The
// kubelet's activeDeadlineSeconds has stopped a dated one already; this
// removes what is left.
func (d *Driver) Sweep(ctx context.Context, now time.Time) ([]string, error) {
	refs, err := d.List(ctx, map[string]string{driver.TagCell: d.cfg.CellID})
	if err != nil {
		return nil, err
	}
	var gone []string
	var errs []error
	for _, r := range refs {
		if !driver.Expired(r.Tags, now) {
			continue
		}
		if err := d.Destroy(ctx, r); err != nil {
			errs = append(errs, err)
			continue
		}
		gone = append(gone, r.MachineID)
	}
	orphans, err := d.ReapOrphans(ctx)
	return append(gone, orphans...), errors.Join(append(errs, err)...)
}

// NewForReaper is a driver that can only list and destroy this cell's pods
// in its namespace: the reaper's (its Role has pods get, list, delete).
func NewForReaper(k KubeAPI, cellID, namespace string) *Driver {
	return &Driver{k: k, cfg: Config{CellID: cellID, Namespace: namespace, Now: time.Now}}
}

// NoRuns is the transport of a k8s-sandbox cell: environment Runs (compose
// boot, upload, exec in a service) are not wired on Kubernetes.
type NoRuns struct{}

var errNoRuns = fmt.Errorf("%w: environment Runs on Kubernetes are not wired yet (k8s-sandbox runs code sandboxes)", driver.ErrUnsupported)

func (NoRuns) Exec(context.Context, driver.MachineRef, kodyexec.Request) (kodyexec.Result, error) {
	return kodyexec.Result{}, errNoRuns
}

func (NoRuns) Upload(context.Context, driver.MachineRef, string, string, func(string)) error {
	return errNoRuns
}

var (
	_ driver.MachineDriver = (*Driver)(nil)
	_ driver.Sandboxer     = (*Driver)(nil)
)

// The init container's script: the cell CA from the pod spec, then the
// bundle, the tool image's own roots followed by the cell CA, as
// machinetrust.Build makes it on a host. Nothing else is written.
const trustScript = `set -eu
umask 022
printf '%s' "$KODUS_CELL_CA" > /trust/cell-ca.pem
cat /etc/ssl/certs/ca-certificates.crt /trust/cell-ca.pem > /trust/ca-bundle.pem`

// sandboxTrust gives a sandbox pod the cell's trust (machinetrust): an
// unprivileged init container of the same tool image writes cell-ca.pem and
// ca-bundle.pem into a memory volume, and the sandbox mounts them read-only
// at machinetrust's paths, the bundle over the system store too; the guest
// agent points the variables at them. The certificate travels in the pod
// spec (public, a few KiB), so no ConfigMap and no RBAC beyond pods.
func (d *Driver) sandboxTrust(podSpec, container map[string]any, image string) {
	podSpec["volumes"] = append(asList(podSpec["volumes"]), map[string]any{"name": "trust", "emptyDir": map[string]any{"medium": "Memory", "sizeLimit": "4Mi"}})
	small := map[string]any{"cpu": "100m", "memory": "64Mi"}
	podSpec["initContainers"] = []any{map[string]any{
		"name": "trust", "image": image, "imagePullPolicy": "IfNotPresent",
		"command": []any{"sh", "-c", trustScript},
		"env":     []any{map[string]any{"name": "KODUS_CELL_CA", "value": string(d.cfg.CellCA)}},
		"securityContext": map[string]any{
			"allowPrivilegeEscalation": false, "privileged": false, "readOnlyRootFilesystem": true,
			"runAsNonRoot": true, "capabilities": map[string]any{"drop": []any{"ALL"}},
		},
		"resources":    map[string]any{"limits": small, "requests": small},
		"volumeMounts": []any{map[string]any{"name": "trust", "mountPath": "/trust"}},
	}}
	container["volumeMounts"] = append(asList(container["volumeMounts"]),
		map[string]any{"name": "trust", "mountPath": machinetrust.CellCATarget, "subPath": "cell-ca.pem", "readOnly": true},
		map[string]any{"name": "trust", "mountPath": machinetrust.BundleTarget, "subPath": "ca-bundle.pem", "readOnly": true},
		map[string]any{"name": "trust", "mountPath": machinetrust.SystemStoreTarget, "subPath": "ca-bundle.pem", "readOnly": true},
	)
}

func asList(v any) []any {
	l, _ := v.([]any)
	return l
}
