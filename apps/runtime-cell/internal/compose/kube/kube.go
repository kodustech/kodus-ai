// Package kube renders a claim's compose project into Kubernetes objects:
// the gvisor environment backend of docs/runtime/kubernetes-environment-runs.md,
// one pod per compose service, the shape docker-gvisor runs on a host.
//
// It is a pure rule package of the cell process, the Kubernetes sibling of
// compose/sandbox: the compose file the agent loaded (internal/compose) and
// the claim's settings in, a Plan out, no cluster. Every key is on an
// allowlist; what the backend cannot honour is refused whole, with every
// reason at once (sandbox.RefusedError for what no cell runs, an
// UnsupportedError for what this backend does not run yet), never dropped.
// The few keys that carry no runtime meaning on a pod are listed in
// Plan.Ignored, so the driver logs them.
//
// What a pod of a service gets, whatever the file says:
//
//   - the claim's RuntimeClass, no service account token, no host
//     namespaces or paths, no privilege, no escalation, every capability
//     dropped but compose/sandbox's ServiceCaps, RuntimeDefault seccomp,
//     no service links, the kubelet's deadline at the claim's ceiling;
//   - requests equal to limits (Guaranteed), the claim's size shared by its
//     services (a service's own mem_limit or cpus is taken from the share);
//   - the cell's resolver as its only DNS server, and an /etc/hosts the
//     cell writes with every service's name (and network aliases) at its
//     pod's address: compose names resolve with no Service object and on
//     any port, as on a compose network;
//   - an init container (InitContainer, the cell's helper image) that holds
//     the service until the cell opens its gate: the cell writes the hosts
//     file, copies the checkout files the service binds, restores or takes
//     the golden data of its volumes, and starts the services in
//     depends_on order through it.
//
// Named volumes are PersistentVolumeClaims (they outlive a pod, so a reset
// can stop the database, copy its data and give the next round the same
// bytes); anonymous volumes, tmpfs and shm_size are emptyDirs; a bind of a
// checkout path is an emptyDir the cell fills, mounted read-only.
package kube

import (
	"errors"
	"fmt"
	"io/fs"
	"maps"
	"path"
	"slices"
	"sort"
	"strconv"
	"strings"

	"go.yaml.in/yaml/v3"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose/sandbox"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/yamlbound"
)

// Object is an unstructured manifest (apiVersion, kind, metadata, spec).
type Object = map[string]any

// ServiceLabel names a pod's compose service (its slug).
const ServiceLabel = "kodus.io/service"

// The init container every service pod starts with, and where it mounts
// what the cell fills through it.
const (
	InitContainer = "kodus-init"
	GateDir       = "/kodus/gate"
	HostsDir      = "/kodus/hosts"
	DataDir       = "/kodus/data"
	CopyDir       = "/kodus/copy"
)

// GateWait is the init container's command: it holds the service until the
// cell opens the gate.
// It is PID 1 of its container, which ignores a signal it has no handler
// for: the trap lets a pod deleted at its gate stop at once instead of at
// the end of its grace period.
const GateWait = `trap 'exit 143' TERM INT; until [ -e /kodus/gate/open ]; do sleep 0.2; done`

// DefaultStopGrace is a service's grace period when the file sets no
// stop_grace_period: compose's (docker stop's) 10 s.
const DefaultStopGrace = 10

// InitScript is what the cell runs in the init container (pods/exec), one
// operation per call, its arguments positional and never spliced:
//
//	hosts            stdin is the pod's /etc/hosts
//	decoy            stdin is the Run's decoy credentials file (Options.Decoy)
//	copy <dir>       stdin is a tar of checkout files, unpacked in CopyDir/<dir>
//	wipe <dir>       empties DataDir/<dir> (a new volume, as compose down -v)
//	take <dir>       stdout is a tar of DataDir/<dir> (the golden copy)
//	restore <dir>    empties DataDir/<dir> and unpacks stdin's tar in it
//	open             opens the gate: the service starts
const InitScript = `set -eu
op="$1"; shift
case "$op" in
hosts) cat > /kodus/hosts/hosts ;;
decoy) cat > /kodus/hosts/npmrc ;;
copy) mkdir -p "/kodus/copy/$1" && tar -x -f - -C "/kodus/copy/$1" ;;
wipe) find "/kodus/data/$1" -mindepth 1 -delete ;;
take) tar -c -f - -C "/kodus/data/$1" . ;;
restore) find "/kodus/data/$1" -mindepth 1 -delete && tar -x -f - -C "/kodus/data/$1" ;;
open) touch /kodus/gate/open ;;
*) echo "kodus-init: unknown operation $op" >&2; exit 2 ;;
esac`

// Port is one destination an egress peer accepts.
type Port struct {
	Protocol string // TCP | UDP
	Port     int
}

// EgressPeer is somewhere a claim's pods may connect besides each other:
// the cell's proxy and resolver (the pods of the cell's namespace that
// carry PodLabels), or an address block.
type EgressPeer struct {
	NamespaceLabels map[string]string
	PodLabels       map[string]string
	CIDR            string
	Ports           []Port
}

// Size is the claim's whole size, shared by its services.
type Size struct {
	MemoryMB int
	CPUs     int
}

type Options struct {
	// Namespace is the environment namespace every object lives in.
	Namespace string
	// Prefix starts every object name of the claim (a DNS label, at most
	// 63 bytes): the driver's "env-<claim>". A pod is Prefix-<service slug>
	// (a DNS subdomain), and the slugs are labels of at most 40 bytes.
	Prefix string
	// Labels go on every object; Selector are the ones that select this
	// claim's pods (the NetworkPolicy's own claim), a subset of Labels.
	Labels   map[string]string
	Selector map[string]string
	// Annotations go on every pod (the claim's ceiling).
	Annotations map[string]string
	// Side is the claim's side (base, pr, setup); a label when set.
	Side string
	// RuntimeClass every pod runs on; HelperImage is the init container's
	// (the cell's, with sh, tar and find).
	RuntimeClass string
	HelperImage  string
	// Size is shared by the services (requests equal limits).
	Size Size
	// DeadlineSeconds is every pod's activeDeadlineSeconds: the kubelet
	// ends it at the claim's ceiling whatever happens to the cell.
	DeadlineSeconds int64
	// Nameservers are the pods' only DNS servers (the cell's resolver).
	Nameservers []string
	// Egress is where the claim's pods may connect besides each other.
	Egress []EgressPeer
	// VolumeSize is every named volume's claim ("1Gi" when empty);
	// StorageClass its class (the cluster's default when empty).
	VolumeSize   string
	StorageClass string
	// Built are images the cell's builder made, by service: their build
	// sections give way to them. Without one a build is unsupported.
	Built map[string]string
	// Checkout is the claim's checkout, rooted (os.Root.FS): env files are
	// read from it and binds copied from it. Nil: both are refused.
	Checkout fs.FS
	// Decoy: every service gets the Run's decoy credentials file at
	// sandbox.DecoyTarget, written through the gate (ADR-043).
	Decoy bool
}

// Plan is the claim's project as Kubernetes objects.
type Plan struct {
	// Services in start order: every service after what it depends on.
	Services []Service
	// Volumes are the project's named volumes, one claim each.
	Volumes []Volume
	// Policy is the claim's NetworkPolicy: its pods reach and are reached
	// by each other only, and reach the Egress peers.
	Policy Object
	// Ignored are keys the file sets that carry no runtime meaning on a
	// pod, and why.
	Ignored []sandbox.Violation
}

