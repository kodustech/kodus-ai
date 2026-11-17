package kube

import (
	"errors"
	"fmt"
	"maps"
)

// The image builder's pod (docs/runtime/kubernetes-environment-runs.md,
// "Image builds"): rootless BuildKit on the claim's RuntimeClass in the
// environment namespace, the shape of BuildKit's own
// examples/kubernetes/pod.rootless.yaml. Rootless BuildKit makes user
// namespaces and mounts, which RuntimeDefault seccomp and AppArmor refuse,
// so its one container runs Unconfined, as uid 1000, unprivileged, with no
// capability added; the environment gate (k8ssandbox EnvGateValidations)
// lets that container, and no other, run so.

// RoleLabel names a pod's role; BuilderRole is the builder pod's value
// (a service pod's is the claim's, workload).
const (
	RoleLabel   = "kodus.io/role"
	BuilderRole = "builder"
)

// BuilderContainer is the builder pod's BuildKit container, and BuilderUID
// the user it runs as (the rootless image's own; another needs another
// image).
const (
	BuilderContainer = "buildkitd"
	BuilderUID       = 1000
)

// Where the builder pod's init container unpacks what the cell copies in
// (InitScript copy <dir>): the build's context, and BuildKit's config.
const (
	BuildContextDir = "context"
	BuildConfigDir  = "buildkit"
)

// Where the buildkitd container sees them, and BuildKit's state.
const (
	BuildContextMount = "/kodus/context"
	BuildConfigMount  = "/kodus/buildkit"
	BuildConfigFile   = BuildConfigMount + "/buildkitd.toml"
	BuildStateMount   = "/home/user/.local/share/buildkit"
)

// BuildPod is one service's build: its builder image, the bound of
// BuildKit's state on the node's disk and of the context's copy.
type BuildPod struct {
	Service string
	Image   string
	// Storage bounds BuildKit's state ("10Gi" when empty), ContextSize the
	// context's copy ("1Gi" when empty).
	Storage, ContextSize string
}

// ServiceSlug is a service's name as the plan's object names carry it (a
// DNS label of at most 40 bytes).
func ServiceSlug(name string) string { return slug(name, 40) }

// Builder is a service's builder pod.
type Builder struct {
	PodName string
	Pod     Object
}

func (o Options) builderLabels(service string) map[string]any {
	r := &renderer{o: o}
	extra := map[string]string{RoleLabel: BuilderRole}
	if service != "" {
		extra[ServiceLabel] = slug(service, 40)
	}
	return r.labels(extra)
}

