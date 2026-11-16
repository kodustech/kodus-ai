package k8ssandbox

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver/drivertest"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/reaper"
)

const sandboxNS = "kodus-runtime-sandboxes"

func cfg() Config {
	return Config{
		CellID: "cell-1", Namespace: sandboxNS, RuntimeClass: "gvisor",
		HolderImage: "kodus/holder@sha256:a", SandboxImage: "kodus/sandbox@sha256:b", EgressAddress: "10.96.0.53",
		Now: func() time.Time { return drivertest.Now }, Poll: time.Millisecond, ReadyTimeout: time.Second,
	}
}

func newDriver(t *testing.T, api *apiServer) *Driver {
	t.Helper()
	c := api.client(t)
	d, err := New(c, c, cfg())
	if err != nil {
		t.Fatal(err)
	}
	return d
}

func sandboxSpec(claim string) driver.MachineSpec {
	return driver.MachineSpec{
		CellID: "cell-1", EnvironmentID: "sandbox", Role: driver.RoleWorkload, OrgID: "org-a", ClaimID: claim,
		ClaimSize: driver.ClaimSize{MemoryMB: 2048, CPUs: 2}, ClaimGroupID: claim, KMSKeyRef: "k8s-sandbox-org-a",
		ExpiresAt: drivertest.Now.Add(10 * time.Minute), HardExpiresAt: drivertest.Now.Add(time.Hour),
	}
}

// The driver keeps the contract every driver keeps, against an API server
// that keeps state (and the real client over HTTP).
func TestConformance(t *testing.T) {
	drivertest.Run(t, func(t *testing.T) drivertest.Subject {
		api := newAPIServer()
		d := newDriver(t, api)
		return drivertest.Subject{
			Driver: d, CellID: "cell-1", Lifecycle: true,
			ForeignMachine: func(t *testing.T) driver.MachineRef {
				api.mu.Lock()
				api.pods[sandboxNS+"/workload-claim-9"] = Object{"metadata": map[string]any{"name": "workload-claim-9", "namespace": sandboxNS, "labels": map[string]any{
					label(driver.TagCell): "cell-2", label(driver.TagClaim): "claim-9", label(driver.TagRole): "workload",
				}}}
				api.mu.Unlock()
				ref := sandboxNS + "/workload-claim-9"
				return driver.MachineRef{MachineID: ref, DriverRef: ref, Tags: map[string]string{driver.TagCell: "cell-2", driver.TagClaim: "claim-9"}}
			},
			Parts: d.Parts(),
			UndatedMachine: func(_ *testing.T, ceiling string) string {
				api.mu.Lock()
				defer api.mu.Unlock()
				name := fmt.Sprintf("workload-undated-%d", len(api.pods))
				annotations := map[string]any{}
				if ceiling != "" {
					annotations[label(driver.TagHardExpires)] = ceiling
				}
				api.pods[sandboxNS+"/"+name] = Object{"metadata": map[string]any{"name": name, "namespace": sandboxNS, "labels": map[string]any{
					label(driver.TagCell): "cell-1", label(driver.TagClaim): "undated", label(driver.TagRole): "workload",
				}, "annotations": annotations}}
				return sandboxNS + "/" + name
			},
		}
	})
}

