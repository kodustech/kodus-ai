package recipe

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// The alias a repository gets without one is the worker's
// (repositoryAliasOf), from the shared vectors.
func TestAliasOfIsTheWorkers(t *testing.T) {
	b, err := os.ReadFile(filepath.Join(repoRoot, "libs", "runtime", "protocol", "fixtures", "workspace", "vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Aliases []struct {
			Name  string  `json:"name"`
			Alias *string `json:"alias"`
		} `json:"aliases"`
	}
	if err := json.Unmarshal(b, &v); err != nil || len(v.Aliases) == 0 {
		t.Fatalf("vectors: %v", err)
	}
	for _, c := range v.Aliases {
		want := ""
		if c.Alias != nil {
			want = *c.Alias
		}
		if got := AliasOf(c.Name); got != want {
			t.Fatalf("AliasOf(%q) = %q, want %q", c.Name, got, want)
		}
	}
}

const needsRecipe = "version: 1\nservices:\n  compose: { public: api }\n  needs:\n    - { repo: acme/billing }\n    - { repo: acme/web, alias: front }\n"

func TestNeedsResolveTheirAliases(t *testing.T) {
	r, err := Parse([]byte(needsRecipe))
	if err != nil {
		t.Fatal(err)
	}
	if want := []Need{{Repo: "acme/billing", Alias: "billing"}, {Repo: "acme/web", Alias: "front"}}; !slices.Equal(r.Services.Needs, want) {
		t.Fatalf("needs %v", r.Services.Needs)
	}
	for _, empty := range []string{"version: 1\n", "version: 1\nservices:\n  needs: []\n"} {
		if r, err := Parse([]byte(empty)); err != nil || len(r.Services.Needs) != 0 {
			t.Fatalf("%q: needs %v, %v", empty, r, err)
		}
	}
}

// A need is never the environment's own repository, nor in its directory.
func TestNeedsNeverNameTheEnvironmentsOwnRepository(t *testing.T) {
	r, err := Parse([]byte(needsRecipe))
	if err != nil {
		t.Fatal(err)
	}
	if err := r.NeedsConflict("acme/shop", "shop"); err != nil {
		t.Fatal(err)
	}
	if err := r.NeedsConflict("ACME/Billing", "shop"); err == nil || !strings.Contains(err.Error(), "own repository") {
		t.Fatalf("the own repository as a need: %v", err)
	}
	if err := r.NeedsConflict("acme/shop", "front"); err == nil || !strings.Contains(err.Error(), "alias front") {
		t.Fatalf("the own alias taken: %v", err)
	}
}

func TestNeedsScalarsAreStrings(t *testing.T) {
	for text, want := range map[string]string{
		"version: 1\nservices:\n  needs: [{ repo: acme/billing, alias: 123 }]\n": "services.needs[0].alias: expected string",
		"version: 1\nservices:\n  needs: [{ alias: billing }]\n":                 "services.needs[0].repo: expected string",
		"version: 1\nservices:\n  needs: [acme/billing]\n":                       "services.needs[0]: a repository is a mapping",
		"version: 1\nservices:\n  needs: acme/billing\n":                         needsShape,
	} {
		if _, err := Parse([]byte(text)); err == nil || !strings.Contains(err.Error(), want) {
			t.Fatalf("%q: %v, want %s", text, err, want)
		}
	}
}