// Objects are every object of the plan, policy and volumes first.
func (p *Plan) Objects() []Object {
	out := []Object{p.Policy}
	for _, v := range p.Volumes {
		out = append(out, v.Object)
	}
	for _, s := range p.Services {
		out = append(out, s.Pod)
	}
	return out
}

// Service is one compose service and its pod.
type Service struct {
	Name string
	// PodName and Container name the pod and the service's container.
	PodName, Container string
	Pod                Object
	// Wave is how deep it sits in depends_on: 0 depends on nothing.
	Wave      int
	DependsOn []Dependency
	// Hostnames resolve to the pod in every pod of the claim.
	Hostnames []string
	// Hostname is the pod's own hostname (compose hostname), when set.
	Hostname string
	// Healthcheck: the pod has a readiness probe from the file's test.
	Healthcheck bool
	// WorkingDir is where an exec in the service starts ("" : the image's).
	WorkingDir string
	Data       []DataMount
	Copies     []Copy
}

// Dependency is one depends_on entry.
type Dependency struct {
	Service string
	// Condition is service_started, service_healthy or
	// service_completed_successfully.
	Condition string
}

// DataMount is a named volume a service mounts: Dir is where the init
// container sees it (DataDir/Dir).
type DataMount struct {
	Volume, Claim, Dir, Target string
}

// Copy is a checkout path a service binds: the cell unpacks it in
// CopyDir/Dir before the gate opens. File: Source is one file.
type Copy struct {
	Dir, Source, Target string
	File                bool
}

// Volume is one named volume and its claim.
type Volume struct {
	Key, Name string
	Object    Object
}

// ErrUnsupported is what UnsupportedError matches.
var ErrUnsupported = errors.New("kube: not supported by the Kubernetes environment backend yet")

// UnsupportedError lists what the file asks that this backend does not run
// yet (a build with no builder): the platform's gap, not the repository's.
type UnsupportedError struct{ Violations []sandbox.Violation }

func (e *UnsupportedError) Error() string {
	parts := make([]string, len(e.Violations))
	for i, v := range e.Violations {
		parts[i] = v.String()
	}
	return "compose not supported on Kubernetes yet: " + strings.Join(parts, "; ")
}

func (e *UnsupportedError) Is(target error) bool { return target == ErrUnsupported }

// Keys a service may set. Anything else is refused.
var serviceKeys = map[string]bool{
	"image": true, "command": true, "entrypoint": true, "environment": true, "env_file": true,
	"ports": true, "expose": true, "depends_on": true, "healthcheck": true, "volumes": true,
	"working_dir": true, "user": true, "restart": true, "labels": true, "tmpfs": true, "init": true,
	"stop_signal": true, "stop_grace_period": true, "deploy": true, "mem_limit": true, "cpus": true,
	"hostname": true, "platform": true, "profiles": true, "cap_drop": true, "cap_add": true,
	"read_only": true, "shm_size": true, "logging": true, "networks": true, "pull_policy": true, "build": true,
}

// Why the keys no cell runs are refused (compose/sandbox's reasons, read on
// a cluster).
var refusedKeys = map[string]string{
	"privileged":          "privileged containers reach the node",
	"devices":             "node devices",
	"device_cgroup_rules": "node devices",
	"network_mode":        "the node's or another container's network",
	"pid":                 "the node's or another container's pid namespace",
	"ipc":                 "the node's or another container's ipc namespace",
	"uts":                 "the node's uts namespace",
	"userns_mode":         "the node's user namespace",
	"cgroup_parent":       "the node's cgroups",
	"cgroup":              "the node's cgroups",
	"runtime":             "the cell chooses the RuntimeClass",
	"security_opt":        "the cell sets the security options",
	"sysctls":             "kernel parameters",
	"volumes_from":        "another container's mounts",
	"extra_hosts":         "name resolution is the cell's (the hosts file and its resolver)",
	"dns":                 "name resolution is the cell's (the hosts file and its resolver)",
	"dns_search":          "name resolution is the cell's (the hosts file and its resolver)",
	"dns_opt":             "name resolution is the cell's (the hosts file and its resolver)",
	"container_name":      "names are per claim",
	"oom_kill_disable":    "node memory protection",
	"oom_score_adj":       "node memory protection",
	"group_add":           "node groups",
	"isolation":           "the cell chooses the isolation",
	"external_links":      "containers outside the project",
	"links":               "use depends_on: every service resolves every other by name",
	"configs":             "files outside the project",
	"secrets":             "secrets come from the cell injector, not the compose file",
	"mac_address":         "network identity",
	"storage_opt":         "node storage driver",
	"extends":             "files outside the one the cell checked",
	"ulimits":             "a pod has no per-container rlimits",
	"tty":                 "no terminal is attached to a service",
	"stdin_open":          "no terminal is attached to a service",
}

// ignoredKeys carry no runtime meaning on a pod.
var ignoredKeys = map[string]string{
	"labels":   "container labels are metadata no pod reads",
	"logging":  "the kubelet bounds and rotates every container's log",
	"profiles": "the agent already kept the active profiles' services",
}

var topKeys = map[string]bool{"services": true, "volumes": true, "networks": true, "name": true, "version": true, "secrets": true}

type renderer struct {
	o           Options
	refused     []sandbox.Violation
	unsupported []sandbox.Violation
	ignored     []sandbox.Violation
}

func (r *renderer) refuse(path, reason string) {
	r.refused = append(r.refused, sandbox.Violation{Path: path, Reason: reason})
}

func (r *renderer) unsupported1(path, reason string) {
	r.unsupported = append(r.unsupported, sandbox.Violation{Path: path, Reason: reason})
}

// Render reads the compose file and returns its plan, or every reason it
// cannot run here.
func Render(raw []byte, o Options) (*Plan, error) {
	if err := o.check(); err != nil {
		return nil, err
	}
	r := &renderer{o: o}
	doc, err := r.parse(raw)
	if err != nil {
		return nil, err
	}
	for _, k := range sortedKeys(doc) {
		switch {
		case strings.HasPrefix(k, "x-"):
			delete(doc, k)
		case !topKeys[k]:
			r.refuse(k, "not in the allowlist")
		case k == "secrets":
			r.ignored = append(r.ignored, sandbox.Violation{Path: k, Reason: "top-level secrets are read by builds only, and the backend builds nothing"})
		}
	}
	interpolateTree(doc, "", func(p, why string) { r.refuse(strings.TrimPrefix(p, "."), why) })
	services, _ := doc["services"].(map[string]any)
	if len(services) == 0 {
		r.refuse("services", "no services")
	}
	declared := r.volumes(doc["volumes"])
	r.networks(doc["networks"])
	plan := &Plan{}
	specs := map[string]*serviceSpec{}
	for _, name := range sortedKeys(services) {
		if s := r.service(name, services[name], declared); s != nil {
			specs[name] = s
		}
	}
	r.sharedVolumes(specs)
	order := r.order(specs)
	if err := r.err(); err != nil {
		return nil, err
	}
	if err := r.sizes(specs, order); err != nil {
		return nil, err
	}
	for _, key := range sortedKeys(declared) {
		if declared[key] {
			plan.Volumes = append(plan.Volumes, r.claim(key))
		}
	}
	for _, name := range order {
		plan.Services = append(plan.Services, r.pod(specs[name]))
	}
	plan.Policy = r.policy()
	plan.Ignored = r.ignored
	return plan, nil
}

