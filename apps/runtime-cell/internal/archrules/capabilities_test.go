package archrules

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// assertionAllowed are the type assertions to an interface of the module that
// stay, each with why. A driver's capability is never one of them: it is a
// field of driver.Parts. Every entry is "file: type" as the test prints it.
var assertionAllowed = map[string]string{
	"internal/isolation/gvisor/gvisor.go: NetShaper":                   "gVisor engine extension, inside the backend",
	"internal/isolation/gvisor/gvisor.go: SandboxEngine":               "gVisor engine extension, inside the backend",
	"internal/isolation/firecracker/orphans.go: TapInventory":          "firecracker network inventory, inside the backend",
	"internal/isolation/firecracker/orphans.go: NetnsInventory":        "firecracker network inventory, inside the backend",
	"internal/drivers/microvm/diagnose.go: isolation.MachineLogReader": "a VMM log the firecracker backend may keep, inside the driver's own backend port (review #7)",
	"internal/telemetry/redaction.go: fmtStringer":                     "fmt.Stringer, declared locally",
	"internal/egress/conns.go: interface{...}":                         "net.Conn half-close (CloseWrite), a standard library capability",
	"internal/egress/proxy.go: interface{...}":                         "net.Conn half-close (CloseWrite), a standard library capability",
}

// A capability is found in one place, driver.Parts (AGENTS.md "Optional
// capabilities"): no production file looks for one by asserting a value to
// an interface of the module, or to an anonymous interface. Such an assertion
// on a wrapped driver (driver.Observed) used to turn memory admission off
// without a word on the dev cell.
func TestNoCapabilityIsDiscoveredByTypeAssertion(t *testing.T) {
	root := filepath.Join("..", "..")
	fset := token.NewFileSet()
	files := map[string]*ast.File{} // path under the module root
	ifaces := map[string]map[string]bool{}
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
		f, err := parser.ParseFile(fset, path, nil, parser.SkipObjectResolution)
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		files[rel] = f
		pkg := filepath.ToSlash(filepath.Dir(rel))
		for _, decl := range f.Decls {
			g, ok := decl.(*ast.GenDecl)
			if !ok || g.Tok != token.TYPE {
				continue
			}
			for _, spec := range g.Specs {
				if ts := spec.(*ast.TypeSpec); isInterface(ts.Type) {
					if ifaces[pkg] == nil {
						ifaces[pkg] = map[string]bool{}
					}
					ifaces[pkg][ts.Name.Name] = true
				}
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}

	found := map[string]bool{}
	for rel, f := range files {
		pkg := filepath.ToSlash(filepath.Dir(rel))
		imported := map[string]string{} // name in the file -> package under the module root
		for _, imp := range f.Imports {
			p := strings.Trim(imp.Path.Value, `"`)
			if !strings.HasPrefix(p, module) {
				continue
			}
			p = strings.TrimPrefix(p, module)
			name := p[strings.LastIndex(p, "/")+1:]
			if imp.Name != nil {
				name = imp.Name.Name
			}
			imported[name] = p
		}
		check := func(typ ast.Expr) {
			switch e := typ.(type) {
			case *ast.InterfaceType:
				found[rel+": interface{...}"] = true
			case *ast.Ident:
				if ifaces[pkg][e.Name] {
					found[rel+": "+e.Name] = true
				}
			case *ast.SelectorExpr:
				if x, ok := e.X.(*ast.Ident); ok && ifaces[imported[x.Name]][e.Sel.Name] {
					found[rel+": "+x.Name+"."+e.Sel.Name] = true
				}
			}
		}
		ast.Inspect(f, func(n ast.Node) bool {
			switch n := n.(type) {
			case *ast.TypeAssertExpr:
				if n.Type != nil {
					check(n.Type)
				}
			case *ast.TypeSwitchStmt:
				for _, c := range n.Body.List {
					for _, typ := range c.(*ast.CaseClause).List {
						check(typ)
					}
				}
			}
			return true
		})
	}

	var bad, stale []string
	for k := range found {
		if _, ok := assertionAllowed[k]; !ok {
			bad = append(bad, k)
		}
	}
	for k := range assertionAllowed {
		if !found[k] {
			stale = append(stale, k)
		}
	}
	sort.Strings(bad)
	sort.Strings(stale)
	for _, k := range bad {
		t.Errorf("%s: a type assertion to an interface of the module; give the capability as a field of driver.Parts (or of the port it belongs to) instead", k)
	}
	for _, k := range stale {
		t.Errorf("%s is allowed but no longer asserted: remove it from assertionAllowed", k)
	}
}

func isInterface(e ast.Expr) bool {
	_, ok := e.(*ast.InterfaceType)
	return ok
}
