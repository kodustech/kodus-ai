package recipe

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"sort"
	"strings"
	"testing"
	"time"
)

// repoRoot is the repository root, from this package.
const repoRoot = "../../../.."

// contractFixtures is the recipe contract (ENV-08) the worker and Runo are
// held to as well: libs/runtime/protocol/fixtures/recipes/verdicts.json.
const contractFixtures = "libs/runtime/protocol/fixtures/recipes"

type contractVerdict struct {
	Cell string `json:"cell"`
	Runo string `json:"runo"`
	Why  string `json:"why"`
	// HealthTimeoutSeconds, when set, is the wait an accepted recipe
	// resolves to; the worker's parser reads the same (recipe-contract.spec.ts).
	HealthTimeoutSeconds *int64 `json:"healthTimeoutSeconds"`
	// HealthTimeoutDefault says the recipe sets no wait of its own (health_timeout
	// 0 is "not set"): the cell waits DefaultHealthTimeout, the worker leaves
	// healthTimeoutSeconds out so the setup's default applies.
	HealthTimeoutDefault bool `json:"healthTimeoutDefault"`
	// Unapplied are the keys an accepted recipe sets that no cell acts on
	// (Recipe.Unapplied); the worker names the same ones.
	Unapplied   []string      `json:"unapplied"`
	Size        *ResourceSize `json:"size"`
	EgressAllow []string      `json:"egressAllow"`
	Fakes       []FakeService `json:"fakes"`
}

func TestRecipeContract(t *testing.T) {
	b, err := os.ReadFile(filepath.Join(repoRoot, contractFixtures, "verdicts.json"))
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Recipes map[string]contractVerdict `json:"recipes"`
	}
	if err := json.Unmarshal(b, &doc); err != nil {
		t.Fatal(err)
	}
	listed := map[string]bool{}
	for path, v := range doc.Recipes {
		listed[path] = true
		if v.Cell != v.Runo && v.Why == "" {
			t.Errorf("%s: the cell and Runo differ with no why", path)
		}
		text, err := os.ReadFile(filepath.Join(repoRoot, path))
		if err != nil {
			t.Errorf("%s: %v", path, err)
			continue
		}
		r, err := Parse(text)
		switch want := v.Cell; {
		case v.Cell == "accept" && err == nil && v.Size != nil && !reflect.DeepEqual(r.SizeRequirement(), v.Size):
			t.Errorf("%s: size %v, want %v", path, r.SizeRequirement(), v.Size)
		case v.Cell == "accept" && err == nil && v.EgressAllow != nil && !slices.Equal(r.EgressRequirements(), v.EgressAllow):
			t.Errorf("%s: egress %v, want %v", path, r.EgressRequirements(), v.EgressAllow)
		case v.Cell == "accept" && err == nil && v.Fakes != nil && !reflect.DeepEqual(r.FakeServices(), v.Fakes):
			t.Errorf("%s: fake normalization differs", path)
		case want == "accept" && err != nil:
			t.Errorf("%s: refused: %v", path, err)
		case want == "accept" && v.HealthTimeoutSeconds != nil && r.HealthTimeout() != time.Duration(*v.HealthTimeoutSeconds)*time.Second:
			t.Errorf("%s: health timeout %s, want %ds", path, r.HealthTimeout(), *v.HealthTimeoutSeconds)
		case want == "accept" && v.HealthTimeoutDefault && (r.Services.Compose.HealthTimeout != 0 || r.HealthTimeout() != DefaultHealthTimeout):
			t.Errorf("%s: health timeout %s set by the recipe, want the default %s", path, r.HealthTimeout(), DefaultHealthTimeout)
		case want == "accept" && !slices.Equal(r.Unapplied(), v.Unapplied):
			t.Errorf("%s: unapplied %v, want %v", path, r.Unapplied(), v.Unapplied)
		case strings.HasPrefix(want, "refuse: ") && err == nil:
			t.Errorf("%s: accepted, want %s", path, want)
		case strings.HasPrefix(want, "refuse: ") && !strings.Contains(err.Error(), strings.TrimPrefix(want, "refuse: ")):
			t.Errorf("%s: refused with %q, want %s", path, err, want)
		case want != "accept" && !strings.HasPrefix(want, "refuse: "):
			t.Errorf("%s: bad verdict %q", path, want)
		}
	}
	// Every fixture has a verdict, and so does every recipe Kodus ships.
	files, _ := filepath.Glob(filepath.Join(repoRoot, contractFixtures, "*.yaml"))
	ours, _ := filepath.Glob(filepath.Join(repoRoot, ".kodus", "workspace*.yaml"))
	var missing []string
	for _, f := range append(files, ours...) {
		rel, _ := filepath.Rel(repoRoot, f)
		if !listed[filepath.ToSlash(rel)] {
			missing = append(missing, rel)
		}
	}
	sort.Strings(missing)
	if len(missing) > 0 {
		t.Errorf("no verdict for %v", missing)
	}
}