func (o Options) check() error {
	switch {
	case o.Namespace == "" || o.RuntimeClass == "" || o.HelperImage == "":
		return errors.New("kube: namespace, runtime class and helper image required")
	case !dnsLabel.MatchString(o.Prefix) || len(o.Prefix) > 63:
		return fmt.Errorf("kube: prefix %q is not a DNS label", o.Prefix)
	case len(o.Selector) == 0:
		return errors.New("kube: a claim selector is required")
	case len(o.Nameservers) == 0:
		return errors.New("kube: the pods need the cell's resolver as their nameserver")
	case o.Size.MemoryMB <= 0 || o.Size.CPUs <= 0:
		return errors.New("kube: the claim's size is required")
	case o.DeadlineSeconds <= 0:
		return errors.New("kube: the claim's deadline is required")
	}
	for k, v := range o.Selector {
		if o.Labels[k] != v {
			return fmt.Errorf("kube: selector label %s is not one of the labels", k)
		}
	}
	return nil
}

func (r *renderer) err() error {
	if len(r.refused) > 0 {
		return &sandbox.RefusedError{Violations: r.refused}
	}
	if len(r.unsupported) > 0 {
		return &UnsupportedError{Violations: r.unsupported}
	}
	return nil
}

// parse reads the file bounded (yamlbound), refusing YAML tags this reader
// does not give compose's meaning (!reset, !override).
func (r *renderer) parse(raw []byte) (map[string]any, error) {
	node, err := yamlbound.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("compose: %w", err)
	}
	r.checkTags(node, "")
	var doc map[string]any
	if err := node.Decode(&doc); err != nil {
		return nil, fmt.Errorf("compose: %w", err)
	}
	if doc == nil {
		doc = map[string]any{}
	}
	return doc, nil
}

func (r *renderer) checkTags(n *yaml.Node, p string) {
	switch n.Tag {
	case "", "!!str", "!!int", "!!bool", "!!float", "!!null", "!!map", "!!seq", "!!merge", "!!timestamp":
	default:
		if n.Kind != yaml.DocumentNode {
			r.refuse(strings.TrimPrefix(p, "."), "YAML tag "+n.Tag)
		}
	}
	for i, ch := range n.Content {
		q := p
		if n.Kind == yaml.MappingNode && i%2 == 1 {
			q = p + "." + n.Content[i-1].Value
		}
		r.checkTags(ch, q)
	}
}

// volumes reads the top-level volumes: the project's own only (no driver,
// no external one). The value is whether a service mounts it (set later).
func (r *renderer) volumes(v any) map[string]bool {
	out := map[string]bool{}
	vols, _ := v.(map[string]any)
	if v != nil && vols == nil {
		r.refuse("volumes", "not a mapping")
	}
	for _, name := range sortedKeys(vols) {
		out[name] = false
		m, _ := vols[name].(map[string]any)
		for _, k := range sortedKeys(m) {
			switch k {
			case "labels", "name":
			case "external":
				if b, _ := m[k].(bool); b {
					r.refuse("volumes."+name+".external", "a volume outside the project")
				}
			default:
				r.refuse("volumes."+name+"."+k, "the cell makes the volume (a PersistentVolumeClaim)")
			}
		}
	}
	return out
}

// networks reads the top-level networks: every service of a claim is on
// one network (its NetworkPolicy), so a network's options are refused and
// its name is all it is.
func (r *renderer) networks(v any) {
	nets, _ := v.(map[string]any)
	if v != nil && nets == nil {
		r.refuse("networks", "not a mapping")
	}
	for _, name := range sortedKeys(nets) {
		m, _ := nets[name].(map[string]any)
		for _, k := range sortedKeys(m) {
			switch k {
			case "labels", "name":
			case "external":
				if b, _ := m[k].(bool); b {
					r.refuse("networks."+name+".external", "a network outside the project")
				}
			default:
				r.refuse("networks."+name+"."+k, "the claim's network is the cell's")
			}
		}
	}
}

// sharedVolumes refuses a named volume two services mount: each service
// has its own pod, and a ReadWriteOnce claim does not follow two pods to
// different nodes.
func (r *renderer) sharedVolumes(specs map[string]*serviceSpec) {
	by := map[string][]string{}
	for _, name := range sortedKeys(specs) {
		seen := map[string]bool{}
		for _, m := range specs[name].named {
			if !seen[m.key] {
				seen[m.key] = true
				by[m.key] = append(by[m.key], name)
			}
		}
	}
	for _, key := range sortedKeys(by) {
		if len(by[key]) > 1 {
			r.unsupported1("volumes."+key, fmt.Sprintf("mounted by %s: each service is its own pod, and one volume claim cannot follow two pods", strings.Join(by[key], " and ")))
		}
	}
}

// order is the services in start order: each after its dependencies,
// alphabetical within a wave. A cycle or an unknown service is refused.
func (r *renderer) order(specs map[string]*serviceSpec) []string {
	wave := map[string]int{}
	state := map[string]int{} // 1 visiting, 2 done
	var visit func(name string, trail []string) int
	visit = func(name string, trail []string) int {
		switch state[name] {
		case 1:
			r.refuse("services."+name+".depends_on", "a cycle: "+strings.Join(append(trail, name), " -> "))
			return 0
		case 2:
			return wave[name]
		}
		state[name] = 1
		w := 0
		for _, d := range specs[name].deps {
			if _, ok := specs[d.Service]; !ok {
				r.refuse("services."+name+".depends_on."+d.Service, "not a service of the project")
				continue
			}
			w = max(w, visit(d.Service, append(trail, name))+1)
		}
		state[name], wave[name] = 2, w
		return w
	}
	names := sortedKeys(specs)
	for _, n := range names {
		visit(n, nil)
	}
	for _, n := range names {
		specs[n].wave = wave[n]
		for _, d := range specs[n].deps {
			if t, ok := specs[d.Service]; ok && d.Condition == "service_healthy" && t.probe == nil {
				r.refuse("services."+n+".depends_on."+d.Service, "service_healthy on a service whose healthcheck is the image's own: Kubernetes does not run an image HEALTHCHECK, give it a test")
			}
		}
	}
	sort.SliceStable(names, func(i, j int) bool { return wave[names[i]] < wave[names[j]] })
	return names
}

// sizes shares the claim's size between the services: a service's own
// limit is taken first, the rest is split evenly; the sum never passes the
// claim's size.
func (r *renderer) sizes(specs map[string]*serviceSpec, names []string) error {
	const minMB, minMilli = 32, 50
	mem, cpu := r.o.Size.MemoryMB, r.o.Size.CPUs*1000
	var freeMem, freeCPU int
	for _, n := range names {
		s := specs[n]
		mem -= s.memMB
		cpu -= s.milliCPU
		if s.memMB == 0 {
			freeMem++
		}
		if s.milliCPU == 0 {
			freeCPU++
		}
	}
	switch {
	case mem < 0 || (freeMem > 0 && mem/freeMem < minMB):
		return &sandbox.RefusedError{Violations: []sandbox.Violation{{Path: "services", Reason: fmt.Sprintf("the services' memory does not fit the claim's %d MB", r.o.Size.MemoryMB)}}}
	case cpu < 0 || (freeCPU > 0 && cpu/freeCPU < minMilli):
		return &sandbox.RefusedError{Violations: []sandbox.Violation{{Path: "services", Reason: fmt.Sprintf("the services' CPUs do not fit the claim's %d CPUs", r.o.Size.CPUs)}}}
	}
	for _, n := range names {
		s := specs[n]
		if s.memMB == 0 {
			s.memMB = mem / freeMem
		}
		if s.milliCPU == 0 {
			s.milliCPU = cpu / freeCPU
		}
	}
	return nil
}

func (r *renderer) labels(extra map[string]string) map[string]any {
	out := map[string]any{}
	for k, v := range r.o.Labels {
		out[k] = v
	}
	if r.o.Side != "" {
		out["kodus.io/side"] = r.o.Side
	}
	for k, v := range extra {
		out[k] = v
	}
	return out
}

