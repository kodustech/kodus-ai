package recipe

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestNamedValidationsAreExplicitAndBounded(t *testing.T) {
	r, err := Parse([]byte("version: 1\nvalidate: [{name: Unit tests, run: pnpm test}]\n"))
	if err != nil {
		t.Fatal(err)
	}
	if r.HasBootSteps() {
		t.Fatal("internal validation became a boot step")
	}
	for _, key := range r.Unapplied() {
		if key == "validate" {
			t.Fatal("explicit validation remains unapplied")
		}
	}
	for _, v := range []string{"validate: true", "validate: [{name: lint}]", "validate: [{name: lint, run: true}]", "validate: [{name: lint, run: make, cwd: /tmp}]", "validate: [{name: lint, run: make}, {name: lint, run: other}]", "validate: [{name: lint, run: '   '}]"} {
		if _, err := Parse([]byte("version: 1\n" + v + "\n")); err == nil {
			t.Fatalf("accepted malformed validation: %s", v)
		}
	}
}

func TestValidationSharedCases(t *testing.T) {
	b, err := os.ReadFile(filepath.Join(repoRoot, contractFixtures, "validation-cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name     string `json:"name"`
		YAML     string `json:"yaml"`
		Accepted bool   `json:"accepted"`
	}
	if err = json.Unmarshal(b, &cases); err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			_, err := Parse([]byte(c.YAML))
			if (err == nil) != c.Accepted {
				t.Fatalf("acceptance mismatch: %v", err)
			}
		})
	}
}
