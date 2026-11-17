package k8ssandbox

import (
	"fmt"
	"regexp"
	"strings"
)

// The environment namespace (docs/runtime/kubernetes-environment-runs.md):
// environment Runs cannot live in the restricted sandbox namespace (the
// builder and Kata's in-pod dockerd fail it), so the chart makes a second
// namespace per cell at Pod Security privileged and the gate is a
// ValidatingAdmissionPolicy instead. The gVisor or Kata boundary stays the
// isolation, as on the cell's own hosts; the gate keeps every pod on it and
// off the node.

// EnvGatePolicy is the ValidatingAdmissionPolicy's name (and its binding's).
const EnvGatePolicy = "kodus-runtime-environment-gate"

var runtimeClassName = regexp.MustCompile(`^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$`)

// eachContainer is pred over every container of the pod (containers, init
// containers and ephemeral containers: three lists of different types, so
// three checks).
func eachContainer(pred string) string {
	return fmt.Sprintf("object.spec.containers.all(c, %[1]s) && "+
		"(!has(object.spec.initContainers) || object.spec.initContainers.all(c, %[1]s)) && "+
		"(!has(object.spec.ephemeralContainers) || object.spec.ephemeralContainers.all(c, %[1]s))", pred)
}

// EnvGateValidations are the gate's rules, each a CEL expression on the pod
// and the message the API server answers when it fails. Exported for the
// tests that read them; the manifest is EnvironmentNamespace.
func EnvGateValidations(classes []string) []map[string]any {
	quoted := make([]string, len(classes))
	for i, c := range classes {
		quoted[i] = "'" + c + "'"
	}
	allowed := "[" + strings.Join(quoted, ", ") + "]"
	return []map[string]any{
		{
			"expression": "has(object.spec.runtimeClassName) && object.spec.runtimeClassName in " + allowed,
			"message":    "an environment pod runs on one of the RuntimeClasses " + strings.Join(classes, ", "),
			"reason":     "Forbidden",
		},
		{
			"expression": "!has(object.spec.volumes) || object.spec.volumes.all(v, !has(v.hostPath))",
			"message":    "an environment pod mounts no hostPath",
			"reason":     "Forbidden",
		},
		{
			"expression": "!(has(object.spec.hostNetwork) && object.spec.hostNetwork) && !(has(object.spec.hostPID) && object.spec.hostPID) && !(has(object.spec.hostIPC) && object.spec.hostIPC)",
			"message":    "an environment pod shares no host namespace (hostNetwork, hostPID, hostIPC)",
			"reason":     "Forbidden",
		},
		{
			"expression": eachContainer("!has(c.ports) || c.ports.all(p, !has(p.hostPort) || p.hostPort == 0)"),
			"message":    "an environment pod opens no host port",
			"reason":     "Forbidden",
		},
		{
			"expression": "has(object.spec.automountServiceAccountToken) && object.spec.automountServiceAccountToken == false && " +
				"(!has(object.spec.volumes) || object.spec.volumes.all(v, !has(v.projected) || !has(v.projected.sources) || v.projected.sources.all(s, !has(s.serviceAccountToken))))",
			"message": "an environment pod carries no service account token (automountServiceAccountToken: false, no projected token)",
			"reason":  "Forbidden",
		},
		{
			// Kata's in-pod dockerd needs privileged confined to the guest
			// (privileged_without_host_devices); no other class gets it.
			"expression": "(has(object.spec.runtimeClassName) && object.spec.runtimeClassName.startsWith('kata')) || (" +
				eachContainer("!has(c.securityContext) || !has(c.securityContext.privileged) || c.securityContext.privileged == false") + ")",
			"message": "an environment pod is privileged only on a kata RuntimeClass",
			"reason":  "Forbidden",
		},
	}
}