func (r *renderer) meta(name string, labels map[string]any, annotations map[string]string) map[string]any {
	md := map[string]any{"name": name, "namespace": r.o.Namespace, "labels": labels}
	if len(annotations) > 0 {
		a := map[string]any{}
		for k, v := range annotations {
			a[k] = v
		}
		md["annotations"] = a
	}
	return md
}

func (r *renderer) claimName(key string) string {
	return r.o.Prefix + "-" + slug(key, 40)
}

func (r *renderer) claim(key string) Volume {
	size := r.o.VolumeSize
	if size == "" {
		size = "1Gi"
	}
	spec := map[string]any{"accessModes": []any{"ReadWriteOnce"}, "resources": map[string]any{"requests": map[string]any{"storage": size}}}
	if r.o.StorageClass != "" {
		spec["storageClassName"] = r.o.StorageClass
	}
	name := r.claimName(key)
	return Volume{Key: key, Name: name, Object: Object{
		"apiVersion": "v1", "kind": "PersistentVolumeClaim",
		"metadata": r.meta(name, r.labels(nil), map[string]string{"kodus.io/volume": key}), "spec": spec,
	}}
}

// policy isolates the claim: ingress from its own pods only, egress to its
// own pods and the egress peers.
func (r *renderer) policy() Object {
	self := map[string]any{"podSelector": map[string]any{"matchLabels": toAny(r.o.Selector)}}
	egress := []any{map[string]any{"to": []any{self}}}
	for _, p := range r.o.Egress {
		peer := map[string]any{}
		if p.CIDR != "" {
			peer["ipBlock"] = map[string]any{"cidr": p.CIDR}
		} else {
			peer["namespaceSelector"] = map[string]any{"matchLabels": toAny(p.NamespaceLabels)}
			peer["podSelector"] = map[string]any{"matchLabels": toAny(p.PodLabels)}
		}
		rule := map[string]any{"to": []any{peer}}
		if len(p.Ports) > 0 {
			var ports []any
			for _, pt := range p.Ports {
				proto := pt.Protocol
				if proto == "" {
					proto = "TCP"
				}
				ports = append(ports, map[string]any{"protocol": proto, "port": pt.Port})
			}
			rule["ports"] = ports
		}
		egress = append(egress, rule)
	}
	return Object{
		"apiVersion": "networking.k8s.io/v1", "kind": "NetworkPolicy",
		"metadata": r.meta(r.o.Prefix, r.labels(nil), nil),
		"spec": map[string]any{
			"podSelector": map[string]any{"matchLabels": toAny(r.o.Selector)},
			"policyTypes": []any{"Ingress", "Egress"},
			"ingress":     []any{map[string]any{"from": []any{self}}},
			"egress":      egress,
		},
	}
}

func toAny(m map[string]string) map[string]any {
	out := make(map[string]any, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

func sortedKeys[V any](m map[string]V) []string {
	return slices.Sorted(maps.Keys(m))
}

// serviceSpec is one service as read, before its pod is written.
type serviceSpec struct {
	name, slug  string
	image       string
	pullPolicy  string
	command     []string
	args        []string
	hasCommand  bool
	hasArgs     bool
	env         map[string]string
	ports       []int
	deps        []Dependency
	probe       map[string]any
	named       []namedMount
	anon        []string
	tmpfs       []tmpfsMount
	copies      []Copy
	shmMB       int
	workingDir  string
	user        *int64
	group       *int64
	restart     string
	readOnly    bool
	init        bool
	grace       *int64
	hostname    string
	arch        string
	caps        []string
	aliases     []string
	memMB       int
	milliCPU    int
	wave        int
	copyTargets map[string]bool
}

type namedMount struct {
	key, target, subPath string
	readOnly             bool
}

type tmpfsMount struct {
	target string
	sizeMB int
}

func (r *renderer) service(name string, v any, declared map[string]bool) *serviceSpec {
	p := "services." + name
	svc, _ := v.(map[string]any)
	if svc == nil {
		r.refuse(p, "not a mapping")
		return nil
	}
	s := &serviceSpec{name: name, slug: slug(name, 40), env: map[string]string{}, restart: "Never", copyTargets: map[string]bool{}}
	for _, k := range sortedKeys(svc) {
		switch {
		case refusedKeys[k] != "":
			r.refuse(p+"."+k, refusedKeys[k])
		case ignoredKeys[k] != "":
			r.ignored = append(r.ignored, sandbox.Violation{Path: p + "." + k, Reason: ignoredKeys[k]})
		case !serviceKeys[k]:
			r.refuse(p+"."+k, "not in the allowlist")
		}
	}
	r.image(s, svc, p)
	r.commands(s, svc, p)
	r.environment(s, svc, p)
	r.portsOf(s, svc, p)
	r.dependsOn(s, svc["depends_on"], p+".depends_on")
	r.healthcheck(s, svc["healthcheck"], p+".healthcheck")
	r.mounts(s, svc, p, declared)
	r.securityOf(s, svc, p)
	r.limits(s, svc, p)
	r.misc(s, svc, p)
	return s
}

func (r *renderer) image(s *serviceSpec, svc map[string]any, p string) {
	img, _ := svc["image"].(string)
	if svc["image"] != nil && img == "" {
		r.refuse(p+".image", "not a string")
	}
	if svc["build"] != nil {
		if built := r.o.Built[s.name]; built != "" {
			img = built
		} else {
			r.unsupported1(p+".build", "the Kubernetes backend has no image builder yet (a rootless BuildKit pod on the RuntimeClass): use an image from a registry")
			return
		}
	}
	if img == "" {
		r.refuse(p, "no image")
	}
	s.image = img
	switch pp, _ := svc["pull_policy"].(string); pp {
	case "":
	case "always":
		s.pullPolicy = "Always"
	case "never":
		s.pullPolicy = "Never"
	case "missing", "if_not_present":
		s.pullPolicy = "IfNotPresent"
	default:
		r.refuse(p+".pull_policy", fmt.Sprintf("pull_policy %q", pp))
	}
}

// argv reads a command or entrypoint: a list as it is, a string split into
// shell words as compose does.
func (r *renderer) argv(v any, p string) ([]string, bool) {
	switch x := v.(type) {
	case nil:
		return nil, false
	case string:
		out, err := splitShell(x)
		if err != nil {
			r.refuse(p, err.Error())
		}
		return out, true
	case []any:
		out := make([]string, 0, len(x))
		for i, e := range x {
			sv, ok := scalar(e)
			if !ok {
				r.refuse(fmt.Sprintf("%s[%d]", p, i), "not a string")
			}
			out = append(out, sv)
		}
		return out, true
	}
	r.refuse(p, "not a string or a list")
	return nil, false
}

func scalar(v any) (string, bool) {
	switch x := v.(type) {
	case string:
		return x, true
	case int:
		return strconv.Itoa(x), true
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64), true
	case bool:
		return strconv.FormatBool(x), true
	case nil:
		return "", true
	}
	return "", false
}

// commands: compose's entrypoint is the container's command, compose's
// command its args (an entrypoint with no command drops the image's CMD in
// both).
func (r *renderer) commands(s *serviceSpec, svc map[string]any, p string) {
	s.command, s.hasCommand = r.argv(svc["entrypoint"], p+".entrypoint")
	s.args, s.hasArgs = r.argv(svc["command"], p+".command")
}

func (r *renderer) environment(s *serviceSpec, svc map[string]any, p string) {
	files := []struct {
		path     string
		required bool
		at       string
	}{}
	switch ef := svc["env_file"].(type) {
	case nil:
	case string:
		files = append(files, struct {
			path     string
			required bool
			at       string
		}{ef, true, p + ".env_file"})
	case []any:
		for i, f := range ef {
			at := fmt.Sprintf("%s.env_file[%d]", p, i)
			switch x := f.(type) {
			case string:
				files = append(files, struct {
					path     string
					required bool
					at       string
				}{x, true, at})
			case map[string]any:
				fp, _ := x["path"].(string)
				req := true
				if b, ok := x["required"].(bool); ok {
					req = b
				}
				files = append(files, struct {
					path     string
					required bool
					at       string
				}{fp, req, at})
			default:
				r.refuse(at, "unknown env_file syntax")
			}
		}
	default:
		r.refuse(p+".env_file", "unknown env_file syntax")
	}
	for _, f := range files {
		rel, ok := r.checkoutPath(f.path, f.at)
		if !ok {
			continue
		}
		b, err := fs.ReadFile(r.o.Checkout, rel)
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) && !f.required {
				continue
			}
			r.refuse(f.at, "cannot read it in the checkout: "+err.Error())
			continue
		}
		env, err := parseEnvFile(b)
		if err != nil {
			r.refuse(f.at, err.Error())
			continue
		}
		maps.Copy(s.env, env)
	}
	switch e := svc["environment"].(type) {
	case nil:
	case map[string]any:
		for _, k := range sortedKeys(e) {
			if e[k] == nil {
				delete(s.env, k) // a name with no value passes compose's own, which is empty
				continue
			}
			v, ok := scalar(e[k])
			if !ok {
				r.refuse(p+".environment."+k, "not a scalar")
				continue
			}
			s.env[k] = v
		}
	case []any:
		for i, kv := range e {
			str, _ := kv.(string)
			k, v, ok := strings.Cut(str, "=")
			if k == "" {
				r.refuse(fmt.Sprintf("%s.environment[%d]", p, i), "not NAME=value")
				continue
			}
			if !ok {
				delete(s.env, k)
				continue
			}
			s.env[k] = v
		}
	default:
		r.refuse(p+".environment", "not a mapping or a list")
	}
	for k := range s.env {
		if bracedName.FindString(k) != k {
			r.refuse(p+".environment."+k, "not a variable name")
		}
	}
}

