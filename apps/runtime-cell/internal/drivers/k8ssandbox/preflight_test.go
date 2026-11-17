package k8ssandbox

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// restrictedNamespace admits only what Pod Security restricted and the
// chart's policy do: no privileged pod, no hostPath, the RuntimeClass.
func restrictedNamespace(runtimeClass string) func(Object, bool) (int, string) {
	return func(pod Object, _ bool) (int, string) {
		spec := pod["spec"].(map[string]any)
		if _, ok := spec["volumes"]; ok && strings.Contains(strings.ToLower(jsonOf(spec["volumes"])), "hostpath") {
			return 403, `violates PodSecurity "restricted:latest": hostPath volumes`
		}
		if spec["runtimeClassName"] != runtimeClass {
			return 403, `pod rejected: RuntimeClass "` + str(spec["runtimeClassName"]) + `" not found`
		}
		return 0, ""
	}
}

func jsonOf(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

// probeKubelet ends the probe pod with what `cell probe` would write.
func probeKubelet(result string) func(Object) map[string]any {
	return func(Object) map[string]any {
		return map[string]any{"phase": "Succeeded", "containerStatuses": []any{map[string]any{"state": map[string]any{
			"terminated": map[string]any{"exitCode": float64(0), "message": result},
		}}}}
	}
}

func preflight(api *apiServer, t *testing.T) Preflight {
	return Preflight{
		Kube: api.client(t), CellID: "cell-1", Namespace: sandboxNS, RuntimeClass: "gvisor", ProbeImage: "kodus/cell@sha256:c",
		DialTarget: "10.96.0.1:443", KernelMustContain: "gvisor", ResolverIP: "10.96.0.53", Timeout: time.Second, Poll: time.Millisecond,
	}
}

// A cluster that refuses a privileged pod, runs the probe under gVisor and
// drops its dial to the API server passes, whatever CNI enforces the
// policies: the cell asks no CRD (the old check passed any cluster with one
// of four CNI CRDs, enforcing or not, and refused any other).
func TestPreflightPassesWhatTheClusterEnforces(t *testing.T) {
	api := newAPIServer()
	api.admit = restrictedNamespace("gvisor")
	api.kubelet = probeKubelet(`{"kernel":"4.19.0-gvisor","dial":"timeout","target":"10.96.0.1:443"}`)
	rep, err := preflight(api, t).Run(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if rep.Kernel != "4.19.0-gvisor" || rep.Dial != "timeout" || !strings.Contains(rep.PrivilegedRefused, "restricted") {
		t.Fatalf("%+v", rep)
	}
	if api.count() != 0 {
		t.Fatalf("the preflight left %d pods", api.count())
	}
}

// The preflight refuses a cluster that does not enforce what a sandbox needs,
// names why, and leaves no pod behind.
func TestPreflightRefuses(t *testing.T) {
	cases := []struct {
		name         string
		runtimeClass string // the one the namespace admits; empty admits everything
		probe        string
		want         error
		msg          string
	}{
		{
			name: "a namespace that admits a privileged pod with a hostPath is refused before any pod is made",
			want: ErrAdmitsPrivileged,
		},
		{
			name:         "an absent RuntimeClass is named before a pod waits on it",
			runtimeClass: "kata",
			want:         ErrRuntimeClass,
			msg:          `RuntimeClass "gvisor" not found`,
		},
		{
			// A RuntimeClass whose handler is plain runc.
			name:         "a probe that runs on the node's kernel is refused",
			runtimeClass: "gvisor",
			probe:        `{"kernel":"6.8.0-1015-aws","dial":"timeout","target":"10.96.0.1:443"}`,
			want:         ErrNotSandboxed,
		},
		{
			// kind's default CNI does this (a default-deny pod still reaches the
			// API server and the internet), and the old CRD check would have
			// passed it had a Calico CRD been left in the cluster.
			name:         "a probe that reaches the API server means the policies are decorative",
			runtimeClass: "gvisor",
			probe:        `{"kernel":"4.19.0-gvisor","dial":"connected","target":"10.96.0.1:443"}`,
			want:         ErrPoliciesDecorated,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			api := newAPIServer()
			if c.runtimeClass != "" {
				api.admit = restrictedNamespace(c.runtimeClass)
			}
			if c.probe != "" {
				api.kubelet = probeKubelet(c.probe)
			}
			_, err := preflight(api, t).Run(context.Background())
			if !errors.Is(err, c.want) || !strings.Contains(err.Error(), c.msg) {
				t.Fatalf("err = %v, want %v", err, c.want)
			}
			if api.count() != 0 {
				t.Fatalf("the preflight left %d pods", api.count())
			}
		})
	}
}

// The probe tells a connection from a refusal from a drop.
func TestProbeDialOutcome(t *testing.T) {
	ok := func(context.Context, string, string) (net.Conn, error) { c, _ := net.Pipe(); return c, nil }
	refused := func(context.Context, string, string) (net.Conn, error) {
		return nil, &net.OpError{Op: "dial", Err: os.NewSyscallError("connect", syscall.ECONNREFUSED)}
	}
	dropped := func(ctx context.Context, _, _ string) (net.Conn, error) { <-ctx.Done(); return nil, ctx.Err() }
	for want, dial := range map[string]dialFunc{"connected": ok, "refused": refused, "timeout": dropped} {
		if got := dialOutcome("10.96.0.1:443", 10*time.Millisecond, dial); got != want {
			t.Errorf("dialOutcome = %s, want %s", got, want)
		}
	}
}

// `cell probe` writes its result as JSON where the kubelet reads the
// termination message.
func TestRunProbeWritesTheResult(t *testing.T) {
	out := filepath.Join(t.TempDir(), "termination-log")
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = l.Close() }()
	var stderr strings.Builder
	if code := RunProbe([]string{"-dial", l.Addr().String(), "-out", out}, &stderr); code != 0 {
		t.Fatalf("code %d: %s", code, stderr.String())
	}
	b, _ := os.ReadFile(out)
	if !strings.Contains(string(b), `"dial":"connected"`) || !strings.Contains(string(b), `"kernel":"`) {
		t.Fatalf("result %s", b)
	}
	if code := RunProbe(nil, &stderr); code != 2 {
		t.Fatal("no -dial is a usage error")
	}
}

