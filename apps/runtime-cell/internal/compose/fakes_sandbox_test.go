package compose_test

import (
	"encoding/json"
	"net/netip"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose/sandbox"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/recipe"
	"go.yaml.in/yaml/v3"
)

// Generated fake services still pass through exactly the application sandbox
// transformation. A declaration never exempts an image from runsc or budgets.
func TestDeclaredFakeReceivesCanonicalClaimIsolationAndBudget(t *testing.T) {
	project, err := compose.FromYAML([]byte("services: { app: { image: application } }\n"))
	if err != nil {
		t.Fatal(err)
	}
	rec, err := recipe.Parse([]byte("version: 1\nfakes: { email: { image: axllent/mailpit@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb } }\n"))
	if err != nil {
		t.Fatal(err)
	}
	if err := project.AddRecipeFakes(rec); err != nil {
		t.Fatal(err)
	}
	raw, _ := project.Marshal()
	options := sandbox.Options{ProjectDir: t.TempDir(), Project: "kodus-claim-workload", Runtime: "runsc", Network: "kodus-claim", Subnet: netip.MustParsePrefix("10.123.0.0/24"), MemLimit: "4g", CPUs: "2", Labels: map[string]string{"kodus.claim": "claim-a"}}
	canonical, err := sandbox.Apply(raw, options)
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err := yaml.Unmarshal(canonical, &doc); err != nil {
		t.Fatal(err)
	}
	config, _ := json.Marshal(doc)
	if err := sandbox.VerifyCanonical(config, options); err != nil {
		t.Fatal(err)
	}
	fake := doc["services"].(map[string]any)["mailpit"].(map[string]any)
	if fake["runtime"] != "runsc" || fake["mem_limit"] != "4g" || fake["cpus"] != "2" || fake["labels"].(map[string]any)["kodus.claim"] != "claim-a" {
		t.Fatal("fake bypassed the canonical claim boundary")
	}
	if _, published := fake["ports"]; published {
		t.Fatal("fake published a host port")
	}
	if _, persistent := fake["volumes"]; persistent {
		t.Fatal("fake gained a persistent volume")
	}
}