// checkoutPath is a host path of the file as a path in the checkout: it
// must be relative ("./x" after the agent rebased it) and stay inside.
func (r *renderer) checkoutPath(p, at string) (string, bool) {
	if r.o.Checkout == nil {
		r.refuse(at, "no checkout to read host paths from")
		return "", false
	}
	if p == "" || strings.HasPrefix(p, "/") || strings.HasPrefix(p, "~") {
		r.refuse(at, fmt.Sprintf("host path %q outside the checkout", p))
		return "", false
	}
	clean := path.Clean(p)
	if clean == ".." || strings.HasPrefix(clean, "../") || !fs.ValidPath(clean) {
		r.refuse(at, fmt.Sprintf("host path %q outside the checkout", p))
		return "", false
	}
	return clean, true
}

func (r *renderer) portsOf(s *serviceSpec, svc map[string]any, p string) {
	add := func(n int, at string) {
		if n < 1 || n > 65535 {
			r.refuse(at, "not a port")
			return
		}
		if !slices.Contains(s.ports, n) {
			s.ports = append(s.ports, n)
		}
	}
	readPort := func(v any, at string) {
		str, ok := scalar(v)
		if !ok {
			r.refuse(at, "unknown port syntax")
			return
		}
		str, _, _ = strings.Cut(str, "/")
		if i := strings.LastIndex(str, ":"); i >= 0 {
			str = str[i+1:] // the container side of host:container
		}
		lo, hi, isRange := strings.Cut(str, "-")
		a, err1 := strconv.Atoi(lo)
		b := a
		var err2 error
		if isRange {
			b, err2 = strconv.Atoi(hi)
		}
		if err1 != nil || err2 != nil || b < a || b-a > 100 {
			r.refuse(at, fmt.Sprintf("port %q", str))
			return
		}
		for n := a; n <= b; n++ {
			add(n, at)
		}
	}
	for _, key := range []string{"ports", "expose"} {
		list, ok := svc[key].([]any)
		if svc[key] != nil && !ok {
			r.refuse(p+"."+key, "not a list")
		}
		for i, e := range list {
			at := fmt.Sprintf("%s.%s[%d]", p, key, i)
			if m, ok := e.(map[string]any); ok {
				readPort(m["target"], at)
				continue
			}
			readPort(e, at)
		}
	}
	sort.Ints(s.ports)
}

func (r *renderer) dependsOn(s *serviceSpec, v any, p string) {
	switch x := v.(type) {
	case nil:
	case []any:
		for i, e := range x {
			n, _ := e.(string)
			if n == "" {
				r.refuse(fmt.Sprintf("%s[%d]", p, i), "not a service name")
				continue
			}
			s.deps = append(s.deps, Dependency{Service: n, Condition: "service_started"})
		}
	case map[string]any:
		for _, n := range sortedKeys(x) {
			m, _ := x[n].(map[string]any)
			cond := "service_started"
			for _, k := range sortedKeys(m) {
				switch k {
				case "condition":
					c, _ := m[k].(string)
					switch c {
					case "service_started", "service_healthy", "service_completed_successfully":
						cond = c
					default:
						r.refuse(p+"."+n+".condition", fmt.Sprintf("condition %q", c))
					}
				case "required":
					if b, ok := m[k].(bool); ok && !b {
						r.refuse(p+"."+n+".required", "an optional dependency: every service of the project is started")
					}
				case "restart":
				default:
					r.refuse(p+"."+n+"."+k, "not in the allowlist")
				}
			}
			s.deps = append(s.deps, Dependency{Service: n, Condition: cond})
		}
	default:
		r.refuse(p, "not a list or a mapping")
	}
}

// healthcheck becomes the pod's readiness probe: the same test, probed at
// most every 2 s so a dependent starts soon after the first pass (as
// compose/sandbox's start interval), never killing the service (readiness,
// not liveness: compose never restarts an unhealthy service).
func (r *renderer) healthcheck(s *serviceSpec, v any, p string) {
	hc, ok := v.(map[string]any)
	if v == nil {
		return
	}
	if !ok {
		r.refuse(p, "not a mapping")
		return
	}
	for _, k := range sortedKeys(hc) {
		switch k {
		case "test", "interval", "timeout", "retries", "start_period", "start_interval", "disable":
		default:
			r.refuse(p+"."+k, "not in the allowlist")
		}
	}
	if d, _ := hc["disable"].(bool); d {
		return
	}
	var cmd []string
	switch t := hc["test"].(type) {
	case nil:
		return // the image's own HEALTHCHECK: no probe here (order refuses service_healthy on it)
	case string:
		if t == "" || t == "NONE" {
			return
		}
		cmd = []string{"/bin/sh", "-c", t}
	case []any:
		var words []string
		for i, e := range t {
			w, ok := scalar(e)
			if !ok {
				r.refuse(fmt.Sprintf("%s.test[%d]", p, i), "not a string")
				return
			}
			words = append(words, w)
		}
		switch {
		case len(words) == 0 || words[0] == "NONE":
			return
		case words[0] == "CMD" && len(words) > 1:
			cmd = words[1:]
		case words[0] == "CMD-SHELL" && len(words) == 2:
			cmd = []string{"/bin/sh", "-c", words[1]}
		default:
			r.refuse(p+".test", "not NONE, CMD or CMD-SHELL")
			return
		}
	default:
		r.refuse(p+".test", "not a string or a list")
		return
	}
	// start_period is read and checked only: failures of a readiness probe
	// never stop the service, so there is nothing for it to excuse.
	interval, timeout, retries, start := 30, 30, 3, 0
	read := func(k string, into *int) {
		if hc[k] == nil {
			return
		}
		d, err := duration(hc[k])
		if err != nil {
			r.refuse(p+"."+k, err.Error())
			return
		}
		*into = seconds(d, 0)
	}
	read("interval", &interval)
	read("timeout", &timeout)
	read("start_period", &start)
	if hc["retries"] != nil {
		n, ok := hc["retries"].(int)
		if !ok || n < 1 {
			r.refuse(p+".retries", "not a positive count")
		} else {
			retries = n
		}
	}
	s.probe = map[string]any{
		"exec":             map[string]any{"command": toList(cmd)},
		"periodSeconds":    min(max(interval, 1), 2),
		"timeoutSeconds":   max(timeout, 1),
		"failureThreshold": retries,
		"successThreshold": 1,
	}
	_ = start
}

