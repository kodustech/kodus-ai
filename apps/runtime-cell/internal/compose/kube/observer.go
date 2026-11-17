package kube

import (
	"errors"
	"fmt"
	"maps"
)

// The claim's observer pod (docs/runtime/kubernetes-environment-runs.md,
// "The observer"): cmd/observer in a pod of its own on the claim's
// RuntimeClass in the environment namespace, not a sidecar (it would share a
// service's network namespace) and not in the cell's namespace. It serves the
// cell's mTLS on loopback only; the cell reaches it through pods/exec, where
// ObserverBridge carries one connection over the exec's stdin and stdout. Its
// NetworkPolicy lets it reach the claim's service pods and nothing reach it;
// the claim's policy admits it (policy).

// ObserverRole is the observer pod's role label value (driver.RoleObserver).
const ObserverRole = "observer"

// The observer pod's container, the user it runs as (the cell image's
// distroless nonroot), and where it finds what the cell copies in.
const (
	ObserverContainer = "observer"
	ObserverUID       = 65532
	// ObserverTLSDir is the gate's copy directory (InitScript copy) of the
	// observer's server certificate, key and the CA of the cell's client
	// certificate; ObserverTLSMount is where the observer reads them.
	ObserverTLSDir   = "tls"
	ObserverTLSMount = "/etc/kodus/observer"
	// ObserverListen is the observer's address: loopback, reached only
	// through ObserverBridge.
	ObserverListen = "127.0.0.1:7443"
	// ObserverBinary is cmd/observer in the observer image, where the cell
	// image keeps it: the cell image serves as the observer image.
	ObserverBinary = "/usr/local/bin/observer"
)

// ObserverBridge is what the cell runs in the observer container over
// pods/exec for one connection: stdin and stdout carried to ObserverListen.
var ObserverBridge = []string{ObserverBinary, "-stdio-bridge", ObserverListen}

// Share is part of the claim's size, in MiB and thousandths of a CPU.
type Share struct {
	MemoryMB int
	MilliCPU int
}

// ObserverSpec is the claim's observer: its image (cmd/observer at
// ObserverBinary, by digest), the cell it answers, and its share of the
// claim's size (requests equal limits).
type ObserverSpec struct {
	Image    string
	CellID   string
	MemoryMB int
	MilliCPU int
}

// Observer is the claim's observer pod.
type Observer struct {
	PodName string
	Pod     Object
}

// ObserverPodName is the claim's observer pod, Prefix--observer (no service
// slug starts with a dash).
func ObserverPodName(prefix string) string { return prefix + "--observer" }

