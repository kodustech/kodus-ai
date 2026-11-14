package k8ssandbox

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
)

type mockKube struct {
	applied []Object
	deleted []string
	exists  map[string]bool
	pods    []Object
}

func (m *mockKube) Apply(_ context.Context, o Object) error {
	m.applied = append(m.applied, o)
	return nil
}
func (m *mockKube) Get(_ context.Context, _, kind, ns, name string) (Object, error) {
	if kind == "Pod" {
		for _, p := range m.pods {
			md := p["metadata"].(map[string]any)
			if md["namespace"] == ns && md["name"] == name {
				return p, nil
			}
		}
		return nil, ErrNotFound
	}
	if m.exists[kind+"/"+name] {
		return Object{}, nil
	}
	return nil, ErrNotFound
}
func (m *mockKube) Delete(_ context.Context, _, kind, ns, name string) error {
	m.deleted = append(m.deleted, kind+":"+ns+"/"+name)
	return nil
}
func (m *mockKube) List(_ context.Context, _, _ string, _ map[string]string) ([]Object, error) {
	return m.pods, nil
}

func cfg() Config {
	return Config{CellID: "cell-1", CellNamespace: "kodus-cell", EgressNamespace: "kodus-egress", RuntimeClass: "gvisor",
		HolderImage: "kodus/holder@sha256:a", ObserverImage: "kodus/observer@sha256:b", ResolverIP: "10.96.0.53"}
}

func ready() *mockKube {
	return &mockKube{exists: map[string]bool{"RuntimeClass/gvisor": true, "ValidatingAdmissionPolicy/kodus-runtime-cell-sandbox": true, "CustomResourceDefinition/ciliumnetworkpolicies.cilium.io": true}}
}

// S-10: the cell does not start without the RuntimeClass and the policy.
func TestRefusesClusterWithoutIsolation(t *testing.T) {
	if _, err := New(context.Background(), &mockKube{exists: map[string]bool{}}, cfg()); !errors.Is(err, ErrNoRuntimeClass) {
		t.Fatal(err)
	}
	if _, err := New(context.Background(), &mockKube{exists: map[string]bool{"RuntimeClass/gvisor": true}}, cfg()); !errors.Is(err, ErrNoAdmission) {
		t.Fatal(err)
	}
}

func dump(o Object) string { b, _ := json.Marshal(o); return string(b) }

func TestClaimNamespaceAndPolicies(t *testing.T) {
	k := ready()
	d, err := New(context.Background(), k, cfg())
	if err != nil {
		t.Fatal(err)
	}
	net, err := d.PrepareClaim(context.Background(), driver.ClaimNetworkSpec{CellID: "cell-1", OrgID: "org-a", ClaimID: "Claim-1", Expose: []driver.ExposePort{{Service: "api", Port: 3000, Kind: "http"}}})
	if err != nil || net.WorkloadGroupID != "kodus-claim-1" {
		t.Fatal(net, err)
	}
	kinds := map[string]string{}
	for _, o := range k.applied {
		kinds[o["kind"].(string)+"/"+o["metadata"].(map[string]any)["name"].(string)] = dump(o)
	}
	if !strings.Contains(kinds["NetworkPolicy/default-deny"], `"policyTypes":["Ingress","Egress"]`) || !strings.Contains(kinds["NetworkPolicy/default-deny"], `"podSelector":{}`) {
		t.Fatalf("default deny: %s", kinds["NetworkPolicy/default-deny"])
	}
	w := kinds["NetworkPolicy/workload"]
	if !strings.Contains(w, `"kodus.io/role":"observer"`) || !strings.Contains(w, `"port":3000`) || !strings.Contains(w, "kodus-egress") || strings.Contains(w, "0.0.0.0/0") {
		t.Fatalf("workload policy: %s", w)
	}
}

func TestPodIsSandboxed(t *testing.T) {
	k := ready()
	d, _ := New(context.Background(), k, cfg())
	now := time.Now()
	_, err := d.Create(context.Background(), driver.MachineSpec{CellID: "cell-1", EnvironmentID: "env", Role: driver.RoleWorkload, OrgID: "org-a", ClaimID: "claim-1",
		ImageID: "img", ClaimGroupID: "kodus-claim-1", KMSKeyRef: "local", ExpiresAt: now.Add(5 * time.Minute), HardExpiresAt: now.Add(time.Hour),
		Size: driver.MachineSize{CPU: 2, MemoryGB: 4, DiskGB: 20}})
	if err != nil {
		t.Fatal(err)
	}
	pod := k.applied[len(k.applied)-1]
	spec := pod["spec"].(map[string]any)
	if spec["runtimeClassName"] != "gvisor" || spec["automountServiceAccountToken"] != false || spec["hostNetwork"] != false || spec["hostPID"] != false {
		t.Fatalf("pod spec %s", dump(pod))
	}
	if dl := spec["activeDeadlineSeconds"].(int64); dl < 3500 || dl > 3600 {
		t.Fatalf("deadline %d", dl)
	}
	if strings.Contains(dump(pod), "hostPath") || !strings.Contains(dump(pod), `"drop":["ALL"]`) || !strings.Contains(dump(pod), "10.96.0.53") {
		t.Fatalf("pod %s", dump(pod))
	}
}

