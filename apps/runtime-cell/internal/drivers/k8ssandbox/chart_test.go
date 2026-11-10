package k8ssandbox

import (
	"os"
	"strings"
	"testing"

	"go.yaml.in/yaml/v3"
)

// The admission policy the driver checks for exists in the chart and covers
// every S-10 rule for the cluster.
func TestChartAdmissionPolicy(t *testing.T) {
	raw, err := os.ReadFile("../../../deploy/chart/runtime-cell/templates/admission-policy.yaml")
	if err != nil {
		t.Fatal(err)
	}
	text := strings.ReplaceAll(string(raw), "{{ .Values.runtimeClass.name }}", "gvisor")
	dec := yaml.NewDecoder(strings.NewReader(text))
	var policy map[string]any
	if err := dec.Decode(&policy); err != nil {
		t.Fatal(err)
	}
	if policy["metadata"].(map[string]any)["name"] != "kodus-runtime-cell-sandbox" || policy["spec"].(map[string]any)["failurePolicy"] != "Fail" {
		t.Fatalf("policy %v", policy["metadata"])
	}
	var all []string
	for _, v := range policy["spec"].(map[string]any)["validations"].([]any) {
		all = append(all, v.(map[string]any)["expression"].(string))
	}
	joined := strings.Join(all, "\n")
	for _, must := range []string{"runtimeClassName == 'gvisor'", "hostNetwork", "hostPID", "hostIPC", "automountServiceAccountToken", "hostPath", "privileged", "capabilities.add", "allowPrivilegeEscalation", "ephemeralContainers"} {
		if !strings.Contains(joined, must) {
			t.Errorf("policy lacks %s", must)
		}
	}
	var binding map[string]any
	if err := dec.Decode(&binding); err != nil || binding["kind"] != "ValidatingAdmissionPolicyBinding" {
		t.Fatalf("binding %v %v", binding, err)
	}
}