func toList(s []string) []any {
	out := make([]any, len(s))
	for i, v := range s {
		out[i] = v
	}
	return out
}

func (r *renderer) mounts(s *serviceSpec, svc map[string]any, p string, declared map[string]bool) {
	if v := svc["volumes"]; v != nil {
		list, ok := v.([]any)
		if !ok {
			r.refuse(p+".volumes", "not a list")
		}
		for i, vol := range list {
			r.mount(s, vol, fmt.Sprintf("%s.volumes[%d]", p, i), declared)
		}
	}
	switch t := svc["tmpfs"].(type) {
	case nil:
	case string:
		r.tmpfs(s, t, p+".tmpfs")
	case []any:
		for i, e := range t {
			str, _ := e.(string)
			r.tmpfs(s, str, fmt.Sprintf("%s.tmpfs[%d]", p, i))
		}
	default:
		r.refuse(p+".tmpfs", "not a string or a list")
	}
	if v := svc["shm_size"]; v != nil {
		mb, err := memoryMB(v)
		if err != nil {
			r.refuse(p+".shm_size", err.Error())
		}
		s.shmMB = mb
	}
}

func (r *renderer) tmpfs(s *serviceSpec, spec, at string) {
	target, opts, _ := strings.Cut(spec, ":")
	if !path.IsAbs(target) {
		r.refuse(at, "not an absolute path")
		return
	}
	t := tmpfsMount{target: path.Clean(target)}
	for _, o := range strings.Split(opts, ",") {
		if sz, ok := strings.CutPrefix(o, "size="); ok {
			mb, err := memoryMB(sz)
			if err != nil {
				r.refuse(at, err.Error())
			}
			t.sizeMB = mb
		}
	}
	s.tmpfs = append(s.tmpfs, t)
}

// reservedTargets are the paths the cell mounts itself.
func reservedTarget(t string) bool {
	return t == "/etc/hosts" || t == "/etc/resolv.conf" || t == sandbox.DecoyTarget || t == "/kodus" || strings.HasPrefix(t, "/kodus/")
}

func (r *renderer) mount(s *serviceSpec, vol any, at string, declared map[string]bool) {
	var typ, src, target, subPath string
	var readOnly bool
	switch x := vol.(type) {
	case string:
		parts := strings.Split(x, ":")
		switch len(parts) {
		case 1:
			typ, target = "volume", parts[0]
		case 2, 3:
			src, target = parts[0], parts[1]
			if len(parts) == 3 {
				for _, m := range strings.Split(parts[2], ",") {
					switch m {
					case "ro":
						readOnly = true
					case "rw", "nocopy", "":
					default:
						r.refuse(at, fmt.Sprintf("mount option %q", m))
					}
				}
			}
			typ = "volume"
			if strings.HasPrefix(src, ".") || strings.HasPrefix(src, "/") || strings.HasPrefix(src, "~") || strings.Contains(src, "/") {
				typ = "bind"
			}
		default:
			r.refuse(at, "unknown volume syntax")
			return
		}
	case map[string]any:
		typ, _ = x["type"].(string)
		src, _ = x["source"].(string)
		target, _ = x["target"].(string)
		readOnly, _ = x["read_only"].(bool)
		for _, k := range sortedKeys(x) {
			switch k {
			case "type", "source", "target", "read_only", "consistency":
			case "volume":
				vo, _ := x[k].(map[string]any)
				for _, vk := range sortedKeys(vo) {
					switch vk {
					case "nocopy":
					case "subpath":
						subPath, _ = vo[vk].(string)
					default:
						r.refuse(at+".volume."+vk, "not in the volume allowlist")
					}
				}
			case "tmpfs":
				to, _ := x[k].(map[string]any)
				if sz, ok := to["size"]; ok {
					if _, err := memoryMB(sz); err != nil {
						r.refuse(at+".tmpfs.size", err.Error())
					}
				}
			case "bind":
				b, _ := x[k].(map[string]any)
				for _, bk := range sortedKeys(b) {
					if bk != "create_host_path" {
						r.refuse(at+".bind."+bk, "bind options are the cell's")
					}
				}
			default:
				r.refuse(at+"."+k, "not in the mount allowlist")
			}
		}
	default:
		r.refuse(at, "unknown volume syntax")
		return
	}
	if !path.IsAbs(target) {
		r.refuse(at, fmt.Sprintf("target %q is not an absolute path", target))
		return
	}
	target = path.Clean(target)
	if reservedTarget(target) {
		r.refuse(at, target+" is the cell's")
		return
	}
	switch typ {
	case "volume":
		if src == "" {
			s.anon = append(s.anon, target)
			return
		}
		if _, ok := declared[src]; !ok {
			r.refuse(at, fmt.Sprintf("volume %q is not one of the project's", src))
			return
		}
		declared[src] = true
		if subPath != "" && (!fs.ValidPath(subPath) || subPath == ".") {
			r.refuse(at+".volume.subpath", "not a relative path inside the volume")
			return
		}
		s.named = append(s.named, namedMount{key: src, target: target, subPath: subPath, readOnly: readOnly})
	case "tmpfs":
		s.tmpfs = append(s.tmpfs, tmpfsMount{target: target})
	case "bind":
		rel, ok := r.checkoutPath(src, at)
		if !ok {
			return
		}
		st, err := fs.Stat(r.o.Checkout, rel)
		if err != nil {
			r.refuse(at, fmt.Sprintf("bind source %q: %v", src, err))
			return
		}
		if !st.IsDir() && !st.Mode().IsRegular() {
			r.refuse(at, fmt.Sprintf("bind source %q is not a file or a directory", src))
			return
		}
		if s.copyTargets[target] {
			r.refuse(at, "two mounts at "+target)
			return
		}
		s.copyTargets[target] = true
		// Read-only, as compose/sandbox forces every bind: the checkout is
		// the PR's and the copy is the cell's.
		s.copies = append(s.copies, Copy{Dir: fmt.Sprintf("copy-%d", len(s.copies)), Source: rel, Target: target, File: !st.IsDir()})
	default:
		r.refuse(at+".type", fmt.Sprintf("volume type %q", typ))
	}
}

func capName(c string) string { return strings.TrimPrefix(strings.ToUpper(c), "CAP_") }