// EnvironmentNamespace is what the chart installs for a cell's environment
// namespace: the namespace at Pod Security privileged (warn and audit at
// baseline), the gate (a ValidatingAdmissionPolicy and its binding to that
// namespace only), a default-deny NetworkPolicy for every pod in it, and
// the Role the cell's ServiceAccount is bound to there. classes are the
// RuntimeClasses an environment pod may run on.
func EnvironmentNamespace(namespace string, classes []string) ([]Object, error) {
	if !runtimeClassName.MatchString(namespace) || len(namespace) > 63 || strings.Contains(namespace, ".") {
		return nil, fmt.Errorf("k8ssandbox: %q is not a namespace name", namespace)
	}
	if len(classes) == 0 {
		return nil, fmt.Errorf("k8ssandbox: the gate needs at least one RuntimeClass")
	}
	for _, c := range classes {
		if !runtimeClassName.MatchString(c) || len(c) > 253 {
			return nil, fmt.Errorf("k8ssandbox: %q is not a RuntimeClass name", c)
		}
	}
	labels := map[string]any{"app.kubernetes.io/part-of": "kodus-runtime", "app.kubernetes.io/component": "environments"}
	nsLabels := map[string]any{
		"pod-security.kubernetes.io/enforce": "privileged",
		"pod-security.kubernetes.io/warn":    "baseline",
		"pod-security.kubernetes.io/audit":   "baseline",
	}
	for k, v := range labels {
		nsLabels[k] = v
	}
	objs := []Object{
		{"apiVersion": "v1", "kind": "Namespace", "metadata": map[string]any{"name": namespace, "labels": nsLabels}},
		{
			"apiVersion": "admissionregistration.k8s.io/v1", "kind": "ValidatingAdmissionPolicy",
			"metadata": map[string]any{"name": EnvGatePolicy, "labels": labels},
			"spec": map[string]any{
				"failurePolicy": "Fail",
				"matchConstraints": map[string]any{"resourceRules": []any{map[string]any{
					"apiGroups": []any{""}, "apiVersions": []any{"v1"},
					"operations": []any{"CREATE", "UPDATE"}, "resources": []any{"pods", "pods/ephemeralcontainers"},
				}}},
				"validations": toAnyList(EnvGateValidations(classes)),
			},
		},
		{
			"apiVersion": "admissionregistration.k8s.io/v1", "kind": "ValidatingAdmissionPolicyBinding",
			"metadata": map[string]any{"name": EnvGatePolicy, "labels": labels},
			"spec": map[string]any{
				"policyName": EnvGatePolicy, "validationActions": []any{"Deny"},
				"matchResources": map[string]any{"namespaceSelector": map[string]any{"matchLabels": map[string]any{"kubernetes.io/metadata.name": namespace}}},
			},
		},
		{
			"apiVersion": "networking.k8s.io/v1", "kind": "NetworkPolicy",
			"metadata": map[string]any{"name": "default-deny", "namespace": namespace, "labels": labels},
			"spec":     map[string]any{"podSelector": map[string]any{}, "policyTypes": []any{"Ingress", "Egress"}},
		},
		{
			"apiVersion": "rbac.authorization.k8s.io/v1", "kind": "Role",
			"metadata": map[string]any{"name": "kodus-runtime-cell-environments", "namespace": namespace, "labels": labels},
			"rules": []any{
				map[string]any{"apiGroups": []any{""}, "resources": []any{"pods"}, "verbs": []any{"create", "get", "list", "delete", "patch"}},
				map[string]any{"apiGroups": []any{""}, "resources": []any{"pods/exec"}, "verbs": []any{"create", "get"}},
				map[string]any{"apiGroups": []any{""}, "resources": []any{"pods/log"}, "verbs": []any{"get"}},
				map[string]any{"apiGroups": []any{""}, "resources": []any{"persistentvolumeclaims"}, "verbs": []any{"create", "get", "list", "delete"}},
				map[string]any{"apiGroups": []any{"networking.k8s.io"}, "resources": []any{"networkpolicies"}, "verbs": []any{"create", "get", "list", "delete"}},
			},
		},
	}
	return objs, nil
}

func toAnyList(m []map[string]any) []any {
	out := make([]any, len(m))
	for i, v := range m {
		out[i] = v
	}
	return out
}
