// Package archrules holds the cell's package boundaries as a test: the rules
// of AGENTS.md ("Package boundaries") fail the build here instead of living
// only in prose. It reads imports and nothing else.
package archrules

import (
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

const module = "github.com/kodustech/kodus-ai/apps/runtime-cell/"

// imports maps every package of the module (path under the module root) to
// the module packages its non-test files import.
func imports(t *testing.T) map[string][]string {
	t.Helper()
	root := filepath.Join("..", "..")
	out := map[string]map[string]bool{}
	fset := token.NewFileSet()
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if n := d.Name(); n == "testdata" || n == "deploy" || n == "browser-runner" || n == "node_modules" {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		f, err := parser.ParseFile(fset, path, nil, parser.ImportsOnly)
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(root, filepath.Dir(path))
		if err != nil {
			return err
		}
		pkg := filepath.ToSlash(rel)
		if out[pkg] == nil {
			out[pkg] = map[string]bool{}
		}
		for _, imp := range f.Imports {
			p := strings.Trim(imp.Path.Value, `"`)
			if strings.HasPrefix(p, module) {
				out[pkg][strings.TrimPrefix(p, module)] = true
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	flat := map[string][]string{}
	for pkg, set := range out {
		for p := range set {
			flat[pkg] = append(flat[pkg], p)
		}
		sort.Strings(flat[pkg])
	}
	return flat
}

// under reports whether pkg is dir or a package below it.
func under(pkg, dir string) bool { return pkg == dir || strings.HasPrefix(pkg, dir+"/") }

func anyUnder(pkg string, dirs ...string) bool {
	for _, d := range dirs {
		if under(pkg, d) {
			return true
		}
	}
	return false
}

// rule forbids packages under from to import packages under any of to.
type rule struct {
	name string
	from []string
	to   []string
	// except are importing packages the rule leaves alone.
	except []string
}

var rules = []rule{
	{
		name: "an adapter never imports the application: a driver knows nothing of the agent",
		from: []string{"internal/drivers", "internal/driver"},
		to:   []string{"internal/agent"},
	},
	{
		name: "only the composition root picks a concrete driver",
		from: []string{"internal"},
		to:   []string{"internal/drivers/awsec2", "internal/drivers/dockergvisor", "internal/drivers/k8ssandbox", "internal/drivers/localdocker"},
	},
	{
		name: "the data plane never imports the control side",
		from: []string{"internal/egress", "internal/resolver", "internal/injector", "internal/observer"},
		to:   []string{"internal/agent", "internal/hubclient", "internal/lease", "internal/transport", "internal/driver", "internal/drivers"},
	},
	{
		name: "the leaves import no other package of the cell but a leaf",
		from: []string{"internal/protocol", "internal/redact", "internal/clock", "internal/metrics"},
		to:   []string{"internal", "cmd"}, // a leaf may use another leaf: see leaves
	},
	{
		name: "a pure rule package holds no claim state and reaches no backend",
		from: []string{"internal/buildfingerprint", "internal/bakecatalog", "internal/agent/checkout", "internal/agent/admission", "internal/agent/provenance", "internal/recipe", "internal/netguard"},
		to:   []string{"internal/agent/claims", "internal/agent/outbox", "internal/driver", "internal/drivers", "internal/hubclient", "internal/transport", "internal/lease"},
	},
	{
		name: "a part of the agent never reads a claim's state: the agent hands it what it needs",
		from: []string{"internal/agent/admission", "internal/agent/provenance", "internal/agent/pool", "internal/agent/checkout", "internal/agent/outbox", "internal/agent/evidence"},
		to:   []string{"internal/agent/claims"},
	},
	{
		name: "nothing below cmd imports a main package",
		from: []string{"internal"},
		to:   []string{"cmd"},
	},
}

var leaves = []string{"internal/protocol", "internal/redact", "internal/clock", "internal/metrics"}

func TestPackageBoundaries(t *testing.T) {
	graph := imports(t)
	if len(graph) < 20 {
		t.Fatalf("read %d packages; the walk did not find the module", len(graph))
	}
	for _, r := range rules {
		for pkg, imps := range graph {
			if !anyUnder(pkg, r.from...) || anyUnder(pkg, r.except...) {
				continue
			}
			for _, imp := range imps {
				if !anyUnder(imp, r.to...) || under(imp, pkg) || under(pkg, imp) {
					continue // a package and its own subpackages are one unit
				}
				if anyUnder(pkg, leaves...) && anyUnder(imp, leaves...) {
					continue
				}
				t.Errorf("%s\n\t%s imports %s", r.name, pkg, imp)
			}
		}
	}
}

// The application core is the only orchestrator: a package the agent uses
// must not reach back into it (Go refuses the cycle, but a subpackage could
// still be imported sideways by a port or an adapter).
func TestOnlyTheCompositionRootAndTestsUseTheAgent(t *testing.T) {
	for pkg, imps := range imports(t) {
		if under(pkg, "internal/agent") || under(pkg, "cmd") || under(pkg, "internal/testing") || under(pkg, "test") {
			continue
		}
		for _, imp := range imps {
			if under(imp, "internal/agent") {
				t.Errorf("%s imports %s: only cmd and the agent itself may", pkg, imp)
			}
		}
	}
}
