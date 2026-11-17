package k8ssandbox

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"go.yaml.in/yaml/v3"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/kodyexec"
)

// On a real cluster (opt-in, KODY_E2E_K8S_ENV=1 with the variables of
// kind_e2e_test.go): the environment mode boots a two-service compose
// project (an HTTP app on busybox and redis, public images loaded on the
// nodes) in an environment namespace this test makes with
// EnvironmentNamespace, and proves, through the real API server:
//
//   - the gate (the ValidatingAdmissionPolicy) refuses a pod with
//     hostNetwork, one off the RuntimeClass, one with a token and a
//     privileged one, and admits a rendered service pod;
//   - compose names resolve across pods, both ways (app -> cache, cache ->
//     app, which depends on nothing of app), and every service is ready;
//   - exec runs in the public service;
//   - a reset gives redis back the data its first start made (the golden
//     copy) and drops what the round wrote;
//   - a pod of another claim cannot reach this claim's redis, when the
//     cluster enforces NetworkPolicy at all (a control in a scratch
//     namespace says; without enforcement the assertion is skipped with the
//     reason, never faked);
//   - Destroy leaves no pod, volume claim or policy of the cell.
//
// KODY_E2E_K8S_ENV_HELPER_IMAGE is the init container's image (busybox: sh,
// tar, find) and the app's; KODY_E2E_K8S_ENV_REDIS_IMAGE redis (with bash).
// KODY_E2E_K8S_KERNEL_MUST_CONTAIN, set (gvisor), makes it check every
// service's kernel names it: the real-gVisor spike's run.
// On kind the RuntimeClass maps to runc; on a node with runsc it is gVisor
// (docs/runtime/kubernetes-environment-runs.md, "Running it on gVisor").
func TestOnAClusterAnEnvironmentRunBootsResetsAndIsolates(t *testing.T) {
	api, kctx, rc := os.Getenv("KODY_E2E_K8S_API"), os.Getenv("KODY_E2E_K8S_CONTEXT"), os.Getenv("KODY_E2E_K8S_RUNTIME_CLASS")
	helper, redis := os.Getenv("KODY_E2E_K8S_ENV_HELPER_IMAGE"), os.Getenv("KODY_E2E_K8S_ENV_REDIS_IMAGE")
	if os.Getenv("KODY_E2E_K8S_ENV") != "1" || api == "" || kctx == "" || rc == "" || helper == "" || redis == "" {
		t.Skip("KODY_E2E_K8S_ENV=1, KODY_E2E_K8S_API, KODY_E2E_K8S_CONTEXT, KODY_E2E_K8S_RUNTIME_CLASS, KODY_E2E_K8S_ENV_HELPER_IMAGE and KODY_E2E_K8S_ENV_REDIS_IMAGE run it on a cluster")
	}
	sandboxes := os.Getenv("KODY_E2E_K8S_NAMESPACE")
	if sandboxes == "" {
		sandboxes = sandboxNS
	}
	envs := "kodus-runtime-environments-e2e"
	ctx := context.Background()
	kubectl := func(stdin []byte, args ...string) (string, error) {
		cmd := exec.Command("kubectl", append([]string{"--context", kctx}, args...)...)
		if stdin != nil {
			cmd.Stdin = bytes.NewReader(stdin)
		}
		out, err := cmd.CombinedOutput()
		return string(out), err
	}

	// The environment namespace, its gate, default deny and Role.
	objs, err := EnvironmentNamespace(envs, []string{rc})
	if err != nil {
		t.Fatal(err)
	}
	manifest := yamlDocs(t, objs)
	if out, err := kubectl(manifest, "apply", "-f", "-"); err != nil {
		t.Fatalf("apply the environment namespace: %v: %s", err, out)
	}
	t.Cleanup(func() {
		_, _ = kubectl(manifest, "delete", "--wait=false", "--ignore-not-found", "-f", "-")
	})

	c := &Client{Base: api, HTTP: http.DefaultClient}
	cell := "cell-e2e-env"
	d, err := New(c, c, Config{
		CellID: cell, Namespace: sandboxes, RuntimeClass: rc, HolderImage: helper, EgressAddress: "127.0.0.1",
		ReadyTimeout: 3 * time.Minute, Poll: 500 * time.Millisecond,
		Env: &EnvConfig{API: c, Exec: c, Namespace: envs, HelperImage: helper, StopTimeout: time.Minute},
	})
	if err != nil {
		t.Fatal(err)
	}
	holder := func(claim string) driver.MachineRef {
		t.Helper()
		ref, err := d.Create(ctx, driver.MachineSpec{
			CellID: cell, EnvironmentID: "env-e2e", Role: driver.RoleWorkload, OrgID: "org-e2e", ClaimID: claim,
			ClaimSize: driver.ClaimSize{MemoryMB: 1024, CPUs: 1}, ClaimGroupID: claim, KMSKeyRef: "k8s-sandbox-org-e2e",
			ExpiresAt: time.Now().Add(20 * time.Minute), HardExpiresAt: time.Now().Add(time.Hour),
		})
		if err != nil {
			t.Fatalf("holder %s: %v", claim, err)
		}
		t.Cleanup(func() { _ = d.Destroy(context.Background(), ref) })
		return ref
	}

	// The gate: refused on its merits, after the policy reached the API
	// server (a new policy takes a moment).
	probePod := func(name string, mutate func(spec map[string]any)) Object {
		spec := map[string]any{
			"runtimeClassName": rc, "automountServiceAccountToken": false, "restartPolicy": "Never",
			"containers": []any{map[string]any{"name": "c", "image": helper, "command": []any{"true"}}},
		}
		mutate(spec)
		return Object{"apiVersion": "v1", "kind": "Pod", "metadata": map[string]any{"name": name}, "spec": spec}
	}
	refused := func(p Object) string {
		_, err := c.CreatePod(ctx, envs, p, true)
		var ae *APIError
		if errors.As(err, &ae) && ae.Refused() {
			return ae.Message
		}
		return ""
	}
	deadline := time.Now().Add(90 * time.Second)
	hostNet := probePod("gate-hostnet", func(s map[string]any) { s["hostNetwork"] = true })
	for refused(hostNet) == "" {
		if time.Now().After(deadline) {
			t.Fatal("the gate never refused a hostNetwork pod")
		}
		time.Sleep(2 * time.Second)
	}
	for name, mutate := range map[string]func(map[string]any){
		"off the RuntimeClass": func(s map[string]any) { delete(s, "runtimeClassName") },
		"a token":              func(s map[string]any) { s["automountServiceAccountToken"] = true },
		"a hostPath": func(s map[string]any) {
			s["volumes"] = []any{map[string]any{"name": "h", "hostPath": map[string]any{"path": "/"}}}
		},
		"privileged": func(s map[string]any) {
			s["containers"].([]any)[0].(map[string]any)["securityContext"] = map[string]any{"privileged": true}
		},
	} {
		if msg := refused(probePod("gate-bad", mutate)); !strings.Contains(msg, EnvGatePolicy) && !strings.Contains(msg, "environment pod") {
			t.Errorf("the gate let a pod with %s through (%q)", name, msg)
		} else {
			t.Logf("gate refused %s: %s", name, msg)
		}
	}
	if msg := refused(probePod("gate-good", func(map[string]any) {})); msg != "" {
		t.Errorf("the gate refused a conforming pod: %s", msg)
	}

	// The project.
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, ".kodus"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".kodus", "workspace.yaml"), []byte("version: 1\nservices:\n  compose:\n    public: app\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	compose := fmt.Sprintf(`services:
  app:
    image: %[1]s
    command: ["sh", "-c", "mkdir -p /tmp/www && echo hello-from-app > /tmp/www/index.html && exec httpd -f -p 8080 -h /tmp/www"]
    depends_on:
      cache: {condition: service_healthy}
    healthcheck:
      test: ["CMD", "wget", "-q", "-O-", "http://127.0.0.1:8080/"]
      interval: 1s
      retries: 60
  cache:
    image: %[2]s
    command: ["sh", "-c", "[ -e /data/born ] || date +%%s%%N > /data/born; exec redis-server --dir /data --appendonly yes"]
    volumes: [cachedata:/data]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 1s
      retries: 60
volumes:
  cachedata: {}
`, helper, redis)
	a := holder("e2e-env-a")
	start := time.Now()
	sources, err := d.Up(ctx, driver.UpRequest{Ref: a, Compose: []byte(compose), ProjectDir: dir, Output: func(l string) { t.Log("up: " + l) }})
	if err != nil {
		t.Fatalf("up: %v", err)
	}
	t.Logf("up in %s, sources %v", time.Since(start).Round(time.Millisecond), sources)
	if len(sources) != 2 {
		t.Errorf("sources %v", sources)
	}
	inCache := func(script string) string {
		t.Helper()
		res, err := c.RunCommand(ctx, envs, "env-e2e-env-a-cache", "cache", []string{"bash", "-c", script}, nil, 64<<10)
		if err != nil {
			t.Fatalf("exec in cache: %v", err)
		}
		return strings.TrimSpace(string(res.Stdout) + string(res.Stderr))
	}
	inApp := func(cmd string) kodyexec.Result {
		t.Helper()
		res, err := d.Exec(ctx, a, kodyexec.Request{Command: cmd, TimeoutMs: 20_000})
		if err != nil {
			t.Fatalf("exec %q: %v", cmd, err)
		}
		return res
	}
	if res := inApp(`printf 'PING\r\n' | nc -w 3 cache 6379`); !strings.Contains(res.Stdout, "+PONG") {
		t.Errorf("app -> cache by name: %+v", res)
	}
	if got := inCache(`exec 3<>/dev/tcp/app/8080; printf 'GET / HTTP/1.0\r\n\r\n' >&3; cat <&3`); !strings.Contains(got, "hello-from-app") {
		t.Errorf("cache -> app by name: %q", got)
	}
	if res := inApp("pwd"); res.ExitCode != 0 {
		t.Errorf("exec in the public service: %+v", res)
	}
	// On a gVisor node (the spike): every service's kernel is the sandbox's.
	if want := os.Getenv("KODY_E2E_K8S_KERNEL_MUST_CONTAIN"); want != "" {
		for _, got := range []string{inApp("uname -r").Stdout, inCache("uname -r")} {
			if !strings.Contains(got, want) {
				t.Errorf("a service's kernel is %q, not one naming %q", strings.TrimSpace(got), want)
			}
		}
		t.Logf("services run on a kernel naming %q", want)
	}
	born := inCache("cat /data/born")
	if res := inApp(`printf 'SET round k1\r\n' | nc -w 3 cache 6379`); !strings.Contains(res.Stdout, "+OK") {
		t.Errorf("SET: %+v", res)
	}
	inCache("echo round > /data/round-file")

	// Reset: the pods go, the next Up restores the golden copy.
	parts := d.Parts()
	start = time.Now()
	if err := parts.Resetter.Reset(ctx, a, driver.SnapshotRef{Kind: "compose_volumes"}); err != nil {
		t.Fatalf("reset: %v", err)
	}
	if _, err := d.Up(ctx, driver.UpRequest{Ref: a, Compose: []byte(compose), ProjectDir: dir}); err != nil {
		t.Fatalf("up after reset: %v", err)
	}
	t.Logf("reset and up in %s", time.Since(start).Round(time.Millisecond))
	if got := inCache("cat /data/born"); got != born || born == "" {
		t.Errorf("after the reset redis has born=%q, its first start's was %q", got, born)
	} else {
		t.Logf("golden data restored: /data/born %s before and after the reset", born)
	}
	if got := inCache("ls /data/round-file 2>&1; redis-cli GET round"); !strings.Contains(got, "No such file") || strings.Contains(got, "k1") {
		t.Errorf("the round's writes survived the reset: %q", got)
	}

	// Another claim cannot reach this one, where NetworkPolicy is enforced.
	if why := networkPolicyEnforced(t, kubectl, helper); why != "" {
		t.Logf("SKIPPED the cross-claim assertion: %s", why)
	} else {
		b := holder("e2e-env-b")
		if _, err := d.Up(ctx, driver.UpRequest{Ref: b, Compose: []byte(fmt.Sprintf("services:\n  probe:\n    image: %s\n    command: [sleep, \"3600\"]\n", helper)), ProjectDir: t.TempDir()}); err != nil {
			t.Fatalf("up b: %v", err)
		}
		cacheIP := ""
		if p, err := c.GetPod(ctx, envs, "env-e2e-env-a-cache"); err == nil {
			cacheIP = podStatus(p).ip
		}
		res, err := c.RunCommand(ctx, envs, "env-e2e-env-b-probe", "probe", []string{"sh", "-c", "nc -w 3 " + cacheIP + " 6379 </dev/null && echo open || echo closed"}, nil, 4096)
		if err != nil || !strings.Contains(string(res.Stdout), "closed") {
			t.Errorf("claim b reached claim a's redis at %s: %q %v", cacheIP, res.Stdout, err)
		} else {
			t.Logf("NetworkPolicy enforced (the control said so): claim b -> claim a's redis %s: closed", cacheIP)
		}
		if res := inApp(fmt.Sprintf("nc -w 3 %s 6379 </dev/null && echo open || echo closed", cacheIP)); !strings.Contains(res.Stdout, "open") {
			t.Errorf("claim a's own app could not reach its redis by address: %+v", res)
		}
		if err := d.Destroy(ctx, b); err != nil {
			t.Errorf("destroy b: %v", err)
		}
	}

	// Cleanup by labels leaves nothing of the cell.
	if err := d.Destroy(ctx, a); err != nil {
		t.Fatalf("destroy: %v", err)
	}
	mine := map[string]string{"kodus.io/cell": cell}
	pods, _ := c.ListPods(ctx, envs, mine)
	pvcs, _ := c.ListObjects(ctx, envs, ResourceVolumeClaims, mine)
	nps, _ := c.ListObjects(ctx, envs, ResourceNetworkPolicies, mine)
	holders, _ := c.ListPods(ctx, sandboxes, mine)
	if len(pods)+len(pvcs)+len(nps)+len(holders) != 0 {
		t.Errorf("left after destroy: %d pods, %d claims, %d policies, %d holders", len(pods), len(pvcs), len(nps), len(holders))
	}
}

// networkPolicyEnforced is a control independent of the driver: in a
// scratch namespace a client reaches a server, then a deny-all ingress
// policy on the server must cut it. "" when it does; why not otherwise.
func networkPolicyEnforced(t *testing.T, kubectl func([]byte, ...string) (string, error), image string) string {
	t.Helper()
	ns := "kodus-e2e-np-control"
	manifest := []byte(fmt.Sprintf(`apiVersion: v1
kind: Namespace
metadata: {name: %[1]s}
---
apiVersion: v1
kind: Pod
metadata: {name: server, namespace: %[1]s, labels: {role: server}}
spec:
  containers: [{name: s, image: %[2]s, command: [sh, -c, "mkdir -p /tmp/w && exec httpd -f -p 9000 -h /tmp/w"]}]
---
apiVersion: v1
kind: Pod
metadata: {name: client, namespace: %[1]s}
spec:
  containers: [{name: c, image: %[2]s, command: [sleep, "600"]}]
`, ns, image))
	if out, err := kubectl(manifest, "apply", "-f", "-"); err != nil {
		return "the control could not start: " + out
	}
	defer func() { _, _ = kubectl(nil, "delete", "namespace", ns, "--wait=false", "--ignore-not-found") }()
	if out, err := kubectl(nil, "-n", ns, "wait", "--for=condition=Ready", "pod/server", "pod/client", "--timeout=120s"); err != nil {
		return "the control pods did not run: " + out
	}
	ip, _ := kubectl(nil, "-n", ns, "get", "pod", "server", "-o", "jsonpath={.status.podIP}")
	dial := func() string {
		out, _ := kubectl(nil, "-n", ns, "exec", "client", "--", "sh", "-c", "nc -w 2 "+strings.TrimSpace(ip)+" 9000 </dev/null && echo open || echo closed")
		return strings.TrimSpace(out)
	}
	if got := dial(); !strings.Contains(got, "open") {
		return "the control client could not reach its server with no policy: " + got
	}
	deny := []byte(fmt.Sprintf("apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata: {name: deny, namespace: %s}\nspec:\n  podSelector: {matchLabels: {role: server}}\n  policyTypes: [Ingress]\n", ns))
	if out, err := kubectl(deny, "apply", "-f", "-"); err != nil {
		return "the control policy did not apply: " + out
	}
	for range 15 {
		if strings.Contains(dial(), "closed") {
			return ""
		}
		time.Sleep(2 * time.Second)
	}
	return "this cluster's CNI does not enforce NetworkPolicy (a deny-all ingress policy left the control server reachable for 30 s); run the CI job with an enforcing CNI (Calico, or kind's kube-network-policies)"
}

func yamlDocs(t *testing.T, objs []Object) []byte {
	t.Helper()
	var b bytes.Buffer
	for _, o := range objs {
		out, err := yaml.Marshal(o)
		if err != nil {
			t.Fatal(err)
		}
		b.WriteString("---\n")
		b.Write(out)
	}
	return b.Bytes()
}