// A sandbox pod is what the namespace's restricted level and admission
// policy require, and what the egress expects: on the RuntimeClass, as
// user 1000, read-only, no capability, no escalation, no token, its DNS
// the cell's resolver only, its writes in memory, Guaranteed, and ended by
// the kubelet at the claim's hard ceiling.
func TestSandboxPodIsRestrictedOnTheRuntimeClass(t *testing.T) {
	api := newAPIServer()
	d := newDriver(t, api)
	ref, err := d.CreateSandbox(context.Background(), driver.SandboxRequest{Spec: sandboxSpec("claim-1")})
	if err != nil {
		t.Fatal(err)
	}
	if ref.PrivateAddress == "" || ref.MachineID != sandboxNS+"/workload-claim-1" {
		t.Fatalf("ref %+v", ref)
	}
	p := api.pod(sandboxNS, "workload-claim-1")
	spec := p["spec"].(map[string]any)
	for k, want := range map[string]any{
		"runtimeClassName": "gvisor", "automountServiceAccountToken": false, "enableServiceLinks": false,
		"hostNetwork": false, "hostPID": false, "hostIPC": false, "dnsPolicy": "None", "activeDeadlineSeconds": float64(3600),
	} {
		if spec[k] != want {
			t.Errorf("spec.%s = %v, want %v", k, spec[k], want)
		}
	}
	if ns := spec["dnsConfig"].(map[string]any)["nameservers"].([]any); len(ns) != 1 || ns[0] != "10.96.0.53" {
		t.Errorf("nameservers %v", ns)
	}
	ps := spec["securityContext"].(map[string]any)
	if ps["runAsNonRoot"] != true || ps["runAsUser"] != float64(1000) || ps["seccompProfile"].(map[string]any)["type"] != "RuntimeDefault" {
		t.Errorf("pod securityContext %v", ps)
	}
	c := spec["containers"].([]any)[0].(map[string]any)
	sc := c["securityContext"].(map[string]any)
	if sc["allowPrivilegeEscalation"] != false || sc["readOnlyRootFilesystem"] != true || sc["privileged"] != false {
		t.Errorf("container securityContext %v", sc)
	}
	if drop := sc["capabilities"].(map[string]any)["drop"].([]any); len(drop) != 1 || drop[0] != "ALL" {
		t.Errorf("capabilities %v", drop)
	}
	res := c["resources"].(map[string]any)
	lim, req := res["limits"].(map[string]any), res["requests"].(map[string]any)
	if lim["memory"] != "2048Mi" || lim["cpu"] != "2" || req["memory"] != lim["memory"] || req["cpu"] != lim["cpu"] {
		t.Errorf("resources %v", res)
	}
	vols := spec["volumes"].([]any)
	ws := vols[0].(map[string]any)["emptyDir"].(map[string]any)
	if ws["medium"] != "Memory" || ws["sizeLimit"] != "1024Mi" {
		t.Errorf("workspace %v", ws)
	}
	for _, v := range vols {
		if _, host := v.(map[string]any)["hostPath"]; host {
			t.Errorf("a hostPath volume: %v", v)
		}
	}
}

// A sandbox pod that cannot run is deleted, and the error says why (the
// kubelet's waiting reason), instead of a claim waiting on a pod forever.
func TestSandboxThatCannotRunIsDeletedWithItsReason(t *testing.T) {
	api := newAPIServer()
	api.kubelet = func(Object) map[string]any {
		return map[string]any{"phase": "Pending", "containerStatuses": []any{map[string]any{"state": map[string]any{
			"waiting": map[string]any{"reason": "ErrImagePull", "message": "pull access denied"},
		}}}}
	}
	d := newDriver(t, api)
	_, err := d.CreateSandbox(context.Background(), driver.SandboxRequest{Spec: sandboxSpec("claim-1")})
	if err == nil || !strings.Contains(err.Error(), "ErrImagePull") {
		t.Fatalf("err = %v, want the waiting reason", err)
	}
	if api.count() != 0 {
		t.Fatalf("the pod that never ran is left: %d pods", api.count())
	}
}

