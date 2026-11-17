package k8ssandbox

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose/kube"
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

// confined is pred over every container but the builder's: containers and
// init containers by c, ephemeral ones too; the builder exception (builder)
// is offered to the pod's containers only, never to an init or ephemeral
// one.
func confined(pred, exception string) string {
	return fmt.Sprintf("object.spec.containers.all(c, (%[1]s) || (%[2]s)) && "+
		"(!has(object.spec.initContainers) || object.spec.initContainers.all(c, %[1]s)) && "+
		"(!has(object.spec.ephemeralContainers) || object.spec.ephemeralContainers.all(c, %[1]s))", pred, exception)
}

// builderContainer is the one container the gate lets run without a
// seccomp or AppArmor profile: rootless BuildKit (kube's builder pod, the
// shape of BuildKit's pod.rootless.yaml) makes user namespaces and mounts,
// which RuntimeDefault refuses. It is the buildkitd container of a pod
// labeled the builder's, running as the rootless image's uid with
// runAsNonRoot, unprivileged, adding no capability, with the default /proc
// (BuildKit runs with --oci-worker-no-process-sandbox, so it needs no
// unmasked /proc). The RuntimeClass, no host namespace, no hostPath and no
// token still hold for it (the other rules).
var builderContainer = fmt.Sprintf("has(object.metadata.labels) && '%[1]s' in object.metadata.labels && object.metadata.labels['%[1]s'] == '%[2]s' && "+
	"c.name == '%[3]s' && has(c.securityContext) && "+
	"has(c.securityContext.runAsNonRoot) && c.securityContext.runAsNonRoot == true && "+
	"has(c.securityContext.runAsUser) && c.securityContext.runAsUser == %[4]d && "+
	"!(has(c.securityContext.privileged) && c.securityContext.privileged == true) && "+
	"!(has(c.securityContext.capabilities) && has(c.securityContext.capabilities.add) && size(c.securityContext.capabilities.add) > 0) && "+
	"!(has(c.securityContext.procMount) && c.securityContext.procMount != 'Default')",
	kube.RoleLabel, kube.BuilderRole, kube.BuilderContainer, kube.BuilderUID)

// builderAnnotations are the old per-container annotations of the
// builder's container, as a CEL list.
var builderAnnotations = "['container.apparmor.security.beta.kubernetes.io/" + kube.BuilderContainer + "', 'container.seccomp.security.alpha.kubernetes.io/" + kube.BuilderContainer + "']"

// seccompConfined: the container's own profile when it sets one, else the
// pod's, is RuntimeDefault or Localhost. A pod that names none would run
// Unconfined on a kubelet without SeccompDefault, so none is refused.
const seccompConfined = "(has(c.securityContext) && has(c.securityContext.seccompProfile)) ? " +
	"c.securityContext.seccompProfile.type in ['RuntimeDefault', 'Localhost'] : " +
	"(has(object.spec.securityContext) && has(object.spec.securityContext.seccompProfile) && object.spec.securityContext.seccompProfile.type in ['RuntimeDefault', 'Localhost'])"

// appArmorConfined: the container does not ask for Unconfined (unset is
// the node's default profile, where the node has AppArmor).
const appArmorConfined = "!(has(c.securityContext) && has(c.securityContext.appArmorProfile) && c.securityContext.appArmorProfile.type == 'Unconfined')"

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
		{
			"expression": confined(seccompConfined, builderContainer),
			"message": "an environment pod runs every container under a seccomp profile (RuntimeDefault or Localhost); only the image builder's " +
				kube.BuilderContainer + " container runs Unconfined, as a non-root uid " + fmt.Sprint(kube.BuilderUID) + ", unprivileged, adding no capability, with the default /proc",
			"reason": "Forbidden",
		},
		{
			"expression": "!(has(object.spec.securityContext) && has(object.spec.securityContext.appArmorProfile) && object.spec.securityContext.appArmorProfile.type == 'Unconfined') && " +
				confined(appArmorConfined, builderContainer),
			"message": "an environment pod runs no container AppArmor Unconfined but the image builder's " + kube.BuilderContainer + " container",
			"reason":  "Forbidden",
		},
		{
			// The old annotations still reach some kubelets, and the API
			// server may copy the builder's AppArmor field into one: only
			// that container's may say unconfined. No comprehension inside
			// another, so the rule's cost stays one pass over each list.
			"expression": "!has(object.metadata.annotations) || (" +
				"object.metadata.annotations.all(k, object.metadata.annotations[k] != 'unconfined' || " +
				"!(k.startsWith('container.apparmor.security.beta.kubernetes.io/') || k.startsWith('container.seccomp.security.alpha.kubernetes.io/') || k.startsWith('seccomp.security.alpha.kubernetes.io/')) || " +
				"k in " + builderAnnotations + ") && " +
				"(!" + builderAnnotations + ".exists(k, k in object.metadata.annotations && object.metadata.annotations[k] == 'unconfined') || " +
				"object.spec.containers.exists(c, " + builderContainer + ")))",
			"message": "an environment pod's seccomp and AppArmor annotations never say unconfined, but for the image builder's " + kube.BuilderContainer + " container",
			"reason":  "Forbidden",
		},
	}
}

