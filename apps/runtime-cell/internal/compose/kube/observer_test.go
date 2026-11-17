package kube

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"go.yaml.in/yaml/v3"
)

func observerSpec() ObserverSpec {
	return ObserverSpec{
		Image:  "registry.example/kodus-runtime-cell@sha256:3333333333333333333333333333333333333333333333333333333333333333",
		CellID: "cell-a", MemoryMB: 256, MilliCPU: 250,
	}
}

// The claim's observer is a pod of its own on the claim's RuntimeClass with
// the claim's labels in the observer's role: no token, no host namespace,
// RuntimeDefault seccomp, non-root, read-only, its own size and the claim's
// deadline, serving on loopback only, held at the gate until the cell copied
// its TLS files in; its policy lets it reach the claim's service pods and
// nothing reach it, and the claim's policy admits it.
func TestTheObserverPodAndPoliciesMatchTheirGoldenFile(t *testing.T) {
	ob, err := ObserverPod(opts(), observerSpec())
	if err != nil {
		t.Fatal(err)
	}
	if ob.PodName != "env-claim-1--observer" {
		t.Errorf("pod name %q", ob.PodName)
	}
	plan := render(t, "services:\n  web:\n    image: nginx\n")
	got, err := yaml.Marshal(map[string]any{"observer": ob.Pod, "observerPolicy": ObserverPolicy(opts()), "claimPolicy": plan.Policy})
	if err != nil {
		t.Fatal(err)
	}
	file := filepath.Join("testdata", "observer.golden.yaml")
	if *update {
		if err := os.WriteFile(file, got, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(file)
	if err != nil || string(got) != string(want) {
		t.Errorf("observer differs from %s (run with -update and read the diff): %v\n%s", file, err, got)
	}
	sp := ob.Pod["spec"].(map[string]any)
	c := sp["containers"].([]any)[0].(map[string]any)
	sec := c["securityContext"].(map[string]any)
	if sec["runAsNonRoot"] != true || sec["readOnlyRootFilesystem"] != true || sec["allowPrivilegeEscalation"] != false || sp["automountServiceAccountToken"] != false {
		t.Errorf("observer container %v", sec)
	}
	if !slices.Contains(toStrings(c["command"]), "127.0.0.1:7443") {
		t.Errorf("the observer listens beyond loopback: %v", c["command"])
	}
	for _, bad := range []ObserverSpec{{CellID: "c", MemoryMB: 1, MilliCPU: 1}, {Image: "i", MemoryMB: 1, MilliCPU: 1}, {Image: "i", CellID: "c"}} {
		if _, err := ObserverPod(opts(), bad); err == nil {
			t.Errorf("an observer of %+v", bad)
		}
	}
}

func toStrings(v any) []string {
	var out []string
	for _, e := range v.([]any) {
		out = append(out, e.(string))
	}
	return out
}

// selects is a NetworkPolicy label selector (matchLabels and the In and
// NotIn expressions the renderer writes) against a pod's labels.
func selects(t *testing.T, sel map[string]any, labels map[string]string) bool {
	t.Helper()
	ml, _ := sel["matchLabels"].(map[string]any)
	for k, v := range ml {
		if labels[k] != v {
			return false
		}
	}
	exprs, _ := sel["matchExpressions"].([]any)
	for _, e := range exprs {
		em := e.(map[string]any)
		v, has := labels[em["key"].(string)]
		in := has && slices.Contains(toStrings(em["values"]), v)
		switch em["operator"] {
		case "In":
			if !in {
				return false
			}
		case "NotIn":
			if in {
				return false
			}
		default:
			t.Fatalf("operator %v", em["operator"])
		}
	}
	return true
}

// peers are the pod selectors of a policy's ingress from or egress to.
func peers(t *testing.T, pol Object, dir, key string) []map[string]any {
	t.Helper()
	var out []map[string]any
	rules, _ := pol["spec"].(map[string]any)[dir].([]any)
	for _, r := range rules {
		for _, p := range r.(map[string]any)[key].([]any) {
			pm := p.(map[string]any)
			if ps, ok := pm["podSelector"].(map[string]any); ok && pm["namespaceSelector"] == nil && pm["ipBlock"] == nil {
				out = append(out, ps)
			}
		}
	}
	return out
}

func anySelects(t *testing.T, sels []map[string]any, labels map[string]string) bool {
	for _, s := range sels {
		if selects(t, s, labels) {
			return true
		}
	}
	return false
}

// The claim's observer reaches the claim's service pods and only them;
// nothing reaches the observer; the claim's pods accept their own observer
// and never another claim's: claim policies select by the claim's labels, so
// another claim's observer is in no peer of this claim's policies.
func TestOnlyTheClaimsOwnObserverReachesItsServices(t *testing.T) {
	pod := func(claim, role string) map[string]string {
		return map[string]string{"kodus.io/cell": "cell-a", "kodus.io/org": "org-1", "kodus.io/claim": claim, RoleLabel: role}
	}
	own, other := pod("claim-1", ObserverRole), pod("claim-2", ObserverRole)
	web, otherWeb, builder := pod("claim-1", "workload"), pod("claim-2", "workload"), pod("claim-1", BuilderRole)

	claimPol := render(t, "services:\n  web:\n    image: nginx\n").Policy
	cs := claimPol["spec"].(map[string]any)["podSelector"].(map[string]any)
	if selects(t, cs, own) || !selects(t, cs, web) || !selects(t, cs, builder) {
		t.Error("the claim's policy must select its services and builders, never its observer (it would open the observer to them)")
	}
	from := peers(t, claimPol, "ingress", "from")
	if !anySelects(t, from, own) {
		t.Error("the claim's services do not accept their observer")
	}
	if anySelects(t, from, other) {
		t.Error("the claim's services accept another claim's observer")
	}
	if anySelects(t, peers(t, claimPol, "egress", "to"), own) {
		t.Error("the claim's services may connect to their observer")
	}

	obsPol := ObserverPolicy(opts())
	spec := obsPol["spec"].(map[string]any)
	osel := spec["podSelector"].(map[string]any)
	if !selects(t, osel, own) || selects(t, osel, other) || selects(t, osel, web) {
		t.Error("the observer policy selects more than the claim's observer")
	}
	if !slices.Equal(toStrings(spec["policyTypes"]), []string{"Ingress", "Egress"}) || spec["ingress"] != nil {
		t.Errorf("the observer accepts connections: %v", spec)
	}
	to := peers(t, obsPol, "egress", "to")
	if !anySelects(t, to, web) || anySelects(t, to, otherWeb) || anySelects(t, to, builder) || anySelects(t, to, other) {
		t.Error("the observer reaches more than its claim's services")
	}
	if eg := spec["egress"].([]any); len(eg) != 1 {
		t.Errorf("the observer has egress beyond its claim's services (the cell's resolver or proxy): %v", eg)
	}
}

// The observer's share comes out of the claim's size before the services
// and the builder split it, as docker-gvisor's observer runs in its claim's
// budget.
func TestTheObserversShareComesOutOfTheClaimsSize(t *testing.T) {
	o := opts()
	o.Reserved = Share{MemoryMB: 256, MilliCPU: 250}
	p, err := Render([]byte("services:\n  a: {image: x}\n  b: {image: y}\n"), o)
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range p.Services {
		lim := container(s)["resources"].(map[string]any)["limits"].(map[string]any)
		if lim["memory"] != "896Mi" || lim["cpu"] != "875m" {
			t.Errorf("%s limits %v", s.Name, lim)
		}
	}
	b, err := BuilderPod(o, BuildPod{Service: "a", Image: "b"})
	if err != nil {
		t.Fatal(err)
	}
	lim := b.Pod["spec"].(map[string]any)["containers"].([]any)[0].(map[string]any)["resources"].(map[string]any)["limits"].(map[string]any)
	if lim["memory"] != "1792Mi" || lim["cpu"] != "1750m" {
		t.Errorf("builder limits %v", lim)
	}
	o.Reserved = Share{MemoryMB: 2040, MilliCPU: 250}
	if _, err := Render([]byte("services:\n  a: {image: x}\n"), o); err == nil || !strings.Contains(err.Error(), "memory") {
		t.Errorf("services that no longer fit beside the observer: %v", err)
	}
}