func (r *renderer) securityOf(s *serviceSpec, svc map[string]any, p string) {
	caps := slices.Clone(sandbox.ServiceCaps)
	if v := svc["cap_add"]; v != nil {
		list, _ := v.([]any)
		for i, e := range list {
			c, _ := e.(string)
			if !slices.Contains(sandbox.ServiceCaps, capName(c)) {
				r.refuse(fmt.Sprintf("%s.cap_add[%d]", p, i), fmt.Sprintf("capability %q is not one a service may hold", c))
			}
		}
	}
	if v := svc["cap_drop"]; v != nil {
		list, _ := v.([]any)
		for _, e := range list {
			c, _ := e.(string)
			if capName(c) == "ALL" {
				caps = nil
				break
			}
			caps = slices.DeleteFunc(caps, func(x string) bool { return x == capName(c) })
		}
	}
	s.caps = caps
	if u, ok := svc["user"]; ok {
		str, _ := scalar(u)
		uid, gid, hasGID := strings.Cut(str, ":")
		un, err := strconv.ParseInt(uid, 10, 64)
		if err != nil || un < 0 {
			r.refuse(p+".user", fmt.Sprintf("user %q: a pod runs as a numeric uid[:gid]", str))
		} else {
			s.user = &un
		}
		if hasGID {
			gn, err := strconv.ParseInt(gid, 10, 64)
			if err != nil || gn < 0 {
				r.refuse(p+".user", fmt.Sprintf("group %q: a pod runs as a numeric gid", gid))
			} else {
				s.group = &gn
			}
		}
	}
	if b, ok := svc["read_only"].(bool); ok {
		s.readOnly = b
	}
}

func (r *renderer) limits(s *serviceSpec, svc map[string]any, p string) {
	readMem := func(v any, at string) {
		if v == nil {
			return
		}
		mb, err := memoryMB(v)
		if err != nil {
			r.refuse(at, err.Error())
			return
		}
		s.memMB = mb
	}
	readCPU := func(v any, at string) {
		if v == nil {
			return
		}
		m, err := milliCPUs(v)
		if err != nil {
			r.refuse(at, err.Error())
			return
		}
		s.milliCPU = m
	}
	readMem(svc["mem_limit"], p+".mem_limit")
	readCPU(svc["cpus"], p+".cpus")
	d, ok := svc["deploy"].(map[string]any)
	if svc["deploy"] != nil && !ok {
		r.refuse(p+".deploy", "not a mapping")
	}
	for _, k := range sortedKeys(d) {
		switch k {
		case "resources":
			res, _ := d[k].(map[string]any)
			for _, rk := range sortedKeys(res) {
				m, _ := res[rk].(map[string]any)
				for _, mk := range sortedKeys(m) {
					if mk != "cpus" && mk != "memory" && mk != "pids" {
						r.refuse(p+".deploy.resources."+rk+"."+mk, "node devices and generic resources are refused")
					}
				}
				switch rk {
				case "limits":
					readMem(m["memory"], p+".deploy.resources.limits.memory")
					readCPU(m["cpus"], p+".deploy.resources.limits.cpus")
				case "reservations":
				default:
					r.refuse(p+".deploy.resources."+rk, "only limits and reservations")
				}
			}
		case "replicas":
			if n, _ := d[k].(int); n != 1 {
				r.refuse(p+".deploy.replicas", "one pod per service")
			}
		default:
			r.refuse(p+".deploy."+k, "only deploy.resources")
		}
	}
}

func (r *renderer) misc(s *serviceSpec, svc map[string]any, p string) {
	if v, ok := svc["working_dir"].(string); ok {
		if !path.IsAbs(v) {
			r.refuse(p+".working_dir", "not an absolute path")
		}
		s.workingDir = path.Clean(v)
	}
	switch rs, _ := svc["restart"].(string); rs {
	case "", "no":
		s.restart = "Never"
	case "always", "unless-stopped":
		s.restart = "Always"
	default:
		if rs == "on-failure" || strings.HasPrefix(rs, "on-failure:") {
			s.restart = "OnFailure"
		} else {
			r.refuse(p+".restart", fmt.Sprintf("restart %q", rs))
		}
	}
	if b, ok := svc["init"].(bool); ok {
		s.init = b
	}
	if v := svc["stop_grace_period"]; v != nil {
		d, err := duration(v)
		if err != nil {
			r.refuse(p+".stop_grace_period", err.Error())
		} else {
			g := int64(seconds(d, 0))
			s.grace = &g
		}
	}
	if sig, ok := svc["stop_signal"].(string); ok {
		if n := strings.TrimPrefix(strings.ToUpper(sig), "SIG"); n != "TERM" && n != "15" {
			r.refuse(p+".stop_signal", "the kubelet stops a container with SIGTERM")
		}
	}
	if h, ok := svc["hostname"].(string); ok {
		if !dnsLabel.MatchString(h) || len(h) > 63 {
			r.refuse(p+".hostname", fmt.Sprintf("hostname %q is not a DNS label", h))
		}
		s.hostname = h
	}
	switch pl, _ := svc["platform"].(string); pl {
	case "":
	case "linux/amd64":
		s.arch = "amd64"
	case "linux/arm64", "linux/arm64/v8":
		s.arch = "arm64"
	default:
		r.refuse(p+".platform", fmt.Sprintf("platform %q", pl))
	}
	switch n := svc["networks"].(type) {
	case nil, []any:
	case map[string]any:
		for _, name := range sortedKeys(n) {
			m, _ := n[name].(map[string]any)
			for _, k := range sortedKeys(m) {
				switch k {
				case "aliases":
					list, _ := m[k].([]any)
					for _, a := range list {
						al, _ := a.(string)
						if !dnsLabel.MatchString(strings.ToLower(al)) && !validHostname(al) {
							r.refuse(p+".networks."+name+".aliases", fmt.Sprintf("alias %q is not a host name", al))
							continue
						}
						if !slices.Contains(s.aliases, al) {
							s.aliases = append(s.aliases, al)
						}
					}
				default:
					r.refuse(p+".networks."+name+"."+k, "addresses on the claim's network are the cell's")
				}
			}
		}
	default:
		r.refuse(p+".networks", "not a list or a mapping")
	}
}

