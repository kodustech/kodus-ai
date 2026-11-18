package archrules

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"strings"
	"testing"
)

// exits are the calls that end the process without running its defers.
var exits = map[string]bool{"os.Exit": true, "log.Fatal": true, "log.Fatalf": true, "log.Fatalln": true}

// exitAllowed are the directories the rule leaves alone, each with why.
var exitAllowed = map[string]string{
	"internal/protocol/gen": "the go:generate tool behind types_gen.go, never a process the cell runs",
}

// Only main exits (AGENTS.md "Package boundaries"): every other function,
// in cmd/* and below, returns its error. A must() that called os.Exit after
// defers were registered used to leave them unrun on a startup failure.
func TestOnlyMainExits(t *testing.T) {
	root := filepath.Join("..", "..")
	fset := token.NewFileSet()
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			rel, _ := filepath.Rel(root, path)
			if n := d.Name(); n == "testdata" || n == "deploy" || n == "browser-runner" || n == "node_modules" || exitAllowed[filepath.ToSlash(rel)] != "" {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		f, err := parser.ParseFile(fset, path, nil, 0)
		if err != nil {
			return err
		}
		for _, decl := range f.Decls {
			fn, ok := decl.(*ast.FuncDecl)
			if !ok || fn.Body == nil {
				continue
			}
			inMain := f.Name.Name == "main" && fn.Recv == nil && fn.Name.Name == "main"
			ast.Inspect(fn.Body, func(n ast.Node) bool {
				call, ok := n.(*ast.CallExpr)
				if !ok {
					return true
				}
				sel, ok := call.Fun.(*ast.SelectorExpr)
				if !ok {
					return true
				}
				pkg, ok := sel.X.(*ast.Ident)
				if !ok || !exits[pkg.Name+"."+sel.Sel.Name] {
					return true
				}
				if !inMain {
					rel, _ := filepath.Rel(root, fset.Position(call.Pos()).Filename)
					t.Errorf("%s:%d: %s.%s in %s: only main exits; return the error", filepath.ToSlash(rel), fset.Position(call.Pos()).Line, pkg.Name, sel.Sel.Name, fn.Name.Name)
				}
				return true
			})
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