// EnvAccess names who the environment namespace's Roles are bound to: the
// cell's ServiceAccount and the reaper's, both in the cell namespace.
type EnvAccess struct {
	CellNamespace        string
	CellServiceAccount   string
	ReaperServiceAccount string
}

// ReferenceEnvAccess is the reference manifest's (deploy/kubernetes): the
// chart's cell namespace and ServiceAccounts.
var ReferenceEnvAccess = EnvAccess{CellNamespace: "kodus-runtime", CellServiceAccount: "kodus-runtime-cell", ReaperServiceAccount: "kodus-runtime-reaper"}

// EnvCellRules are the cell's verbs in the environment namespace, each one
// an EnvAPI or CommandRunner call of the driver: pods CreatePod, GetPod
// (waits), ListPods, DeletePod and PatchPodAnnotations (the observer's
// expiry); pods/exec RunCommand, StreamCommand and DialObserver (the
// WebSocket upgrade is a GET; newer API servers ask create); pods/log
// PodLogs; volume claims and NetworkPolicies CreateObject, ListObjects and
// DeleteObject. No get on those two (the driver never reads one by name),
// no watch, no update, nothing on Secrets.
func EnvCellRules() []any {
	return []any{
		map[string]any{"apiGroups": []any{""}, "resources": []any{"pods"}, "verbs": []any{"create", "get", "list", "delete", "patch"}},
		map[string]any{"apiGroups": []any{""}, "resources": []any{"pods/exec"}, "verbs": []any{"create", "get"}},
		map[string]any{"apiGroups": []any{""}, "resources": []any{"pods/log"}, "verbs": []any{"get"}},
		map[string]any{"apiGroups": []any{""}, "resources": []any{"persistentvolumeclaims"}, "verbs": []any{"create", "list", "delete"}},
		map[string]any{"apiGroups": []any{"networking.k8s.io"}, "resources": []any{"networkpolicies"}, "verbs": []any{"create", "list", "delete"}},
	}
}

// EnvReaperRules are the reaper's there (ReapOrphans and a reaped machine's
// cleanup): pods ListPods, DeletePod and GetPod (waits); volume claims and
// NetworkPolicies ListObjects and DeleteObject. It creates nothing.
func EnvReaperRules() []any {
	return []any{
		map[string]any{"apiGroups": []any{""}, "resources": []any{"pods"}, "verbs": []any{"get", "list", "delete"}},
		map[string]any{"apiGroups": []any{""}, "resources": []any{"persistentvolumeclaims"}, "verbs": []any{"list", "delete"}},
		map[string]any{"apiGroups": []any{"networking.k8s.io"}, "resources": []any{"networkpolicies"}, "verbs": []any{"list", "delete"}},
	}
}

// EnvironmentNamespace is what the chart installs for a cell's environment
// namespace: the namespace at Pod Security privileged (warn and audit at
// baseline), the gate (a ValidatingAdmissionPolicy and its binding to that
// namespace only), a default-deny NetworkPolicy for every pod in it, and
// the cell's and the reaper's Roles there, each bound to its ServiceAccount
// (access). classes are the RuntimeClasses an environment pod may run on.
func EnvironmentNamespace(namespace string, classes []string, access EnvAccess) ([]Object, error) {
	for _, n := range []string{namespace, access.CellNamespace} {
		if !runtimeClassName.MatchString(n) || len(n) > 63 || strings.Contains(n, ".") {
			return nil, fmt.Errorf("k8ssandbox: %q is not a namespace name", n)
		}
	}
	for _, n := range []string{access.CellServiceAccount, access.ReaperServiceAccount} {
		if !runtimeClassName.MatchString(n) || len(n) > 253 {
			return nil, fmt.Errorf("k8ssandbox: %q is not a ServiceAccount name", n)
		}
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
	}
	for _, r := range []struct {
		role, account string
		rules         []any
	}{
		{"kodus-runtime-cell-environments", access.CellServiceAccount, EnvCellRules()},
		{"kodus-runtime-reaper-environments", access.ReaperServiceAccount, EnvReaperRules()},
	} {
		md := map[string]any{"name": r.role, "namespace": namespace, "labels": labels}
		objs = append(objs,
			Object{"apiVersion": "rbac.authorization.k8s.io/v1", "kind": "Role", "metadata": md, "rules": r.rules},
			Object{
				"apiVersion": "rbac.authorization.k8s.io/v1", "kind": "RoleBinding", "metadata": md,
				"roleRef":  map[string]any{"apiGroup": "rbac.authorization.k8s.io", "kind": "Role", "name": r.role},
				"subjects": []any{map[string]any{"kind": "ServiceAccount", "name": r.account, "namespace": access.CellNamespace}},
			})
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