// envNamespace is the sandbox namespace's admission plus the environment
// namespace's: Pod Security privileged there, so only refuse (the gate, or
// RBAC) says no.
func envNamespace(runtimeClass string, refuse func(Object) (int, string)) func(Object, bool) (int, string) {
	sandbox := restrictedNamespace(runtimeClass)
	return func(pod Object, dry bool) (int, string) {
		if meta(pod)["namespace"] == "kodus-runtime-environments" {
			return refuse(pod)
		}
		return sandbox(pod, dry)
	}
}

// theGate refuses what EnvGateValidations refuses of a preflight pod, as the
// API server words a ValidatingAdmissionPolicy's denial.
func theGate(classes ...string) func(Object) (int, string) {
	return func(pod Object) (int, string) {
		spec := pod["spec"].(map[string]any)
		if strings.Contains(strings.ToLower(jsonOf(spec)), "hostpath") || spec["hostPID"] == true {
			return 403, `pods "x" is forbidden: ValidatingAdmissionPolicy '` + EnvGatePolicy + `' with binding '` + EnvGatePolicy + `' denied request: an environment pod mounts no hostPath`
		}
		for _, c := range classes {
			if spec["runtimeClassName"] == c {
				return 0, ""
			}
		}
		return 403, `ValidatingAdmissionPolicy '` + EnvGatePolicy + `' denied request: an environment pod runs on one of the RuntimeClasses`
	}
}

func TestPreflightWithEnvironmentsProvesTheGateRefusesAndTheDriversPodIsAdmitted(t *testing.T) {
	api := newAPIServer()
	api.admit = envNamespace("gvisor", theGate("gvisor"))
	api.kubelet = probeKubelet(`{"kernel":"4.19.0-gvisor","dial":"timeout","target":"10.96.0.1:443"}`)
	p := preflight(api, t)
	p.EnvNamespace = "kodus-runtime-environments"
	rep, err := p.Run(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(rep.EnvGateRefused, EnvGatePolicy) {
		t.Fatalf("%+v", rep)
	}
	if api.count() != 0 {
		t.Fatalf("the preflight left %d pods", api.count())
	}
}

func TestPreflightWithEnvironmentsRefuses(t *testing.T) {
	cases := []struct {
		name   string
		refuse func(Object) (int, string)
		want   error
		msg    string
	}{
		{name: "an environment namespace that admits a privileged hostPath pod has no gate", refuse: func(Object) (int, string) { return 0, "" }, want: ErrEnvGateMissing},
		{
			name: "a refusal that does not name the gate proves nothing of it",
			refuse: func(Object) (int, string) {
				return 403, `pods is forbidden: User "system:serviceaccount:kodus-runtime:kodus-runtime-cell" cannot create resource "pods"`
			},
			want: ErrEnvGateMissing, msg: "cannot create resource",
		},
		{name: "a RuntimeClass outside the gate's set refuses the driver's pod", refuse: theGate("kata-qemu"), want: ErrEnvPodRefused, msg: "RuntimeClasses"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			api := newAPIServer()
			api.admit = envNamespace("gvisor", c.refuse)
			api.kubelet = probeKubelet(`{"kernel":"4.19.0-gvisor","dial":"timeout","target":"10.96.0.1:443"}`)
			p := preflight(api, t)
			p.EnvNamespace = "kodus-runtime-environments"
			_, err := p.Run(context.Background())
			if !errors.Is(err, c.want) || !strings.Contains(err.Error(), c.msg) {
				t.Fatalf("err = %v, want %v", err, c.want)
			}
			if api.count() != 0 {
				t.Fatalf("the preflight left %d pods", api.count())
			}
		})
	}
}