func TestListMapsLabelsAndAnnotationsAndSetExpiryOnlyTouchesExpires(t *testing.T) {
	k := ready()
	d, _ := New(context.Background(), k, cfg())
	k.pods = []Object{{"metadata": map[string]any{"name": "workload-claim-1", "namespace": "kodus-claim-1",
		"labels":      map[string]any{"kodus.io/cell": "cell-1", "kodus.io/claim": "claim-1"},
		"annotations": map[string]any{"kodus.io/hard-expires": "2026-10-29T13:00:00Z", "kodus.io/expires": "2026-10-29T12:05:00Z"}}}}
	refs, err := d.List(context.Background(), map[string]string{driver.TagCell: "cell-1"})
	if err != nil || len(refs) != 1 || refs[0].Tags[driver.TagHardExpires] != "2026-10-29T13:00:00Z" {
		t.Fatal(refs, err)
	}
	_ = d.SetExpiry(context.Background(), refs[0], time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC))
	patch := dump(k.applied[len(k.applied)-1])
	if strings.Contains(patch, "hard-expires") || !strings.Contains(patch, `"kodus.io/expires":"2026-10-29T13:00:00Z"`) {
		t.Fatalf("patch %s", patch)
	}
	if err := d.Destroy(context.Background(), refs[0]); err != nil || k.deleted[0] != "Pod:kodus-claim-1/workload-claim-1" {
		t.Fatal(k.deleted, err)
	}
}

// On a CNI that ignores NetworkPolicy every policy is decorative: the cell
// does not start.
func TestRefusesClusterWhoseCNIDoesNotEnforceNetworkPolicy(t *testing.T) {
	k := ready()
	delete(k.exists, "CustomResourceDefinition/ciliumnetworkpolicies.cilium.io")
	if _, err := New(context.Background(), k, cfg()); !errors.Is(err, ErrNoNetworkPolicyEnforcement) {
		t.Fatal(err)
	}
}

// An empty ports list means every port: with no expose, no rule from the
// observer to the workload; egress reaches only the proxy and resolver ports.
func TestPoliciesWithoutExposeAndEgressPorts(t *testing.T) {
	k := ready()
	d, _ := New(context.Background(), k, cfg())
	if _, err := d.PrepareClaim(context.Background(), driver.ClaimNetworkSpec{CellID: "cell-1", OrgID: "org-a", ClaimID: "claim-1"}); err != nil {
		t.Fatal(err)
	}
	for _, o := range k.applied {
		if o["kind"] != "NetworkPolicy" || o["metadata"].(map[string]any)["name"] == "default-deny" {
			continue
		}
		j := dump(o)
		if strings.Contains(j, `"ports":null`) {
			t.Fatalf("all-ports rule: %s", j)
		}
		if !strings.Contains(j, `"port":443`) || strings.Contains(j, `"port":9443`) {
			t.Fatalf("egress ports: %s", j)
		}
	}
	w := ""
	for _, o := range k.applied {
		if o["metadata"].(map[string]any)["name"] == "workload" {
			w = dump(o)
		}
	}
	if strings.Contains(w, `"kodus.io/role":"observer"`) {
		t.Fatalf("observer reaches the workload with no expose: %s", w)
	}
}

func TestDestroyRefusesAnotherCellsPod(t *testing.T) {
	k := ready()
	d, _ := New(context.Background(), k, cfg())
	k.pods = []Object{{"metadata": map[string]any{"name": "workload-x", "namespace": "kube-system", "labels": map[string]any{"kodus.io/cell": "cell-2"}}}}
	if err := d.Destroy(context.Background(), driver.MachineRef{DriverRef: "kube-system/workload-x"}); !errors.Is(err, driver.ErrNotOwned) {
		t.Fatal(err)
	}
	if len(k.deleted) != 0 {
		t.Fatal("deleted another cell's pod")
	}
}