// ObserverPod is the claim's observer: the claim's labels in the observer's
// role, its RuntimeClass, no token, no host namespace, RuntimeDefault seccomp,
// the observer non-root on a read-only root with every capability dropped,
// its own share of the claim's size and the claim's deadline. The gate init
// container holds it until the cell copied its TLS files in (InitScript copy
// ObserverTLSDir) and opened it. It resolves no name: its targets are
// addresses, and its only nameserver is its own loopback.
func ObserverPod(o Options, s ObserverSpec) (Observer, error) {
	if err := o.checkPlacement(); err != nil {
		return Observer{}, err
	}
	if s.Image == "" || s.CellID == "" || s.MemoryMB <= 0 || s.MilliCPU <= 0 {
		return Observer{}, errors.New("kube: an observer needs its image, its cell and its size")
	}
	if o.Labels[RoleLabel] == "" {
		return Observer{}, errors.New("kube: an observer needs the services' role among the labels (its policy selects them by it)")
	}
	r := &renderer{o: o}
	name := ObserverPodName(o.Prefix)
	ann := maps.Clone(o.Annotations)
	limits := map[string]any{"memory": fmt.Sprintf("%dMi", s.MemoryMB), "cpu": fmt.Sprintf("%dm", s.MilliCPU)}
	small := map[string]any{"cpu": "100m", "memory": "64Mi"}
	tlsCopy := CopyDir + "/" + ObserverTLSDir
	initC := map[string]any{
		"name": InitContainer, "image": o.HelperImage, "imagePullPolicy": "IfNotPresent",
		"command": []any{"/bin/sh", "-c", GateWait},
		// Root in the pod's sandbox, with what tar needs to give the files
		// to the observer's user.
		"securityContext": map[string]any{
			"allowPrivilegeEscalation": false, "privileged": false, "runAsUser": 0,
			"capabilities": map[string]any{"drop": []any{"ALL"}, "add": []any{"CHOWN", "DAC_OVERRIDE", "FOWNER", "FSETID"}},
		},
		"resources": map[string]any{"limits": small, "requests": small},
		"volumeMounts": []any{
			map[string]any{"name": "kodus-gate", "mountPath": GateDir},
			map[string]any{"name": ObserverTLSDir, "mountPath": tlsCopy},
		},
	}
	c := map[string]any{
		"name": ObserverContainer, "image": s.Image, "imagePullPolicy": "IfNotPresent",
		"command": []any{
			ObserverBinary, "-listen", ObserverListen, "-cell-id", s.CellID,
			"-cert", ObserverTLSMount + "/cert.pem", "-key", ObserverTLSMount + "/key.pem", "-ca", ObserverTLSMount + "/ca.pem",
		},
		"securityContext": map[string]any{
			"allowPrivilegeEscalation": false, "privileged": false, "readOnlyRootFilesystem": true,
			"runAsNonRoot": true, "runAsUser": int64(ObserverUID), "runAsGroup": int64(ObserverUID),
			"capabilities": map[string]any{"drop": []any{"ALL"}},
		},
		"resources":    map[string]any{"limits": limits, "requests": limits},
		"volumeMounts": []any{map[string]any{"name": ObserverTLSDir, "mountPath": ObserverTLSMount, "readOnly": true}},
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
		"dnsConfig":                     map[string]any{"nameservers": []any{"127.0.0.1"}},
		"securityContext": map[string]any{
			"seccompProfile": map[string]any{"type": "RuntimeDefault"}, "fsGroup": int64(ObserverUID),
		},
		"initContainers": []any{initC},
		"containers":     []any{c},
		"volumes": []any{
			map[string]any{"name": "kodus-gate", "emptyDir": map[string]any{"medium": "Memory", "sizeLimit": "1Mi"}},
			map[string]any{"name": ObserverTLSDir, "emptyDir": map[string]any{"medium": "Memory", "sizeLimit": "1Mi"}},
		},
	}
	labels := r.labels(map[string]string{RoleLabel: ObserverRole})
	return Observer{PodName: name, Pod: Object{"apiVersion": "v1", "kind": "Pod", "metadata": r.meta(name, labels, ann), "spec": spec}}, nil
}

// ObserverPolicy is the observer pod's NetworkPolicy: no ingress (the cell
// comes through pods/exec, which no policy sees), egress to the claim's
// service pods on any port and to nothing else, no resolver among them.
func ObserverPolicy(o Options) Object {
	r := &renderer{o: o}
	return Object{
		"apiVersion": "networking.k8s.io/v1", "kind": "NetworkPolicy",
		"metadata": r.meta(ObserverPodName(o.Prefix), r.labels(map[string]string{RoleLabel: ObserverRole}), nil),
		"spec": map[string]any{
			"podSelector": o.observerSelector(),
			"policyTypes": []any{"Ingress", "Egress"},
			"egress":      []any{map[string]any{"to": []any{map[string]any{"podSelector": o.servicesSelector()}}}},
		},
	}
}

// observerSelector selects the claim's observer pod.
func (o Options) observerSelector() map[string]any {
	ml := toAny(o.Selector)
	ml[RoleLabel] = ObserverRole
	return map[string]any{"matchLabels": ml}
}

// servicesSelector selects the claim's service pods (its labels' role).
func (o Options) servicesSelector() map[string]any {
	ml := toAny(o.Selector)
	if role := o.Labels[RoleLabel]; role != "" {
		ml[RoleLabel] = role
	}
	return map[string]any{"matchLabels": ml}
}

// claimSelector selects the claim's pods but its observer: the services and
// the builders.
func (o Options) claimSelector() map[string]any {
	return map[string]any{
		"matchLabels":      toAny(o.Selector),
		"matchExpressions": []any{map[string]any{"key": RoleLabel, "operator": "NotIn", "values": []any{ObserverRole}}},
	}
}

// share is the claim's size less what Reserved keeps for the observer.
func (o Options) share() (memMB, milliCPU int) {
	return o.Size.MemoryMB - o.Reserved.MemoryMB, o.Size.CPUs*1000 - o.Reserved.MilliCPU
}

// reservedNote names the observer's share in a refusal of the services'
// size, when there is one.
func (o Options) reservedNote() string {
	if o.Reserved == (Share{}) {
		return ""
	}
	return fmt.Sprintf(" beside its observer's %d MB and %d mCPU", o.Reserved.MemoryMB, o.Reserved.MilliCPU)
}
