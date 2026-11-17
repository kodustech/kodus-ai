package k8ssandbox

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"github.com/google/cel-go/cel"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose/kube"
)

// gate evaluates the gate's rules on a pod with CEL, as the API server's
// ValidatingAdmissionPolicy does (the object untyped: has() reads a key's
// presence, as on the typed pod), and returns the messages of the rules it
// fails.
func gate(t *testing.T, pod Object) []string {
	t.Helper()
	env, err := cel.NewEnv(cel.Variable("object", cel.DynType))
	if err != nil {
		t.Fatal(err)
	}
	obj := celValue(t, pod)
	var failed []string
	for _, v := range EnvGateValidations([]string{"gvisor"}) {
		ast, iss := env.Compile(v["expression"].(string))
		if iss.Err() != nil {
			t.Fatalf("rule %q does not compile: %v", v["message"], iss.Err())
		}
		prg, err := env.Program(ast)
		if err != nil {
			t.Fatal(err)
		}
		out, _, err := prg.Eval(map[string]any{"object": obj})
		if err != nil {
			t.Fatalf("rule %q on the pod: %v", v["message"], err)
		}
		if ok, _ := out.Value().(bool); !ok {
			failed = append(failed, v["message"].(string))
		}
	}
	return failed
}

// celValue is the pod as the API server hands it to CEL: JSON numbers as
// integers.
func celValue(t *testing.T, o Object) any {
	t.Helper()
	b, err := json.Marshal(o)
	if err != nil {
		t.Fatal(err)
	}
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		t.Fatal(err)
	}
	var fix func(any) any
	fix = func(v any) any {
		switch x := v.(type) {
		case map[string]any:
			for k, e := range x {
				x[k] = fix(e)
			}
		case []any:
			for i, e := range x {
				x[i] = fix(e)
			}
		case json.Number:
			n, err := x.Int64()
			if err != nil {
				t.Fatalf("number %s", x)
			}
			return n
		}
		return v
	}
	return fix(v)
}

// servicePod is a service pod as the renderer writes it.
func servicePod(t *testing.T) Object {
	t.Helper()
	plan, err := kube.Render([]byte("services:\n  web:\n    image: nginx\n"), kube.Options{
		Namespace: "envs", Prefix: "env-c", Labels: map[string]string{"kodus.io/claim": "c", kube.RoleLabel: "workload"},
		Selector: map[string]string{"kodus.io/claim": "c"}, RuntimeClass: "gvisor", HelperImage: "helper",
		Size: kube.Size{MemoryMB: 512, CPUs: 1}, DeadlineSeconds: 60, Nameservers: []string{"10.0.0.53"},
	})
	if err != nil {
		t.Fatal(err)
	}
	return roundTrip(plan.Services[0].Pod)
}

// builderShaped is the builder pod's shape (BuildKit's pod.rootless.yaml
// in the cell's form): the gate init container confined by the pod's
// RuntimeDefault, the buildkitd container Unconfined as uid 1000.
func builderShaped() Object {
	return roundTrip(Object{
		"apiVersion": "v1", "kind": "Pod",
		"metadata": map[string]any{"name": "env-c--build-web", "labels": map[string]any{"kodus.io/claim": "c", kube.RoleLabel: kube.BuilderRole}},
		"spec": map[string]any{
			"runtimeClassName": "gvisor", "automountServiceAccountToken": false,
			"securityContext": map[string]any{"seccompProfile": map[string]any{"type": "RuntimeDefault"}},
			"initContainers": []any{map[string]any{"name": kube.InitContainer, "image": "helper",
				"securityContext": map[string]any{"allowPrivilegeEscalation": false, "privileged": false, "runAsUser": 0}}},
			"containers": []any{map[string]any{"name": kube.BuilderContainer, "image": "builder",
				"securityContext": map[string]any{
					"seccompProfile": map[string]any{"type": "Unconfined"}, "appArmorProfile": map[string]any{"type": "Unconfined"},
					"runAsUser": kube.BuilderUID, "runAsGroup": kube.BuilderUID, "runAsNonRoot": true, "privileged": false,
					"capabilities": map[string]any{"drop": []any{"NET_RAW", "AUDIT_WRITE"}},
				}}},
		},
	})
}

func container(p Object, list string, i int) map[string]any {
	return p["spec"].(map[string]any)[list].([]any)[i].(map[string]any)
}

func secCtx(p Object, list string, i int) map[string]any {
	c := container(p, list, i)
	if c["securityContext"] == nil {
		c["securityContext"] = map[string]any{}
	}
	return c["securityContext"].(map[string]any)
}

