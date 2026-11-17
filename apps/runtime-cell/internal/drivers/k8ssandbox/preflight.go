package k8ssandbox

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
)

// Preflight proves, before the cell takes work, that the sandbox namespace
// enforces what the driver relies on: what the cluster does, not what it
// has installed (docs/runtime/kubernetes.md decision 4).
//
//  1. A privileged pod with a hostPath volume and no RuntimeClass is refused
//     by admission (dry run: nothing is created).
//  2. A pod as the driver makes them, on the RuntimeClass, is admitted (dry
//     run); an absent RuntimeClass is refused here, by its name.
//  3. A probe pod on the RuntimeClass reports its kernel and dials an
//     address the namespace's NetworkPolicies must refuse (the API server).
//     Under gVisor the kernel names gvisor; the dial must not connect.
//
// With EnvNamespace, 1 and 2 run there too, before 3 (envGate).
type Preflight struct {
	Kube         KubeAPI
	CellID       string
	Namespace    string
	RuntimeClass string
	// ProbeImage carries `cell probe` (the cell image, by digest).
	ProbeImage string
	// DialTarget is host:port the probe must not reach (the API server's).
	DialTarget string
	// KernelMustContain is what the probe's kernel release names under the
	// RuntimeClass (gvisor); empty: not checked (Kata, another runtime).
	KernelMustContain string
	// ResolverIP is the probe's DNS, as for every claim pod.
	ResolverIP string
	// EnvNamespace, set, is the cell's environment namespace (environment
	// Runs on): before the probe, a privileged pod with a hostPath there
	// must be refused by the environment gate by name (EnvGatePolicy, the
	// ValidatingAdmissionPolicy and its binding in force: Pod Security
	// privileged admits it), and a pod as the driver makes them there must
	// be admitted (the RuntimeClass in the gate's set, the cell's Role
	// creates pods there). Both dry run: nothing is created.
	EnvNamespace string
	Timeout      time.Duration
	Poll         time.Duration
}

// ProbeResult is what `cell probe` writes to its termination message.
type ProbeResult struct {
	Kernel string `json:"kernel"`
	// Dial is connected, refused or timeout.
	Dial   string `json:"dial"`
	Target string `json:"target"`
}

// PreflightReport is what the preflight saw, for the cell's log.
type PreflightReport struct {
	PrivilegedRefused string
	// EnvGateRefused is the environment gate's refusal (EnvNamespace set).
	EnvGateRefused string
	Kernel         string
	Dial           string
}

// Preflight failures, each naming what to fix.
var (
	ErrAdmitsPrivileged  = errors.New("k8ssandbox: the sandbox namespace admits a privileged pod with a hostPath volume: label it pod-security.kubernetes.io/enforce=restricted (the chart does) or install the chart's admission policy")
	ErrRuntimeClass      = errors.New("k8ssandbox: a claim pod on the RuntimeClass is refused")
	ErrNotSandboxed      = errors.New("k8ssandbox: the probe pod does not run under the isolated runtime")
	ErrPoliciesDecorated = errors.New("k8ssandbox: the probe pod reached the API server: the namespace's NetworkPolicies are not enforced (a CNI that enforces NetworkPolicy is required)")
	ErrEnvGateMissing    = errors.New("k8ssandbox: the environment namespace does not refuse a privileged pod with a hostPath by the environment gate: apply deploy/kubernetes/environment-namespace.yaml (the ValidatingAdmissionPolicy " + EnvGatePolicy + " and its binding)")
	ErrEnvPodRefused     = errors.New("k8ssandbox: an environment pod as the driver makes them is refused in the environment namespace (the RuntimeClass outside the gate's set, or the cell's Role there missing)")
)

