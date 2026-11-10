// Package k8ssandbox is the skeleton of the k8s-sandbox MachineDriver (docs
// §4b, second driver): a namespace per claim, default-deny NetworkPolicy,
// pods on an isolated RuntimeClass (gVisor or Kata), no service account
// token, no host namespaces or paths. It is written against KubeAPI, the
// few calls it needs over unstructured manifests, so tests run on a mock and
// nothing here needs client-go or a cluster.
package k8ssandbox

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
)

// Object is an unstructured manifest (apiVersion, kind, metadata, spec).
type Object = map[string]any

type KubeAPI interface {
	Apply(ctx context.Context, obj Object) error
	Get(ctx context.Context, apiVersion, kind, namespace, name string) (Object, error)
	Delete(ctx context.Context, apiVersion, kind, namespace, name string) error
	List(ctx context.Context, apiVersion, kind string, labels map[string]string) ([]Object, error)
}

var ErrNotFound = errors.New("k8ssandbox: not found")

type Config struct {
	CellID          string
	CellNamespace   string // where the agent runs
	EgressNamespace string // proxy and resolver
	RuntimeClass    string // gvisor | kata
	HolderImage     string // by digest
	ObserverImage   string // by digest, signed
	ObserverPort    int
	ResolverIP      string // the cell resolver: the pods' only DNS
	// AdmissionPolicy is the ValidatingAdmissionPolicy the chart installs.
	AdmissionPolicy string
	// NetworkPolicyCRDs are the CustomResourceDefinitions that show a CNI
	// enforcing NetworkPolicy is installed (one is enough). Empty: the
	// known enforcing CNIs (Cilium, Calico, Antrea, the EKS network policy
	// agent).
	NetworkPolicyCRDs []string
	Now               func() time.Time
}

type Driver struct {
	k   KubeAPI
	cfg Config
}

var (
	ErrNoRuntimeClass = errors.New("k8ssandbox: the isolated RuntimeClass is missing")
	ErrNoAdmission    = errors.New("k8ssandbox: the admission policy is missing")
	// ErrNoNetworkPolicyEnforcement: on a CNI that ignores NetworkPolicy
	// (kindnet, flannel) every policy this driver writes is decorative.
	ErrNoNetworkPolicyEnforcement = errors.New("k8ssandbox: no CNI that enforces NetworkPolicy was found")
)

// enforcingCNIs are CRDs each NetworkPolicy-enforcing CNI installs.
var enforcingCNIs = []string{
	"ciliumnetworkpolicies.cilium.io",
	"networkpolicies.crd.projectcalico.org",
	"clusternetworkpolicies.crd.antrea.io",
	"policyendpoints.networking.k8s.aws",
}