// The gate lets a rendered service pod and the builder's pod through, and
// a builder's own container is the only one that may run without a seccomp
// or AppArmor profile: as uid 1000, unprivileged, with no capability added
// and the default /proc, on a pod labeled the builder's. Everything else
// that would leave a container unconfined is refused, a service pod
// asking for Unconfined first of all.
func TestTheGateLetsOnlyTheBuilderContainerRunUnconfined(t *testing.T) {
	if failed := gate(t, servicePod(t)); len(failed) != 0 {
		t.Fatalf("a rendered service pod refused: %v", failed)
	}
	if failed := gate(t, builderShaped()); len(failed) != 0 {
		t.Fatalf("the builder's pod refused: %v", failed)
	}
	localhost := servicePod(t)
	localhost["spec"].(map[string]any)["securityContext"] = map[string]any{"seccompProfile": map[string]any{"type": "Localhost", "localhostProfile": "kodus.json"}}
	if failed := gate(t, localhost); len(failed) != 0 {
		t.Errorf("a Localhost profile refused: %v", failed)
	}
	refused := map[string]func() Object{
		"a service container with Unconfined seccomp": func() Object {
			p := servicePod(t)
			secCtx(p, "containers", 0)["seccompProfile"] = map[string]any{"type": "Unconfined"}
			return p
		},
		"a service container with Unconfined AppArmor": func() Object {
			p := servicePod(t)
			secCtx(p, "containers", 0)["appArmorProfile"] = map[string]any{"type": "Unconfined"}
			return p
		},
		"a service pod with no seccomp profile at all": func() Object {
			p := servicePod(t)
			delete(p["spec"].(map[string]any), "securityContext")
			return p
		},
		"a service pod Unconfined at the pod level": func() Object {
			p := servicePod(t)
			p["spec"].(map[string]any)["securityContext"] = map[string]any{"seccompProfile": map[string]any{"type": "Unconfined"}}
			return p
		},
		"a service pod's unconfined AppArmor annotation": func() Object {
			p := servicePod(t)
			meta(p)["annotations"].(map[string]any)["container.apparmor.security.beta.kubernetes.io/web"] = "unconfined"
			return p
		},
		"a service pod labeled the builder's, its container not buildkitd": func() Object {
			p := servicePod(t)
			meta(p)["labels"].(map[string]any)[kube.RoleLabel] = kube.BuilderRole
			secCtx(p, "containers", 0)["seccompProfile"] = map[string]any{"type": "Unconfined"}
			return p
		},
		"a buildkitd container on a pod not labeled the builder's": func() Object {
			p := builderShaped()
			meta(p)["labels"].(map[string]any)[kube.RoleLabel] = "workload"
			return p
		},
		"a privileged builder": func() Object {
			p := builderShaped()
			secCtx(p, "containers", 0)["privileged"] = true
			return p
		},
		"a builder as root": func() Object {
			p := builderShaped()
			secCtx(p, "containers", 0)["runAsUser"] = 0
			return p
		},
		"a builder with no runAsNonRoot": func() Object {
			p := builderShaped()
			delete(secCtx(p, "containers", 0), "runAsNonRoot")
			return p
		},
		"a builder adding a capability": func() Object {
			p := builderShaped()
			secCtx(p, "containers", 0)["capabilities"] = map[string]any{"add": []any{"SYS_ADMIN"}}
			return p
		},
		"a builder with an unmasked /proc": func() Object {
			p := builderShaped()
			secCtx(p, "containers", 0)["procMount"] = "Unmasked"
			return p
		},
		"a builder pod Unconfined at the pod level": func() Object {
			p := builderShaped()
			p["spec"].(map[string]any)["securityContext"] = map[string]any{"seccompProfile": map[string]any{"type": "Unconfined"}}
			return p
		},
		"a builder pod's init container Unconfined": func() Object {
			p := builderShaped()
			secCtx(p, "initContainers", 0)["seccompProfile"] = map[string]any{"type": "Unconfined"}
			return p
		},
		"a builder pod's init container named buildkitd too": func() Object {
			p := builderShaped()
			container(p, "initContainers", 0)["name"] = kube.BuilderContainer
			secCtx(p, "initContainers", 0)["appArmorProfile"] = map[string]any{"type": "Unconfined"}
			return p
		},
		"an ephemeral container Unconfined on the builder's pod": func() Object {
			p := builderShaped()
			p["spec"].(map[string]any)["ephemeralContainers"] = []any{map[string]any{"name": kube.BuilderContainer, "image": "x",
				"securityContext": map[string]any{"seccompProfile": map[string]any{"type": "Unconfined"}, "runAsUser": kube.BuilderUID, "runAsNonRoot": true}}}
			return p
		},
		"a second unconfined container on the builder's pod": func() Object {
			p := builderShaped()
			spec := p["spec"].(map[string]any)
			spec["containers"] = append(spec["containers"].([]any), map[string]any{"name": "sidecar", "image": "x",
				"securityContext": map[string]any{"seccompProfile": map[string]any{"type": "Unconfined"}, "runAsUser": kube.BuilderUID, "runAsNonRoot": true}})
			return p
		},
		"the builder's annotation on a pod with no builder container": func() Object {
			p := servicePod(t)
			meta(p)["annotations"].(map[string]any)["container.apparmor.security.beta.kubernetes.io/"+kube.BuilderContainer] = "unconfined"
			return p
		},
		"a pod-level unconfined seccomp annotation on the builder's pod": func() Object {
			p := builderShaped()
			meta(p)["annotations"] = map[string]any{"seccomp.security.alpha.kubernetes.io/pod": "unconfined"}
			return p
		},
	}
	for name, mk := range refused {
		if failed := gate(t, mk()); len(failed) == 0 {
			t.Errorf("the gate let %s through", name)
		} else if !strings.Contains(strings.Join(failed, " "), "seccomp") && !strings.Contains(strings.Join(failed, " "), "AppArmor") {
			t.Errorf("%s refused for another reason: %v", name, failed)
		}
	}
	// The API server may copy the builder's AppArmor field into the old
	// annotation (version skew): that annotation, on that container, passes.
	synced := builderShaped()
	meta(synced)["annotations"] = map[string]any{"container.apparmor.security.beta.kubernetes.io/" + kube.BuilderContainer: "unconfined"}
	if failed := gate(t, synced); len(failed) != 0 {
		t.Errorf("the builder's synced annotation refused: %v", failed)
	}
}