// BuilderPod is the pod that builds one service's image (the shape of
// BuildKit's examples/kubernetes/pod.rootless.yaml): rootless buildkitd
// with --oci-worker-no-process-sandbox, Unconfined seccomp and AppArmor as
// uid 1000, unprivileged, no capability added (NET_RAW and AUDIT_WRITE
// dropped, as docker-gvisor's builder), the default /proc; the claim's
// labels with the builder's role, its RuntimeClass, no token, no host
// namespace, the cell's resolver, the claim's deadline and its whole size
// but the observer's share (a build runs before any service, so it has the
// rest of the claim to itself). The
// gate init container holds it until the cell copied the context and the
// config in; the cell then runs buildctl in it over pods/exec.
func BuilderPod(o Options, b BuildPod) (Builder, error) {
	if err := o.check(); err != nil {
		return Builder{}, err
	}
	if b.Service == "" || b.Image == "" {
		return Builder{}, errors.New("kube: a build needs its service and the builder image")
	}
	storage, ctxSize := b.Storage, b.ContextSize
	if storage == "" {
		storage = "10Gi"
	}
	if ctxSize == "" {
		ctxSize = "1Gi"
	}
	r := &renderer{o: o}
	name := o.Prefix + "--build-" + slug(b.Service, 40)
	ann := maps.Clone(o.Annotations)
	if ann == nil {
		ann = map[string]string{}
	}
	ann["kodus.io/compose-service"] = b.Service
	mem, cpu := o.share()
	if mem <= 0 || cpu <= 0 {
		return Builder{}, errors.New("kube: the claim's size leaves the builder nothing beside the observer")
	}
	limits := map[string]any{"memory": fmt.Sprintf("%dMi", mem), "cpu": fmt.Sprintf("%dm", cpu)}
	small := map[string]any{"cpu": "100m", "memory": "64Mi"}
	ro := func(vol, at string) map[string]any {
		return map[string]any{"name": vol, "mountPath": at, "readOnly": true}
	}
	initC := map[string]any{
		"name": InitContainer, "image": o.HelperImage, "imagePullPolicy": "IfNotPresent",
		"command": []any{"/bin/sh", "-c", GateWait},
		"securityContext": map[string]any{
			"allowPrivilegeEscalation": false, "privileged": false, "runAsUser": 0,
			"capabilities": map[string]any{"drop": []any{"ALL"}, "add": []any{"CHOWN", "DAC_OVERRIDE", "FOWNER", "FSETID"}},
		},
		"resources": map[string]any{"limits": small, "requests": small},
		"volumeMounts": []any{
			map[string]any{"name": "kodus-gate", "mountPath": GateDir},
			map[string]any{"name": "kodus-hosts", "mountPath": HostsDir},
			map[string]any{"name": BuildContextDir, "mountPath": CopyDir + "/" + BuildContextDir},
			map[string]any{"name": BuildConfigDir, "mountPath": CopyDir + "/" + BuildConfigDir},
		},
	}
	probe := map[string]any{"exec": map[string]any{"command": []any{"buildctl", "debug", "workers"}}, "periodSeconds": 1, "failureThreshold": 3}
	c := map[string]any{
		"name": BuilderContainer, "image": b.Image,
		"args": []any{"--oci-worker-no-process-sandbox", "--config", BuildConfigFile},
		// Rootless BuildKit makes user namespaces and mounts: no seccomp or
		// AppArmor profile, which the gate allows this container alone.
		// allowPrivilegeEscalation stays: newuidmap is setuid.
		"securityContext": map[string]any{
			"seccompProfile": map[string]any{"type": "Unconfined"}, "appArmorProfile": map[string]any{"type": "Unconfined"},
			"runAsUser": int64(BuilderUID), "runAsGroup": int64(BuilderUID), "runAsNonRoot": true, "privileged": false,
			"capabilities": map[string]any{"drop": []any{"NET_RAW", "AUDIT_WRITE"}},
		},
		"resources":      map[string]any{"limits": limits, "requests": limits},
		"readinessProbe": probe,
		"volumeMounts": []any{
			map[string]any{"name": "kodus-hosts", "mountPath": "/etc/hosts", "subPath": "hosts", "readOnly": true},
			ro(BuildContextDir, BuildContextMount),
			ro(BuildConfigDir, BuildConfigMount),
			map[string]any{"name": "buildkitd", "mountPath": BuildStateMount},
		},
	}
	spec := map[string]any{
		"runtimeClassName":             o.RuntimeClass,
		"automountServiceAccountToken": false,
		"enableServiceLinks":           false,
		"hostNetwork":                  false, "hostPID": false, "hostIPC": false,
		"restartPolicy":                 "Never",
		"activeDeadlineSeconds":         o.DeadlineSeconds,
		"terminationGracePeriodSeconds": int64(5),
		"dnsPolicy":                     "None",
		"dnsConfig":                     map[string]any{"nameservers": toList(o.Nameservers)},
		"securityContext":               map[string]any{"seccompProfile": map[string]any{"type": "RuntimeDefault"}},
		"initContainers":                []any{initC},
		"containers":                    []any{c},
		"volumes": []any{
			map[string]any{"name": "kodus-gate", "emptyDir": map[string]any{"medium": "Memory", "sizeLimit": "1Mi"}},
			map[string]any{"name": "kodus-hosts", "emptyDir": map[string]any{"medium": "Memory", "sizeLimit": "1Mi"}},
			map[string]any{"name": BuildContextDir, "emptyDir": map[string]any{"sizeLimit": ctxSize}},
			map[string]any{"name": BuildConfigDir, "emptyDir": map[string]any{"medium": "Memory", "sizeLimit": "1Mi"}},
			map[string]any{"name": "buildkitd", "emptyDir": map[string]any{"sizeLimit": storage}},
		},
	}
	return Builder{PodName: name, Pod: Object{"apiVersion": "v1", "kind": "Pod", "metadata": r.meta(name, o.builderLabels(b.Service), ann), "spec": spec}}, nil
}

// BuildPolicy is the NetworkPolicy the claim's builder pods get besides the
// claim's own (policies add up): egress to peers, the registry it pushes to
// and the mirror it pulls through. Nil without peers.
func BuildPolicy(o Options, peers []EgressPeer) Object {
	if len(peers) == 0 {
		return nil
	}
	r := &renderer{o: o}
	sel := toAny(o.Selector)
	sel[RoleLabel] = BuilderRole
	var egress []any
	for _, p := range peers {
		egress = append(egress, egressRule(p))
	}
	return Object{
		"apiVersion": "networking.k8s.io/v1", "kind": "NetworkPolicy",
		"metadata": r.meta(o.Prefix+"--build", o.builderLabels(""), nil),
		"spec": map[string]any{
			"podSelector": map[string]any{"matchLabels": sel},
			"policyTypes": []any{"Egress"},
			"egress":      egress,
		},
	}
}