func randomSuffix() string {
	var b [4]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

func (p Preflight) labels() map[string]any {
	return map[string]any{label(driver.TagCell): p.CellID, label(driver.TagRole): "preflight"}
}

// privilegedPod is what nothing in the namespace may run.
func (p Preflight) privilegedPod() Object {
	return Object{
		"apiVersion": "v1", "kind": "Pod",
		"metadata": map[string]any{"name": "kodus-preflight-privileged-" + randomSuffix(), "namespace": p.Namespace, "labels": p.labels()},
		"spec": map[string]any{
			"hostPID": true,
			"volumes": []any{map[string]any{"name": "host", "hostPath": map[string]any{"path": "/"}}},
			"containers": []any{map[string]any{
				"name": "c", "image": p.ProbeImage,
				"securityContext": map[string]any{"privileged": true},
				"volumeMounts":    []any{map[string]any{"name": "host", "mountPath": "/host"}},
				"resources":       map[string]any{"limits": map[string]any{"cpu": "100m", "memory": "64Mi"}},
			}},
		},
	}
}

// probePod is a claim pod in all but its command: restricted, on the
// RuntimeClass, no token, its DNS the resolver.
func (p Preflight) probePod(name string) Object {
	limits := map[string]any{"cpu": "100m", "memory": "64Mi"}
	return Object{
		"apiVersion": "v1", "kind": "Pod",
		"metadata": map[string]any{"name": name, "namespace": p.Namespace, "labels": p.labels()},
		"spec": map[string]any{
			"runtimeClassName":             p.RuntimeClass,
			"automountServiceAccountToken": false,
			"enableServiceLinks":           false,
			"restartPolicy":                "Never",
			"activeDeadlineSeconds":        int64(max(p.Timeout.Seconds(), 60)),
			"dnsPolicy":                    "None",
			"dnsConfig":                    map[string]any{"nameservers": []any{p.ResolverIP}},
			"securityContext":              map[string]any{"runAsNonRoot": true, "runAsUser": 65532, "runAsGroup": 65532, "seccompProfile": map[string]any{"type": "RuntimeDefault"}},
			"containers": []any{map[string]any{
				"name": "probe", "image": p.ProbeImage, "imagePullPolicy": "IfNotPresent",
				"command": []any{"/usr/local/bin/cell", "probe", "-dial", p.DialTarget, "-timeout", "3s"},
				"securityContext": map[string]any{
					"allowPrivilegeEscalation": false, "readOnlyRootFilesystem": true, "runAsNonRoot": true,
					"capabilities": map[string]any{"drop": []any{"ALL"}},
				},
				"resources": map[string]any{"limits": limits, "requests": limits},
			}},
		},
	}
}

// Run runs the three checks in order and stops at the first that fails.
func (p Preflight) Run(ctx context.Context) (PreflightReport, error) {
	var rep PreflightReport
	if p.Timeout == 0 {
		p.Timeout = 3 * time.Minute
	}
	if p.Poll == 0 {
		p.Poll = time.Second
	}
	_, err := p.Kube.CreatePod(ctx, p.Namespace, p.privilegedPod(), true)
	var apiErr *APIError
	switch {
	case err == nil:
		return rep, ErrAdmitsPrivileged
	case errors.As(err, &apiErr) && apiErr.Refused():
		rep.PrivilegedRefused = apiErr.Message
	default:
		return rep, fmt.Errorf("k8ssandbox: preflight: %w", err)
	}
	if p.EnvNamespace != "" {
		refused, err := p.envGate(ctx)
		if err != nil {
			return rep, err
		}
		rep.EnvGateRefused = refused
	}
	name := "kodus-preflight-" + randomSuffix()
	pod := p.probePod(name)
	if _, err := p.Kube.CreatePod(ctx, p.Namespace, pod, true); err != nil {
		return rep, fmt.Errorf("%w (%s): %w", ErrRuntimeClass, p.RuntimeClass, err)
	}
	if _, err := p.Kube.CreatePod(ctx, p.Namespace, pod, false); err != nil {
		return rep, fmt.Errorf("%w (%s): %w", ErrRuntimeClass, p.RuntimeClass, err)
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
		defer cancel()
		_ = p.Kube.DeletePod(cleanup, p.Namespace, name)
	}()
	res, err := p.waitProbe(ctx, name)
	if err != nil {
		return rep, err
	}
	rep.Kernel, rep.Dial = res.Kernel, res.Dial
	if p.KernelMustContain != "" && !strings.Contains(strings.ToLower(res.Kernel), p.KernelMustContain) {
		return rep, fmt.Errorf("%w: kernel %q does not name %s", ErrNotSandboxed, res.Kernel, p.KernelMustContain)
	}
	if res.Dial == "connected" {
		return rep, fmt.Errorf("%w: %s", ErrPoliciesDecorated, res.Target)
	}
	return rep, nil
}

// envGate is check 1 and 2 in the environment namespace, where Pod Security
// is privileged and only the gate refuses: a refusal that does not name the
// gate (RBAC's, say) proves nothing of it.
func (p Preflight) envGate(ctx context.Context) (string, error) {
	in := func(o Object) Object {
		o["metadata"].(map[string]any)["namespace"] = p.EnvNamespace
		return o
	}
	_, err := p.Kube.CreatePod(ctx, p.EnvNamespace, in(p.privilegedPod()), true)
	var apiErr *APIError
	switch {
	case err == nil:
		return "", ErrEnvGateMissing
	case errors.As(err, &apiErr) && apiErr.Refused() && strings.Contains(apiErr.Message, EnvGatePolicy):
	case errors.As(err, &apiErr) && apiErr.Refused():
		return "", fmt.Errorf("%w: refused otherwise: %s", ErrEnvGateMissing, apiErr.Message)
	default:
		return "", fmt.Errorf("k8ssandbox: preflight: %w", err)
	}
	refused := apiErr.Message
	if _, err := p.Kube.CreatePod(ctx, p.EnvNamespace, in(p.probePod("kodus-preflight-env-"+randomSuffix())), true); err != nil {
		return "", fmt.Errorf("%w (%s): %w", ErrEnvPodRefused, p.RuntimeClass, err)
	}
	return refused, nil
}

// waitProbe waits for the probe pod to end and reads its result.
func (p Preflight) waitProbe(ctx context.Context, name string) (ProbeResult, error) {
	ctx, cancel := context.WithTimeout(ctx, p.Timeout)
	defer cancel()
	last := "Pending"
	for {
		pod, err := p.Kube.GetPod(ctx, p.Namespace, name)
		if err != nil && ctx.Err() == nil {
			return ProbeResult{}, err
		}
		st := podStatus(pod)
		if msg, code, ok := terminated(pod); ok {
			var res ProbeResult
			if code != 0 || json.Unmarshal([]byte(msg), &res) != nil || res.Dial == "" {
				return ProbeResult{}, fmt.Errorf("%w: the probe pod ended with code %d: %q", ErrNotSandboxed, code, msg)
			}
			return res, nil
		}
		if st.phase == "Failed" {
			return ProbeResult{}, fmt.Errorf("%w (%s): the probe pod failed: %s", ErrRuntimeClass, p.RuntimeClass, st.why)
		}
		if st.why != "" {
			last = st.why
		}
		select {
		case <-ctx.Done():
			return ProbeResult{}, fmt.Errorf("%w (%s): the probe pod did not finish in %s: %s", ErrRuntimeClass, p.RuntimeClass, p.Timeout, last)
		case <-time.After(p.Poll):
		}
	}
}

// terminated is the probe container's termination message and exit code
// once it ended.
func terminated(pod Object) (string, int, bool) {
	st, _ := pod["status"].(map[string]any)
	cs, _ := st["containerStatuses"].([]any)
	for _, c := range cs {
		cm, _ := c.(map[string]any)
		state, _ := cm["state"].(map[string]any)
		t, ok := state["terminated"].(map[string]any)
		if !ok {
			continue
		}
		code := 0
		if f, ok := t["exitCode"].(float64); ok {
			code = int(f)
		}
		return str(t["message"]), code, true
	}
	return "", 0, false
}