// The guest agent is the sandbox container's kody-guest on a pods/exec
// WebSocket: what the cell writes reaches its stdin, its stdout comes back
// (stderr does not mix in), and closing the stream closes its stdin.
func TestDialGuestExecsTheGuestAgentOverWebSocket(t *testing.T) {
	api := newAPIServer()
	d := newDriver(t, api)
	ref, err := d.CreateSandbox(context.Background(), driver.SandboxRequest{Spec: sandboxSpec("claim-1")})
	if err != nil {
		t.Fatal(err)
	}
	rw, err := d.DialGuest(context.Background(), ref)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := rw.Write([]byte(`{"op":"health"}`)); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 64)
	n, err := io.ReadAtLeast(rw, buf, len(`{"op":"health"}`))
	if err != nil || string(buf[:n]) != `{"op":"health"}` {
		t.Fatalf("read %q %v", buf[:n], err)
	}
	if err := rw.Close(); err != nil {
		t.Fatal(err)
	}
	want := append([]string{"sandbox"}, GuestCommand...)
	if len(api.execs) != 1 || strings.Join(api.execs[0], " ") != strings.Join(want, " ") {
		t.Fatalf("exec %v, want %v", api.execs, want)
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		api.mu.Lock()
		closed := api.closed
		api.mu.Unlock()
		if closed == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("Close did not send the v5 stdin close")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// DialGuest refuses a pod of another cell, and one outside the sandbox
// namespace, before it execs anything.
func TestDialGuestRefusesAnotherCellsPod(t *testing.T) {
	api := newAPIServer()
	d := newDriver(t, api)
	api.pods[sandboxNS+"/workload-x"] = Object{"metadata": map[string]any{"name": "workload-x", "namespace": sandboxNS, "labels": map[string]any{label(driver.TagCell): "cell-2"}}}
	for _, ref := range []string{sandboxNS + "/workload-x", "kube-system/coredns"} {
		if _, err := d.DialGuest(context.Background(), driver.MachineRef{MachineID: ref, DriverRef: ref}); !errors.Is(err, driver.ErrNotOwned) {
			t.Errorf("DialGuest(%s) = %v, want ErrNotOwned", ref, err)
		}
	}
	if len(api.execs) != 0 {
		t.Fatalf("exec ran: %v", api.execs)
	}
}

// Every request the driver makes is for pods in the sandbox namespace,
// with the service account's token: what the cell's Role grants, and no
// more.
func TestEveryRequestIsPodsInTheSandboxNamespace(t *testing.T) {
	api := newAPIServer()
	d := newDriver(t, api)
	ctx := context.Background()
	n, _ := d.PrepareClaim(ctx, driver.ClaimNetworkSpec{CellID: "cell-1", OrgID: "org-a", ClaimID: "claim-1"})
	ref, err := d.CreateSandbox(ctx, driver.SandboxRequest{Spec: sandboxSpec("claim-1")})
	if err != nil {
		t.Fatal(err)
	}
	rw, err := d.DialGuest(ctx, ref)
	if err != nil {
		t.Fatal(err)
	}
	_ = rw.Close()
	_ = d.SetExpiry(ctx, ref, drivertest.Now.Add(20*time.Minute))
	_, _ = d.List(ctx, map[string]string{driver.TagCell: "cell-1"})
	if err := d.ReleaseClaim(ctx, n); err != nil {
		t.Fatal(err)
	}
	if api.count() != 0 {
		t.Fatalf("ReleaseClaim left %d pods", api.count())
	}
	for i, p := range api.paths {
		if _, path, _ := strings.Cut(p, " "); !strings.HasPrefix(path, "/api/v1/namespaces/"+sandboxNS+"/pods") {
			t.Errorf("request %s is outside the sandbox namespace's pods", p)
		}
		if api.auth[i] != "Bearer sa-token" {
			t.Errorf("request %s without the token", p)
		}
	}
}

// PrepareClaim makes nothing in the cluster and names the egress address:
// the chart's policies already isolate every claim pod.
func TestPrepareClaimCreatesNothingAndNamesTheEgress(t *testing.T) {
	api := newAPIServer()
	d := newDriver(t, api)
	n, err := d.PrepareClaim(context.Background(), driver.ClaimNetworkSpec{CellID: "cell-1", OrgID: "org-a", ClaimID: "claim-1"})
	if err != nil || n.WorkloadGroupID != "claim-1" || n.EgressAddress != "10.96.0.53" {
		t.Fatalf("%+v %v", n, err)
	}
	if len(api.paths) != 0 {
		t.Fatalf("PrepareClaim called the API: %v", api.paths)
	}
	if _, err := d.PrepareClaim(context.Background(), driver.ClaimNetworkSpec{ClaimID: "claim-2", Expose: []driver.ExposePort{{Port: 3000}}}); !errors.Is(err, driver.ErrUnsupported) {
		t.Fatalf("an exposed port = %v, want ErrUnsupported (no Runs)", err)
	}
}

// Sweep removes this cell's pods past their ceiling and nothing else.
func TestSweepDeletesOnlyThisCellsExpiredPods(t *testing.T) {
	api := newAPIServer()
	d := newDriver(t, api)
	ctx := context.Background()
	old := sandboxSpec("claim-old")
	if _, err := d.CreateSandbox(ctx, driver.SandboxRequest{Spec: old}); err != nil {
		t.Fatal(err)
	}
	if _, err := d.CreateSandbox(ctx, driver.SandboxRequest{Spec: sandboxSpec("claim-young")}); err != nil {
		t.Fatal(err)
	}
	// Past claim-old's ceiling only.
	meta(api.pods[sandboxNS+"/workload-claim-old"])["annotations"].(map[string]any)[label(driver.TagHardExpires)] = driver.FormatTime(drivertest.Now.Add(-time.Minute))
	api.pods[sandboxNS+"/other"] = Object{"metadata": map[string]any{
		"name": "other", "namespace": sandboxNS,
		"labels":      map[string]any{label(driver.TagCell): "cell-2"},
		"annotations": map[string]any{label(driver.TagHardExpires): driver.FormatTime(drivertest.Now.Add(-time.Hour))},
	}}
	gone, err := d.Sweep(ctx, drivertest.Now)
	if err != nil || len(gone) != 1 || gone[0] != sandboxNS+"/workload-claim-old" {
		t.Fatalf("gone %v %v", gone, err)
	}
	if api.pod(sandboxNS, "other") == nil || api.pod(sandboxNS, "workload-claim-young") == nil {
		t.Fatal("Sweep deleted a pod it does not own or one under its ceiling")
	}
}

// The chart's reaper runs -driver k8s-sandbox with its own token: it lists
// this cell's pods in the sandbox namespace (the old reaper listed every
// namespace, which its namespaced Role cannot) and deletes the ones past
// kodus:hard-expires.
func TestReaperOnKubernetesDeletesOnlyThisCellsExpiredPods(t *testing.T) {
	now := time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC)
	api := newAPIServer()
	mk := func(name, cell string, hard time.Time) Object {
		return Object{"metadata": map[string]any{
			"name": name, "namespace": sandboxNS,
			"labels":      map[string]any{label(driver.TagCell): cell, label(driver.TagClaim): "claim-1"},
			"annotations": map[string]any{label(driver.TagHardExpires): driver.FormatTime(hard)},
		}}
	}
	api.pods[sandboxNS+"/old"] = mk("old", "cell-1", now.Add(-time.Minute))
	api.pods[sandboxNS+"/young"] = mk("young", "cell-1", now.Add(time.Hour))
	api.pods[sandboxNS+"/theirs"] = mk("theirs", "cell-2", now.Add(-time.Hour))
	k := api.client(t)
	r := &reaper.Reaper{CellID: "cell-1", Driver: NewForReaper(k, "cell-1", sandboxNS), Now: func() time.Time { return now }}
	rep, err := r.Run(context.Background())
	if err != nil || rep.Seen != 2 || len(rep.Terminated) != 1 {
		t.Fatalf("%+v %v", rep, err)
	}
	if api.pod(sandboxNS, "old") != nil || api.pod(sandboxNS, "young") == nil || api.pod(sandboxNS, "theirs") == nil {
		t.Fatalf("pods left %v", api.pods)
	}
	for _, p := range api.paths {
		if !strings.Contains(p, "/api/v1/namespaces/"+sandboxNS+"/pods") {
			t.Errorf("the reaper asked %s", p)
		}
	}
}

// In a pod with a service account the cell knows it runs in a cluster.
func TestInCluster(t *testing.T) {
	env := map[string]string{"KUBERNETES_SERVICE_HOST": "10.96.0.1", "KUBERNETES_SERVICE_PORT": "443"}
	has := func(string) bool { return true }
	if !InCluster(func(k string) string { return env[k] }, has) {
		t.Fatal("a pod with a token is in a cluster")
	}
	if InCluster(func(k string) string { return env[k] }, func(string) bool { return false }) {
		t.Fatal("no token, no cluster")
	}
	if InCluster(func(string) string { return "" }, has) {
		t.Fatal("no API server address, no cluster")
	}
}
