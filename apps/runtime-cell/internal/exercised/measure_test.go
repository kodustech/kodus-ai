package exercised

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func load(t *testing.T, name string) *Coverage {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	c, err := ParseCoverage(raw)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func fromTestdata(repoPath string) ([]byte, error) {
	return os.ReadFile(filepath.Join("testdata", filepath.Base(repoPath)))
}

func TestPlainJSCountsTheLinesOfTheFunctionThatRan(t *testing.T) {
	// plain.js: ran() body is line 2, never() body lines 6 and 7.
	got := Measure([]File{{Path: "src/plain.js", Lines: []int{2, 6, 7, 6}}}, []*Coverage{load(t, "coverage-plain.json")}, fromTestdata)
	want := Result{Path: "src/plain.js", Changed: 3, Exercised: 1, Measured: true}
	if got[0] != want {
		t.Fatalf("got %+v, want %+v", got[0], want)
	}
}

func TestTranspiledTSCountsThroughTheSourceMapCache(t *testing.T) {
	// typed.ts: ran() body is line 2, never() body lines 6 and 7; the
	// generated JS of never() did not run, so neither did they.
	got := Measure([]File{{Path: "src/typed.ts", Lines: []int{2, 6, 7}}}, []*Coverage{load(t, "coverage-typed.json")}, func(string) ([]byte, error) {
		return nil, errors.New("a source mapped file is never read")
	})
	want := Result{Path: "src/typed.ts", Changed: 3, Exercised: 1, Measured: true}
	if got[0] != want {
		t.Fatalf("got %+v, want %+v", got[0], want)
	}
}

func TestEveryFileIsUnknownWhenNoCoverageWasWritten(t *testing.T) {
	got := Measure([]File{{Path: "src/a.js", Lines: []int{1}}, {Path: "README.md", Lines: []int{1}}}, nil, fromTestdata)
	if got[0].Measured || got[0].Reason != ReasonNoCoverageWritten || got[1].Reason != ReasonUnsupportedLanguage {
		t.Fatalf("got %+v", got)
	}
}

func TestAFileNothingMapsToIsZeroOnlyWhenAnotherFileMapped(t *testing.T) {
	cov := []*Coverage{load(t, "coverage-plain.json")}
	got := Measure([]File{{Path: "src/plain.js", Lines: []int{2}}, {Path: "src/unloaded.js", Lines: []int{1, 2}}}, cov, fromTestdata)
	if want := (Result{Path: "src/unloaded.js", Changed: 2, Measured: true}); got[1] != want {
		t.Fatalf("mapping proven: got %+v, want %+v", got[1], want)
	}
	got = Measure([]File{{Path: "src/unloaded.js", Lines: []int{1}}}, cov, fromTestdata)
	if got[0].Measured || got[0].Reason != ReasonNotLoadedUnproven {
		t.Fatalf("nothing mapped: got %+v", got[0])
	}
}

func TestAScriptLongerThanTheCheckoutsFileIsUnmapped(t *testing.T) {
	got := Measure([]File{{Path: "src/plain.js", Lines: []int{2}}}, []*Coverage{load(t, "coverage-plain.json")}, func(string) ([]byte, error) {
		return []byte("x"), nil
	})
	if got[0].Measured || got[0].Reason != ReasonUnmappedSource {
		t.Fatalf("got %+v", got[0])
	}
}

func TestCoverageOfTwoFlushesIsUnioned(t *testing.T) {
	ran, never := load(t, "coverage-plain.json"), load(t, "coverage-plain.json")
	never.Result[0].Functions[1].Ranges[0].Count = 0 // the second flush reset ran()'s counter
	got := Measure([]File{{Path: "src/plain.js", Lines: []int{2}}}, []*Coverage{never, ran}, fromTestdata)
	if !got[0].Measured || got[0].Exercised != 1 {
		t.Fatalf("got %+v", got[0])
	}
}

func TestMatchTakesTheLongestRepositoryPath(t *testing.T) {
	if i := match([]string{"x.js", "src/x.js"}, "file:///app/src/x.js"); i != 1 {
		t.Fatalf("got %d", i)
	}
	if i := match([]string{"x.js"}, "node:internal/x.js"); i != -1 {
		t.Fatalf("a node: script matched %d", i)
	}
	if i := match([]string{"x.js"}, "file:///app/notx.js"); i != -1 {
		t.Fatalf("a partial segment matched %d", i)
	}
}
