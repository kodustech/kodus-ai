package k8ssandbox

import (
	"bytes"
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"go.yaml.in/yaml/v3"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose/kube"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/hubclient"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/kodyexec"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/observer"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/observerclient"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/testpki"
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
	kubectl := kubectlOn(kctx)

	// The environment namespace, its gate, default deny and Role.
	objs, err := EnvironmentNamespace(envs, []string{rc}, ReferenceEnvAccess)
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
			"securityContext": map[string]any{"seccompProfile": map[string]any{"type": "RuntimeDefault"}},
			"containers":      []any{map[string]any{"name": "c", "image": helper, "command": []any{"true"}}},
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
		"Unconfined seccomp": func(s map[string]any) {
			s["containers"].([]any)[0].(map[string]any)["securityContext"] = map[string]any{"seccompProfile": map[string]any{"type": "Unconfined"}}
		},
		"no seccomp profile": func(s map[string]any) { delete(s, "securityContext") },
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

// On a real cluster (opt-in, KODY_E2E_K8S_ENV_BUILD=1 with the variables of
// the test above and the builder's, the registry's and the observer's): the
// two sides of a Run, base and PR, are two claims as the agent makes them
// (each its workload and its observer machine). Each side's web service is
// built from its own Dockerfile in a builder pod, pushed to the in-cluster
// registry and run from it by digest, after its redis is healthy; then the
// claim's observer pod, configured and asked through the real
// observerclient over DialObserver with mTLS certificates this test issues,
// probes it over HTTP and gets that side's page. And:
//
//   - no builder pod is left once a build is done, and the service runs the
//     pushed image by digest from the pull name;
//   - the PR's observer refuses a frame of the base claim, and cannot reach
//     the base's web pod when the cluster enforces NetworkPolicy (the
//     control of the test above decides; skipped with the reason otherwise);
//   - a reset of the PR side reuses its image (no builder pod) and its new
//     observer answers the probe again;
//   - Destroy leaves no pod, volume claim or policy of the cell.
//
// KODY_E2E_K8S_ENV_BUILDER_IMAGE is rootless BuildKit
// (moby/buildkit:v0.34.0-rootless or the cell's builder image);
// KODY_E2E_K8S_ENV_OBSERVER_IMAGE has cmd/observer at kube.ObserverBinary
// (the cell image, or a distroless image with that binary only);
// KODY_E2E_K8S_ENV_REGISTRY is the in-cluster registry's address
// (pod IP:port, plain HTTP), which the builder reaches by the name
// kodus-e2e-registry through its hosts file and pushes to;
// KODY_E2E_K8S_ENV_REGISTRY_PULL the name the nodes pull the same
// repository by (kind: localhost:5001, a containerd hosts.toml to the
// registry); KODY_E2E_K8S_ENV_MIRROR a docker.io pull-through registry
// (pod IP:port, plain HTTP) the builder pulls its base image through, by the
// name kodus-e2e-mirror. .github/workflows/runtime-cell-kind.yml sets them
// up on kind; docs/runtime/kubernetes-environment-runs.md, "Local test
// results", records a run.
func TestOnAClusterEachSideBuildsItsServiceAndItsObserverProbesIt(t *testing.T) {
	api, kctx, rc := os.Getenv("KODY_E2E_K8S_API"), os.Getenv("KODY_E2E_K8S_CONTEXT"), os.Getenv("KODY_E2E_K8S_RUNTIME_CLASS")
	helper, redis := os.Getenv("KODY_E2E_K8S_ENV_HELPER_IMAGE"), os.Getenv("KODY_E2E_K8S_ENV_REDIS_IMAGE")
	builder, observerImage := os.Getenv("KODY_E2E_K8S_ENV_BUILDER_IMAGE"), os.Getenv("KODY_E2E_K8S_ENV_OBSERVER_IMAGE")
	registry, pull, mirror := os.Getenv("KODY_E2E_K8S_ENV_REGISTRY"), os.Getenv("KODY_E2E_K8S_ENV_REGISTRY_PULL"), os.Getenv("KODY_E2E_K8S_ENV_MIRROR")
	if os.Getenv("KODY_E2E_K8S_ENV_BUILD") != "1" || api == "" || kctx == "" || rc == "" || helper == "" || redis == "" ||
		builder == "" || observerImage == "" || registry == "" || pull == "" || mirror == "" {
		t.Skip("KODY_E2E_K8S_ENV_BUILD=1, KODY_E2E_K8S_API, _CONTEXT, _RUNTIME_CLASS, KODY_E2E_K8S_ENV_HELPER_IMAGE, _REDIS_IMAGE, _BUILDER_IMAGE, _OBSERVER_IMAGE, _REGISTRY, _REGISTRY_PULL and _MIRROR run it on a cluster")
	}
	regIP, regPort, err := net.SplitHostPort(registry)
	if err != nil || net.ParseIP(regIP) == nil {
		t.Fatalf("KODY_E2E_K8S_ENV_REGISTRY %q is not an IP:port", registry)
	}
	mirIP, mirPort, err := net.SplitHostPort(mirror)
	if err != nil || net.ParseIP(mirIP) == nil {
		t.Fatalf("KODY_E2E_K8S_ENV_MIRROR %q is not an IP:port", mirror)
	}
	port := func(s string) []kube.Port {
		n, _ := strconv.Atoi(s)
		return []kube.Port{{Protocol: "TCP", Port: n}}
	}
	sandboxes := os.Getenv("KODY_E2E_K8S_NAMESPACE")
	if sandboxes == "" {
		sandboxes = sandboxNS
	}
	envs := "kodus-runtime-environments-e2e-build"
	ctx := context.Background()
	kubectl := kubectlOn(kctx)
	timing := func(step string, since time.Time) {
		t.Logf("timing: %s %s", step, time.Since(since).Round(100*time.Millisecond))
	}

	start := time.Now()
	objs, err := EnvironmentNamespace(envs, []string{rc}, ReferenceEnvAccess)
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

	// The observers' server certificate (for the name the cell checks) and
	// the CA of the cell's client certificate, as -k8s-env-observer-tls-dir.
	ca, err := testpki.NewCA("e2e-observer-ca")
	if err != nil {
		t.Fatal(err)
	}
	obsCert, err := ca.Issue("observer", time.Hour, "observer")
	if err != nil {
		t.Fatal(err)
	}
	tlsDir := t.TempDir()
	if err := ca.WriteFiles(tlsDir, "", obsCert); err != nil {
		t.Fatal(err)
	}
	cell := "cell-e2e-build"
	cellCert, err := ca.Issue(cell, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	obsTLS := &tls.Config{Certificates: []tls.Certificate{cellCert}, RootCAs: ca.Pool(), ServerName: "observer", MinVersion: tls.VersionTLS13}

	c := &Client{Base: api, HTTP: http.DefaultClient}
	d, err := New(c, c, Config{
		CellID: cell, Namespace: sandboxes, RuntimeClass: rc, HolderImage: helper, EgressAddress: "127.0.0.1",
		ReadyTimeout: 4 * time.Minute, Poll: 500 * time.Millisecond,
		Env: &EnvConfig{
			API: c, Exec: c, Namespace: envs, HelperImage: helper, StopTimeout: time.Minute,
			BuilderImage: builder, BuildRegistry: "kodus-e2e-registry:" + regPort, BuildRegistryPull: pull, BuildRegistryInsecure: true,
			BuildMirror:  "kodus-e2e-mirror:" + mirPort,
			BuildHosts:   map[string]string{"kodus-e2e-registry": regIP, "kodus-e2e-mirror": mirIP},
			BuildEgress:  []kube.EgressPeer{{CIDR: regIP + "/32", Ports: port(regPort)}, {CIDR: mirIP + "/32", Ports: port(mirPort)}},
			BuildStorage: "2Gi", ObserverImage: observerImage, ObserverTLSDir: tlsDir,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	machine := func(claim string, role driver.Role) driver.MachineRef {
		t.Helper()
		begin := time.Now()
		ref, err := d.Create(ctx, driver.MachineSpec{
			CellID: cell, EnvironmentID: "env-e2e-build", Role: role, OrgID: "org-e2e", ClaimID: claim, ImageID: "img-" + claim,
			ClaimSize: driver.ClaimSize{MemoryMB: 1024, CPUs: 1}, ClaimGroupID: claim, KMSKeyRef: "k8s-sandbox-org-e2e",
			ExpiresAt: time.Now().Add(20 * time.Minute), HardExpiresAt: time.Now().Add(time.Hour),
		})
		if err != nil {
			t.Fatalf("%s machine of %s: %v", role, claim, err)
		}
		t.Cleanup(func() { _ = d.Destroy(context.Background(), ref) })
		timing(string(role)+" machine of "+claim, begin)
		return ref
	}
	builders := func() int {
		t.Helper()
		pods, err := c.ListPods(ctx, envs, map[string]string{"kodus.io/cell": cell, kube.RoleLabel: kube.BuilderRole})
		if err != nil {
			t.Fatalf("list builder pods: %v", err)
		}
		return len(pods)
	}
	observerClient := func(w, o driver.MachineRef, claim string, extra ...observer.Target) observer.Client {
		t.Helper()
		targets, err := d.Targets(w.MachineID, []observer.Target{{Service: "web", Port: 8080, Kind: "http"}})
		if err != nil {
			t.Fatalf("targets of %s: %v", claim, err)
		}
		hc := &http.Client{Timeout: 2 * time.Minute, Transport: &http.Transport{
			DisableKeepAlives: true,
			TLSClientConfig:   obsTLS,
			DialContext:       func(ctx context.Context, _, _ string) (net.Conn, error) { return d.DialObserver(ctx, o.MachineID) },
		}}
		_, obsPort, _ := net.SplitHostPort(kube.ObserverListen)
		cl, err := observerclient.Configure(ctx, hc, "https://"+net.JoinHostPort(o.PrivateAddress, obsPort),
			observer.ClaimConfig{ClaimID: claim, ImageID: w.ImageID, Targets: append(targets, extra...)})
		if err != nil {
			t.Fatalf("configure the observer of %s: %v", claim, err)
		}
		return cl
	}
	probe := func(cl observer.Client, frameClaim, service string) (*protocol.StepResultBody, error) {
		step := hubclient.NewID()
		frame, err := protocol.Encode(protocol.Header{ID: hubclient.NewID(), CellID: cell, ClaimID: frameClaim}, &protocol.ProbeRunBody{StepID: step, Probe: protocol.Probe{
			ID: "e2e-web", Origin: protocol.ProbeOriginAgent, Purpose: "the side's page", Expected: "its own text",
			Compare: []protocol.CompareField{protocol.CompareFieldStatus},
			Spec:    protocol.ProbeSpec{HTTP: &protocol.HTTPProbe{Target: protocol.ProbeTarget{Service: service, Port: 8080}, Method: "GET", Path: "/", TimeoutMs: 5000}},
		}})
		if err != nil {
			t.Fatal(err)
		}
		res, _, err := cl.Run(ctx, frame)
		return res, err
	}
	page := func(res *protocol.StepResultBody) string {
		if res == nil || res.Probe == nil || res.Probe.HTTP == nil {
			return ""
		}
		return fmt.Sprintf("%d %s", res.Probe.HTTP.Status, strings.TrimSpace(res.Probe.HTTP.Body))
	}
	project := func(side string) string {
		t.Helper()
		dir := t.TempDir()
		files := map[string]string{
			".kodus/workspace.yaml": "version: 1\nservices:\n  compose:\n    public: web\n",
			"web/Dockerfile":        fmt.Sprintf("FROM %s\nCOPY index.html /www/index.html\nCMD [\"httpd\", \"-f\", \"-p\", \"8080\", \"-h\", \"/www\"]\n", helper),
			"web/index.html":        "kody-" + side + "\n",
			"web/.dockerignore":     "notes.txt\n",
			"web/notes.txt":         "not in the context\n",
		}
		for name, body := range files {
			p := filepath.Join(dir, filepath.FromSlash(name))
			if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
				t.Fatal(err)
			}
		}
		return dir
	}
	compose := []byte(fmt.Sprintf(`services:
  web:
    build: {context: ./web}
    depends_on:
      cache: {condition: service_healthy}
    healthcheck:
      test: ["CMD", "wget", "-q", "-O-", "http://127.0.0.1:8080/"]
      interval: 1s
      retries: 60
  cache:
    image: %s
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 1s
      retries: 60
`, redis))
	// up boots a side and says how long its build took: from the boot's
	// "$ build" line to the last BuildKit progress line.
	up := func(w driver.MachineRef, dir, what string) []string {
		t.Helper()
		var lines []string
		var buildStart, buildEnd time.Time
		begin := time.Now()
		_, err := d.Up(ctx, driver.UpRequest{Ref: w, Compose: compose, ProjectDir: dir, Output: func(l string) {
			lines = append(lines, l)
			switch {
			case strings.HasPrefix(l, "$ build"):
				buildStart = time.Now()
			case strings.HasPrefix(l, "#") && !buildStart.IsZero():
				buildEnd = time.Now()
			}
			t.Log(what + ": " + l)
		}})
		if err != nil {
			t.Fatalf("%s: %v", what, err)
		}
		timing(what, begin)
		if !buildStart.IsZero() {
			t.Logf("timing: build in %s %s", what, buildEnd.Sub(buildStart).Round(100*time.Millisecond))
		}
		return lines
	}

	sides := []string{"base", "pr"}
	work, obs, dirs := map[string]driver.MachineRef{}, map[string]driver.MachineRef{}, map[string]string{}
	for _, side := range sides {
		claim := "e2e-build-" + side
		work[side] = machine(claim, driver.RoleWorkload)
		obs[side] = machine(claim, driver.RoleObserver)
		dirs[side] = project(side)
	}
	timing("environment namespace and the machines of both sides", start)
	for _, side := range sides {
		claim := "e2e-build-" + side
		if lines := up(work[side], dirs[side], "up "+side); !slices.Contains(lines, "$ build web") {
			t.Errorf("the %s side's web service was not built: %q", side, lines)
		}
		if n := builders(); n != 0 {
			t.Errorf("%d builder pods left after the %s side's build", n, side)
		}
		p, err := c.GetPod(ctx, envs, envPrefix(claim)+"-web")
		if err != nil {
			t.Fatalf("the %s side's web pod: %v", side, err)
		}
		if img := podImage(p); !strings.HasPrefix(img, pull+"/"+buildRepo(claim, "web")+"@sha256:") {
			t.Errorf("the %s side's web pod runs %q, not its build by digest from %s", side, img, pull)
		} else {
			t.Logf("%s side's web runs %s", side, img)
		}
	}

	// Each side's observer probes its own web service.
	for _, side := range sides {
		claim := "e2e-build-" + side
		begin := time.Now()
		cl := observerClient(work[side], obs[side], claim)
		timing("configure the observer of "+side, begin)
		begin = time.Now()
		res, err := probe(cl, claim, "web")
		if err != nil {
			t.Fatalf("probe through the %s observer: %v", side, err)
		}
		timing("probe through the observer of "+side, begin)
		if got, want := page(res), "200 kody-"+side; got != want {
			t.Errorf("the %s observer's probe got %q, want %q (%+v)", side, got, want, res)
		} else {
			t.Logf("the %s observer probed web: %s", side, got)
		}
	}

	// The PR's observer is the PR's alone. Its configuration bound it, so a
	// fresh observer (a reset's) is the one asked to reach the base below.
	prClaim := "e2e-build-pr"
	parts := d.Parts()
	begin := time.Now()
	if err := parts.Resetter.Reset(ctx, work["pr"], driver.SnapshotRef{Kind: "compose_volumes"}); err != nil {
		t.Fatalf("reset pr: %v", err)
	}
	if lines := up(work["pr"], dirs["pr"], "up pr after its reset"); slices.Contains(lines, "$ build web") {
		t.Errorf("the PR side built again after a reset that changed nothing: %q", lines)
	}
	timing("reset and up of pr", begin)
	if n := builders(); n != 0 {
		t.Errorf("%d builder pods after the reset's up", n)
	}
	var extra []observer.Target
	baseIP := ""
	why := networkPolicyEnforced(t, kubectl, helper)
	if why == "" {
		if p, err := c.GetPod(ctx, envs, envPrefix("e2e-build-base")+"-web"); err == nil {
			baseIP = podStatus(p).ip
		}
		extra = append(extra, observer.Target{Service: "base-web", Port: 8080, Kind: "http", Address: net.JoinHostPort(baseIP, "8080")})
	}
	cl := observerClient(work["pr"], obs["pr"], prClaim, extra...)
	if res, err := probe(cl, prClaim, "web"); err != nil || page(res) != "200 kody-pr" {
		t.Errorf("the PR's new observer after the reset: %q %v", page(res), err)
	} else {
		t.Logf("the PR's new observer after the reset probed web: %s", page(res))
	}
	if _, err := probe(cl, "e2e-build-base", "web"); err == nil || !strings.Contains(err.Error(), "409") {
		t.Errorf("the PR's observer ran a frame of the base claim: %v", err)
	} else {
		t.Logf("the PR's observer refused a frame of the base claim: %v", err)
	}
	if why != "" {
		t.Logf("SKIPPED the observer's cross-claim assertion: %s", why)
	} else {
		res, err := probe(cl, prClaim, "base-web")
		if got := page(res); strings.Contains(got, "kody-base") {
			t.Errorf("the PR's observer reached the base's web pod at %s: %q", baseIP, got)
		} else {
			t.Logf("NetworkPolicy enforced on the observer: the PR's observer -> the base's web %s: not reached (%v, health %v)", baseIP, err, vmHealth(res))
		}
	}

	// Destroy leaves nothing of the cell.
	begin = time.Now()
	for _, side := range sides {
		if err := d.Destroy(ctx, obs[side]); err != nil {
			t.Errorf("destroy the %s observer: %v", side, err)
		}
		if err := d.Destroy(ctx, work[side]); err != nil {
			t.Errorf("destroy the %s workload: %v", side, err)
		}
	}
	timing("destroy both sides", begin)
	mine := map[string]string{"kodus.io/cell": cell}
	pods, _ := c.ListPods(ctx, envs, mine)
	pvcs, _ := c.ListObjects(ctx, envs, ResourceVolumeClaims, mine)
	nps, _ := c.ListObjects(ctx, envs, ResourceNetworkPolicies, mine)
	holders, _ := c.ListPods(ctx, sandboxes, mine)
	if len(pods)+len(pvcs)+len(nps)+len(holders) != 0 {
		t.Errorf("left after destroy: %d pods, %d claims, %d policies, %d holders", len(pods), len(pvcs), len(nps), len(holders))
	}
}

// podImage is the first container's image of a pod.
func podImage(p Object) string {
	spec, _ := p["spec"].(map[string]any)
	list, _ := spec["containers"].([]any)
	if len(list) == 0 {
		return ""
	}
	c, _ := list[0].(map[string]any)
	return str(c["image"])
}

func vmHealth(res *protocol.StepResultBody) string {
	if res == nil {
		return "no result"
	}
	return string(res.VMHealth)
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

// kubectlOn runs kubectl on the cluster's context, stdin when given.
func kubectlOn(kctx string) func([]byte, ...string) (string, error) {
	return func(stdin []byte, args ...string) (string, error) {
		cmd := exec.Command("kubectl", append([]string{"--context", kctx}, args...)...)
		if stdin != nil {
			cmd.Stdin = bytes.NewReader(stdin)
		}
		out, err := cmd.CombinedOutput()
		return string(out), err
	}
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
