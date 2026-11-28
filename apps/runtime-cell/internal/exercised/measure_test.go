package exercised

import (
	"encoding/json"
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
	var c Coverage
	if err := json.Unmarshal(raw, &c); err != nil {
		t.Fatal(err)
	}
	return &c
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
	got := Measure([]File{{Path: "src/typed.ts", Lines: []int{2, 6, 7}}}, []*Coverage{load(t, "coverage-typed.json")}, fromTestdata)
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

// Another repository's service runs a file at the same path (kr-shop and
// its billing service both run /app/server.js): its coverage, shorter than
// the checkout's file, is never painted over it.
func TestAScriptOfAnotherLengthAtTheSamePathIsNotCounted(t *testing.T) {
	own, err := os.ReadFile(filepath.Join("testdata", "plain.js"))
	if err != nil {
		t.Fatal(err)
	}
	own = append(own, []byte("// a longer file of this repository\n")...)
	mine := load(t, "coverage-plain.json")
	mine.Result[0].Functions[0].Ranges[0].End = len(own)
	mine.Result[0].Functions[1].Ranges[0].Count = 0 // this repository's ran() never ran
	other := load(t, "coverage-plain.json")         // the other service's file: 132 units, its ran() ran
	got := Measure([]File{{Path: "src/plain.js", Lines: []int{2}}}, []*Coverage{other, mine}, func(string) ([]byte, error) { return own, nil })
	if want := (Result{Path: "src/plain.js", Changed: 1, Exercised: 0, Measured: true}); got[0] != want {
		t.Fatalf("got %+v, want %+v", got[0], want)
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

// S1-04: the line lengths Node records for a generated script are the
// script V8 ran: lines whose lengths do not add up to the script's own
// length (its top-level range) are coverage no V8 writes.
func TestLineLengthsThatDoNotFitTheScriptAreUntrusted(t *testing.T) {
	files := []File{{Path: "src/typed.ts", Lines: []int{2}}}
	for name, lengths := range map[string]func([]int) []int{
		"a line too many": func(l []int) []int { return append(l, 40) },
		"lines too short": func(l []int) []int { return l[:len(l)-3] },
		"a line too long": func(l []int) []int { l[0] += 500; return l },
	} {
		t.Run(name, func(t *testing.T) {
			cov := load(t, "coverage-typed.json")
			sm := cov.SourceMapCache["file:///app/dist/typed.js"]
			sm.LineLengths = lengths(append([]int(nil), sm.LineLengths...))
			cov.SourceMapCache["file:///app/dist/typed.js"] = sm
			if got := Measure(files, []*Coverage{cov}, fromTestdata); got[0] != (Result{Path: "src/typed.ts", Changed: 1, Measured: true}) {
				t.Fatalf("got %+v, want measured with none run (Untrusted)", got[0])
			}
		})
	}
	// CRLF lines are one unit longer each: still the script V8 ran.
	cov := load(t, "coverage-typed.json")
	sm := cov.SourceMapCache["file:///app/dist/typed.js"]
	short := append([]int(nil), sm.LineLengths...)
	short[0]--
	sm.LineLengths = short
	cov.SourceMapCache["file:///app/dist/typed.js"] = sm
	if got := Measure(files, []*Coverage{cov}, fromTestdata); got[0].Exercised != 1 {
		t.Fatalf("a script with one CRLF line: %+v", got[0])
	}
}