// New refuses to run without the RuntimeClass and the admission policy
// (S-10: "a célula não sobe sem ela").
func New(ctx context.Context, k KubeAPI, cfg Config) (*Driver, error) {
	if cfg.CellID == "" || cfg.RuntimeClass == "" || cfg.HolderImage == "" || cfg.ObserverImage == "" || cfg.ResolverIP == "" {
		return nil, errors.New("k8ssandbox: cell id, runtime class, images and resolver required")
	}
	if cfg.ObserverPort == 0 {
		cfg.ObserverPort = 7443
	}
	if cfg.AdmissionPolicy == "" {
		cfg.AdmissionPolicy = "kodus-runtime-cell-sandbox"
	}
	if _, err := k.Get(ctx, "node.k8s.io/v1", "RuntimeClass", "", cfg.RuntimeClass); err != nil {
		return nil, ErrNoRuntimeClass
	}
	if _, err := k.Get(ctx, "admissionregistration.k8s.io/v1", "ValidatingAdmissionPolicy", "", cfg.AdmissionPolicy); err != nil {
		return nil, ErrNoAdmission
	}
	crds := cfg.NetworkPolicyCRDs
	if len(crds) == 0 {
		crds = enforcingCNIs
	}
	enforced := false
	for _, crd := range crds {
		if _, err := k.Get(ctx, "apiextensions.k8s.io/v1", "CustomResourceDefinition", "", crd); err == nil {
			enforced = true
			break
		}
	}
	if !enforced {
		return nil, ErrNoNetworkPolicyEnforcement
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	return &Driver{k: k, cfg: cfg}, nil
}

func (d *Driver) Kind() string { return "k8s-sandbox" }

func (d *Driver) Capabilities() driver.Capabilities {
	return driver.Capabilities{Isolation: driver.IsolationSandboxedContainer, NestedContainers: d.cfg.RuntimeClass == "kata", Suspend: "none", Arch: []string{"x86_64", "arm64"}}
}

func (d *Driver) Bake(context.Context, driver.BakeSpec) (driver.ImageRef, error) {
	return driver.ImageRef{}, fmt.Errorf("%w: k8ssandbox bakes no image yet", driver.ErrUnsupported)
}

// Label values cannot hold ':' or timestamps; ids go in labels, times in
// annotations.
const prefix = "kodus.io/"

func label(tag string) string { return prefix + strings.TrimPrefix(tag, "kodus:") }

func namespaceOf(claimID string) string { return "kodus-" + strings.ToLower(claimID) }

func (d *Driver) claimLabels(org, claim string) map[string]any {
	return map[string]any{label(driver.TagCell): d.cfg.CellID, label(driver.TagOrg): org, label(driver.TagClaim): claim}
}

func port(p int) map[string]any { return map[string]any{"protocol": "TCP", "port": p} }

// egressPorts are the only ports a claim's pods reach in the egress
// namespace: the proxy's and the resolver's, not their control ports or
// the injector's listener.
func egressPorts() []any {
	return []any{port(80), port(443), map[string]any{"protocol": "UDP", "port": 53}, port(53)}
}

func selectorRole(role string) map[string]any {
	return map[string]any{"matchLabels": map[string]any{label(driver.TagRole): role}}
}

func nsSelector(name string) map[string]any {
	return map[string]any{"namespaceSelector": map[string]any{"matchLabels": map[string]any{"kubernetes.io/metadata.name": name}}}
}

// PrepareClaim: the claim's namespace and its policies. Default deny both
// ways; the workload accepts the expose ports only from the observer and
// exec from the cell agent's namespace; both reach only the egress
// namespace (proxy and resolver).
func (d *Driver) PrepareClaim(ctx context.Context, spec driver.ClaimNetworkSpec) (driver.ClaimNetwork, error) {
	if err := driver.ValidateClaimID(spec.ClaimID); err != nil {
		return driver.ClaimNetwork{}, err
	}
	ns := namespaceOf(spec.ClaimID)
	labels := d.claimLabels(spec.OrgID, spec.ClaimID)
	// baseline is enforced (the workload may need root inside gVisor);
	// restricted is warned and audited, so every gap shows.
	labels["pod-security.kubernetes.io/enforce"] = "baseline"
	labels["pod-security.kubernetes.io/warn"] = "restricted"
	labels["pod-security.kubernetes.io/audit"] = "restricted"
	objs := []Object{
		{"apiVersion": "v1", "kind": "Namespace", "metadata": map[string]any{"name": ns, "labels": labels}},
		{"apiVersion": "networking.k8s.io/v1", "kind": "NetworkPolicy", "metadata": map[string]any{"name": "default-deny", "namespace": ns},
			"spec": map[string]any{"podSelector": map[string]any{}, "policyTypes": []any{"Ingress", "Egress"}}},
	}
	var exposePorts []any
	for _, e := range spec.Expose {
		if e.Port < 1 || e.Port > 65535 {
			return driver.ClaimNetwork{}, fmt.Errorf("k8ssandbox: bad expose port %d", e.Port)
		}
		exposePorts = append(exposePorts, port(e.Port))
	}
	egress := []any{map[string]any{"to": []any{nsSelector(d.cfg.EgressNamespace)}, "ports": egressPorts()}}
	// An empty ports list in a NetworkPolicy means every port: with no
	// expose, the observer gets no rule to the workload at all.
	workloadIngress := []any{map[string]any{"from": []any{nsSelector(d.cfg.CellNamespace)}}}
	observerEgress := egress
	if len(exposePorts) > 0 {
		workloadIngress = append([]any{map[string]any{"from": []any{map[string]any{"podSelector": selectorRole("observer")}}, "ports": exposePorts}}, workloadIngress...)
		observerEgress = append([]any{map[string]any{"to": []any{map[string]any{"podSelector": selectorRole("workload")}}, "ports": exposePorts}}, egress...)
	}
	objs = append(objs,
		Object{"apiVersion": "networking.k8s.io/v1", "kind": "NetworkPolicy", "metadata": map[string]any{"name": "workload", "namespace": ns},
			"spec": map[string]any{
				"podSelector": selectorRole("workload"),
				"policyTypes": []any{"Ingress", "Egress"},
				"ingress":     workloadIngress,
				"egress":      egress,
			}},
		Object{"apiVersion": "networking.k8s.io/v1", "kind": "NetworkPolicy", "metadata": map[string]any{"name": "observer", "namespace": ns},
			"spec": map[string]any{
				"podSelector": selectorRole("observer"),
				"policyTypes": []any{"Ingress", "Egress"},
				"ingress":     []any{map[string]any{"from": []any{nsSelector(d.cfg.CellNamespace)}, "ports": []any{port(d.cfg.ObserverPort)}}},
				"egress":      observerEgress,
			}},
	)
	for _, o := range objs {
		if err := d.k.Apply(ctx, o); err != nil {
			return driver.ClaimNetwork{}, err
		}
	}
	return driver.ClaimNetwork{WorkloadGroupID: ns, ObserverGroupID: ns}, nil
}

// ReleaseClaim deletes the claim's namespace, and with it everything in it,
// only when it carries this cell's label: a namespace is the widest thing
// the driver deletes.
func (d *Driver) ReleaseClaim(ctx context.Context, n driver.ClaimNetwork) error {
	if n.WorkloadGroupID == "" {
		return nil
	}
	ns, err := d.k.Get(ctx, "v1", "Namespace", "", n.WorkloadGroupID)
	if errors.Is(err, ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if !d.owns(ns) {
		return fmt.Errorf("%w: namespace %s", driver.ErrNotOwned, n.WorkloadGroupID)
	}
	return ignoreNotFound(d.k.Delete(ctx, "v1", "Namespace", "", n.WorkloadGroupID))
}

// owns reports whether a cluster object carries this cell's label.
func (d *Driver) owns(o Object) bool {
	md, _ := o["metadata"].(map[string]any)
	labels, _ := md["labels"].(map[string]any)
	return labels[label(driver.TagCell)] == d.cfg.CellID
}

func ignoreNotFound(err error) error {
	if errors.Is(err, ErrNotFound) {
		return nil
	}
	return err
}

func (d *Driver) Create(ctx context.Context, spec driver.MachineSpec) (driver.MachineRef, error) {
	if err := spec.ValidateFor(d.Capabilities()); err != nil {
		return driver.MachineRef{}, err
	}
	if err := driver.ValidateClaimID(spec.ClaimID); err != nil {
		return driver.MachineRef{}, err
	}
	ns := namespaceOf(spec.ClaimID)
	name := fmt.Sprintf("%s-%s", spec.Role, strings.ToLower(spec.ClaimID))
	image := d.cfg.HolderImage
	if spec.Role == driver.RoleObserver {
		image = d.cfg.ObserverImage
	}
	labels := d.claimLabels(spec.OrgID, spec.ClaimID)
	labels[label(driver.TagRole)] = string(spec.Role)
	labels[label(driver.TagEnv)] = spec.EnvironmentID
	tags := spec.AllTags()
	// The ceiling is enforced by the kubelet too: activeDeadlineSeconds.
	deadline := int64(spec.HardExpiresAt.Sub(d.cfg.Now()).Seconds())
	if deadline < 1 {
		return driver.MachineRef{}, errors.New("k8ssandbox: hardExpiresAt passed")
	}
	pod := Object{
		"apiVersion": "v1", "kind": "Pod",
		"metadata": map[string]any{"name": name, "namespace": ns, "labels": labels, "annotations": map[string]any{
			label(driver.TagExpires): tags[driver.TagExpires], label(driver.TagHardExpires): tags[driver.TagHardExpires], prefix + "image": spec.ImageID,
		}},
		"spec": map[string]any{
			"runtimeClassName":             d.cfg.RuntimeClass,
			"automountServiceAccountToken": false,
			"enableServiceLinks":           false,
			"hostNetwork":                  false, "hostPID": false, "hostIPC": false,
			"restartPolicy":         "Never",
			"activeDeadlineSeconds": deadline,
			"dnsPolicy":             "None",
			"dnsConfig":             map[string]any{"nameservers": []any{d.cfg.ResolverIP}},
			"securityContext":       map[string]any{"seccompProfile": map[string]any{"type": "RuntimeDefault"}},
			"containers": []any{map[string]any{
				"name": "main", "image": image,
				"securityContext": map[string]any{"allowPrivilegeEscalation": false, "privileged": false, "capabilities": map[string]any{"drop": []any{"ALL"}}},
				"resources": map[string]any{"limits": map[string]any{
					"cpu": fmt.Sprint(max(spec.Size.CPU, 1)), "memory": fmt.Sprintf("%dGi", max(spec.Size.MemoryGB, 1)), "ephemeral-storage": fmt.Sprintf("%dGi", max(spec.Size.DiskGB, 1)),
				}},
			}},
		},
	}
	if err := d.k.Apply(ctx, pod); err != nil {
		return driver.MachineRef{}, err
	}
	return driver.MachineRef{MachineID: ns + "/" + name, DriverRef: ns + "/" + name, ImageID: spec.ImageID, Tags: tags}, nil
}

func split(ref driver.MachineRef) (string, string) {
	ns, name, _ := strings.Cut(ref.DriverRef, "/")
	return ns, name
}

// errNoSuspend: a pod is not suspended; it stops and a pool hands out a
// fresh one.
var errNoSuspend = fmt.Errorf("%w: k8ssandbox pods stop and come back from the warm pool", driver.ErrUnsupported)

func (d *Driver) Suspend(context.Context, driver.MachineRef, driver.SuspendMode) error {
	return errNoSuspend
}

func (d *Driver) Resume(context.Context, driver.MachineRef) error { return errNoSuspend }

func (d *Driver) Reset(context.Context, driver.MachineRef, driver.SnapshotRef) error {
	return fmt.Errorf("%w: k8ssandbox has no reset yet", driver.ErrUnsupported)
}

// Destroy deletes the pod only when it carries this cell's label.
func (d *Driver) Destroy(ctx context.Context, ref driver.MachineRef) error {
	ns, name := split(ref)
	pod, err := d.k.Get(ctx, "v1", "Pod", ns, name)
	if errors.Is(err, ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if !d.owns(pod) {
		return fmt.Errorf("%w: pod %s/%s", driver.ErrNotOwned, ns, name)
	}
	return ignoreNotFound(d.k.Delete(ctx, "v1", "Pod", ns, name))
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
	pods, err := d.k.List(ctx, "v1", "Pod", ls)
	if err != nil {
		return nil, err
	}
	var out []driver.MachineRef
	for _, p := range pods {
		md, _ := p["metadata"].(map[string]any)
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
		out = append(out, driver.MachineRef{MachineID: ref, DriverRef: ref, ImageID: tags["kodus:image"], Tags: tags})
	}
	return out, nil
}

// SetExpiry patches only the kodus.io/expires annotation of this cell's
// pod, held under the ceiling the pod carries (not the one the caller's ref
// says).
func (d *Driver) SetExpiry(ctx context.Context, ref driver.MachineRef, at time.Time) error {
	ns, name := split(ref)
	pod, err := d.k.Get(ctx, "v1", "Pod", ns, name)
	if err != nil {
		return err
	}
	if !d.owns(pod) {
		return fmt.Errorf("%w: pod %s/%s", driver.ErrNotOwned, ns, name)
	}
	md, _ := pod["metadata"].(map[string]any)
	annotations, _ := md["annotations"].(map[string]any)
	hard, perr := time.Parse(time.RFC3339, fmt.Sprint(annotations[label(driver.TagHardExpires)]))
	if perr != nil {
		return fmt.Errorf("k8ssandbox: pod %s/%s has no ceiling: %w", ns, name, perr)
	}
	if at.After(hard) {
		at = hard
	}
	return d.k.Apply(ctx, Object{"apiVersion": "v1", "kind": "Pod", "metadata": map[string]any{
		"name": name, "namespace": ns, "annotations": map[string]any{label(driver.TagExpires): driver.FormatTime(at)},
	}})
}

var _ driver.MachineDriver = (*Driver)(nil)