var hostnameChars = func(r rune) bool {
	return r == '-' || r == '.' || r == '_' || (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9')
}

// validHostname is a name /etc/hosts can hold.
func validHostname(h string) bool {
	if h == "" || len(h) > 253 {
		return false
	}
	for _, c := range h {
		if !hostnameChars(c) {
			return false
		}
	}
	return true
}

// pod writes the service's pod.
func (r *renderer) pod(s *serviceSpec) Service {
	podName := r.o.Prefix + "-" + s.slug
	labels := r.labels(map[string]string{ServiceLabel: s.slug})
	ann := maps.Clone(r.o.Annotations)
	if ann == nil {
		ann = map[string]string{}
	}
	ann["kodus.io/compose-service"] = s.name
	limits := map[string]any{"memory": fmt.Sprintf("%dMi", s.memMB), "cpu": fmt.Sprintf("%dm", s.milliCPU)}
	sec := map[string]any{
		"allowPrivilegeEscalation": false, "privileged": false,
		"capabilities": map[string]any{"drop": []any{"ALL"}},
	}
	if len(s.caps) > 0 {
		sec["capabilities"].(map[string]any)["add"] = toList(s.caps)
	}
	if s.readOnly {
		sec["readOnlyRootFilesystem"] = true
	}
	if s.user != nil {
		sec["runAsUser"] = *s.user
		if *s.user != 0 {
			sec["runAsNonRoot"] = true
		}
	}
	if s.group != nil {
		sec["runAsGroup"] = *s.group
	}
	c := map[string]any{
		"name": s.slug, "image": s.image,
		"securityContext": sec,
		"resources":       map[string]any{"limits": limits, "requests": limits},
	}
	if s.pullPolicy != "" {
		c["imagePullPolicy"] = s.pullPolicy
	}
	if s.hasCommand {
		c["command"] = literalList(s.command)
	}
	if s.hasArgs {
		c["args"] = literalList(s.args)
	}
	if s.workingDir != "" {
		c["workingDir"] = s.workingDir
	}
	if len(s.env) > 0 {
		var env []any
		for _, k := range sortedKeys(s.env) {
			env = append(env, map[string]any{"name": k, "value": kubeLiteral(s.env[k])})
		}
		c["env"] = env
	}
	if len(s.ports) > 0 {
		var ports []any
		for _, n := range s.ports {
			ports = append(ports, map[string]any{"containerPort": n})
		}
		c["ports"] = ports
	}
	if s.probe != nil {
		c["readinessProbe"] = s.probe
	}

	volumes := []any{
		map[string]any{"name": "kodus-gate", "emptyDir": map[string]any{"medium": "Memory", "sizeLimit": "1Mi"}},
		map[string]any{"name": "kodus-hosts", "emptyDir": map[string]any{"medium": "Memory", "sizeLimit": "1Mi"}},
	}
	mounts := []any{map[string]any{"name": "kodus-hosts", "mountPath": "/etc/hosts", "subPath": "hosts", "readOnly": true}}
	if r.o.Decoy {
		mounts = append(mounts, map[string]any{"name": "kodus-hosts", "mountPath": sandbox.DecoyTarget, "subPath": "npmrc", "readOnly": true})
	}
	initMounts := []any{
		map[string]any{"name": "kodus-gate", "mountPath": GateDir},
		map[string]any{"name": "kodus-hosts", "mountPath": HostsDir},
	}
	out := Service{Name: s.name, PodName: podName, Container: s.slug, Wave: s.wave, DependsOn: s.deps, Hostname: s.hostname,
		Healthcheck: s.probe != nil, WorkingDir: s.workingDir}
	out.Hostnames = append([]string{s.name}, s.aliases...)
	claimVol := map[string]string{}
	for _, m := range s.named {
		vn, ok := claimVol[m.key]
		if !ok {
			vn = fmt.Sprintf("data-%d", len(claimVol))
			claimVol[m.key] = vn
			volumes = append(volumes, map[string]any{"name": vn, "persistentVolumeClaim": map[string]any{"claimName": r.claimName(m.key)}})
			initMounts = append(initMounts, map[string]any{"name": vn, "mountPath": DataDir + "/" + vn})
			out.Data = append(out.Data, DataMount{Volume: m.key, Claim: r.claimName(m.key), Dir: vn, Target: m.target})
		}
		mt := map[string]any{"name": vn, "mountPath": m.target}
		if m.subPath != "" {
			mt["subPath"] = m.subPath
		}
		if m.readOnly {
			mt["readOnly"] = true
		}
		mounts = append(mounts, mt)
	}
	for i, t := range s.anon {
		vn := fmt.Sprintf("anon-%d", i)
		volumes = append(volumes, map[string]any{"name": vn, "emptyDir": map[string]any{}})
		mounts = append(mounts, map[string]any{"name": vn, "mountPath": t})
	}
	for i, t := range s.tmpfs {
		vn := fmt.Sprintf("tmpfs-%d", i)
		ed := map[string]any{"medium": "Memory"}
		if t.sizeMB > 0 {
			ed["sizeLimit"] = fmt.Sprintf("%dMi", t.sizeMB)
		}
		volumes = append(volumes, map[string]any{"name": vn, "emptyDir": ed})
		mounts = append(mounts, map[string]any{"name": vn, "mountPath": t.target})
	}
	if s.shmMB > 0 {
		volumes = append(volumes, map[string]any{"name": "shm", "emptyDir": map[string]any{"medium": "Memory", "sizeLimit": fmt.Sprintf("%dMi", s.shmMB)}})
		mounts = append(mounts, map[string]any{"name": "shm", "mountPath": "/dev/shm"})
	}
	for _, cp := range s.copies {
		volumes = append(volumes, map[string]any{"name": cp.Dir, "emptyDir": map[string]any{"sizeLimit": "64Mi"}})
		initMounts = append(initMounts, map[string]any{"name": cp.Dir, "mountPath": CopyDir + "/" + cp.Dir})
		mt := map[string]any{"name": cp.Dir, "mountPath": cp.Target, "readOnly": true}
		if cp.File {
			mt["subPath"] = path.Base(cp.Source)
		}
		mounts = append(mounts, mt)
		out.Copies = append(out.Copies, cp)
	}
	c["volumeMounts"] = mounts

	small := map[string]any{"cpu": "100m", "memory": "64Mi"}
	initC := map[string]any{
		"name": InitContainer, "image": r.o.HelperImage, "imagePullPolicy": "IfNotPresent",
		"command": []any{"/bin/sh", "-c", GateWait},
		// Root in the pod's sandbox, with only what tar needs to keep the
		// data's owners and modes (a database's files are its user's).
		"securityContext": map[string]any{
			"allowPrivilegeEscalation": false, "privileged": false, "runAsUser": 0,
			"capabilities": map[string]any{"drop": []any{"ALL"}, "add": []any{"CHOWN", "DAC_OVERRIDE", "FOWNER", "FSETID"}},
		},
		"resources":    map[string]any{"limits": small, "requests": small},
		"volumeMounts": initMounts,
	}
	spec := map[string]any{
		"runtimeClassName":             r.o.RuntimeClass,
		"automountServiceAccountToken": false,
		"enableServiceLinks":           false,
		"hostNetwork":                  false, "hostPID": false, "hostIPC": false,
		"restartPolicy":         s.restart,
		"activeDeadlineSeconds": r.o.DeadlineSeconds,
		"dnsPolicy":             "None",
		"dnsConfig":             map[string]any{"nameservers": toList(r.o.Nameservers)},
		"securityContext":       map[string]any{"seccompProfile": map[string]any{"type": "RuntimeDefault"}},
		"initContainers":        []any{initC},
		"containers":            []any{c},
		"volumes":               volumes,
	}
	spec["terminationGracePeriodSeconds"] = int64(DefaultStopGrace)
	if s.grace != nil {
		spec["terminationGracePeriodSeconds"] = *s.grace
	}
	if s.hostname != "" {
		spec["hostname"] = s.hostname
	}
	if s.init {
		// The pod's pause process is PID 1 and reaps orphans, as compose's init.
		spec["shareProcessNamespace"] = true
	}
	if s.arch != "" {
		spec["nodeSelector"] = map[string]any{"kubernetes.io/arch": s.arch}
	}
	out.Pod = Object{"apiVersion": "v1", "kind": "Pod", "metadata": r.meta(podName, labels, ann), "spec": spec}
	return out
}

func literalList(s []string) []any {
	out := make([]any, len(s))
	for i, v := range s {
		out[i] = kubeLiteral(v)
	}
	return out
}

// HostsFile is the /etc/hosts of a pod of the plan: localhost, the pod's
// own name, and every service's names at its pod's address (addrs, by
// service).
func (p *Plan) HostsFile(self Service, addrs map[string]string) []byte {
	var b strings.Builder
	b.WriteString("127.0.0.1\tlocalhost\n::1\tlocalhost ip6-localhost ip6-loopback\n")
	if ip := addrs[self.Name]; ip != "" && self.Hostname != "" {
		fmt.Fprintf(&b, "%s\t%s\n", ip, self.Hostname)
	}
	for _, s := range p.Services {
		if ip := addrs[s.Name]; ip != "" {
			fmt.Fprintf(&b, "%s\t%s\n", ip, strings.Join(s.Hostnames, " "))
		}
	}
	return []byte(b.String())
}
