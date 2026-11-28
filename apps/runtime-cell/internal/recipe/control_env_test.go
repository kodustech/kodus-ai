package recipe

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The same file runs in libs/runtime/protocol/recipe-control-env.spec.ts: one
// deny list for the worker and the cell. Before it, the two lists were typed
// twice and a name added on one side only went unnoticed.

func TestControlEnvListIsTheWorkersCopy(t *testing.T) {
	ts, err := os.ReadFile(filepath.Join(repoRoot, "libs", "runtime", "protocol", "recipe-control-env.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(ts, controlEnvJSON) {
		t.Fatal("internal/recipe/recipe-control-env.json differs from libs/runtime/protocol/recipe-control-env.json: copy it over")
	}
}

func TestARecipeNeverSetsAControlEnvName(t *testing.T) {
	refused := append([]string{}, controlEnv.Names...)
	for _, p := range controlEnv.Prefixes {
		refused = append(refused, p+"X")
	}
	refused = append(refused, controlEnv.Cases.Refused...)
	for _, name := range refused {
		for where, y := range map[string]string{
			"services.compose.env": "version: 1\nservices: { compose: { env: { " + name + ": x } } }\n",
			"fakes.stripe.env":     "version: 1\nfakes: { stripe: { image: stripe-mock, env: { " + name + ": x } } }\n",
		} {
			_, err := Parse([]byte(y))
			if err == nil || !strings.Contains(err.Error(), "changes what runs") {
				t.Errorf("%s in %s: got %v, want the control-env refusal", name, where, err)
			}
		}
	}
}

func TestAnAppNameThatOnlyLooksLikeAControlEnvIsAccepted(t *testing.T) {
	for _, name := range controlEnv.Cases.Allowed {
		if _, err := Parse([]byte("version: 1\nservices: { compose: { env: { " + name + ": x } } }\n")); err != nil {
			t.Errorf("%s refused: %v", name, err)
		}
	}
}
