package exercised

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// writeCoverage writes raw as the coverage of process 1, which the preload
// started.
func writeCoverage(t testing.TB, dir string, raw []byte) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, "coverage-1.json"), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	started(t, dir, 1)
}

// started leaves the preload's start marker of each pid in dir.
func started(t testing.TB, dir string, pids ...int) {
	t.Helper()
	for _, pid := range pids {
		if err := os.WriteFile(filepath.Join(dir, StartMarkerPrefix+strconv.Itoa(pid)+"-0"), nil, 0o600); err != nil {
			t.Fatal(err)
		}
	}
}

func plainCoverage(t *testing.T) string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", "coverage-plain.json"))
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

// Coverage no V8 writes is the PR's forgery, and fails closed: every JS
// file is measured with none of its changed lines run (a green Run is held
// back), never counted as the PR says.
func TestCoverageNoV8WritesFailsClosed(t *testing.T) {
	files := []File{{Path: "src/plain.js", Lines: []int{2, 6}}, {Path: "README.md", Lines: []int{1}}}
	for name, raw := range map[string]string{
		"a block outside its function": strings.Replace(plainCoverage(t), `"startOffset": 37,
       "endOffset": 89,`, `"startOffset": 37,
       "endOffset": 89,
       "count": 0
      },
      {
       "startOffset": 0,
       "endOffset": 132,`, 1),
		"a reversed range":           strings.Replace(plainCoverage(t), `"endOffset": 35`, `"endOffset": -1`, 1),
		"functions of another shape": `{"result":[{"url":"file:///app/src/plain.js","functions":"all of them"}]}`,
		"a result of another shape":  `{"result":{"file:///app/src/plain.js":"ran"}}`,
	} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			writeCoverage(t, dir, []byte(raw))
			got, err := Answer(context.Background(), files, dir, fromTestdata)
			if !errors.Is(err, ErrUntrusted) {
				t.Fatalf("err %v, want ErrUntrusted", err)
			}
			if want := (Result{Path: "src/plain.js", Changed: 2, Measured: true}); got[0] != want {
				t.Fatalf("got %+v, want %+v", got[0], want)
			}
			if got[1].Measured || got[1].Reason != ReasonUnsupportedLanguage {
				t.Fatalf("a non-JS file: %+v", got[1])
			}
		})
	}
}

// A source map counts a changed file only when it is a map of the file the
// checkout holds: a map whose source text is another, or that maps a line
// past the file's end, is of another version and is never painted over it.
func TestASourceMapOfAnotherVersionOfTheFileIsNotCounted(t *testing.T) {
	ts, err := os.ReadFile(filepath.Join("testdata", "typed.ts"))
	if err != nil {
		t.Fatal(err)
	}
	files := []File{{Path: "src/typed.ts", Lines: []int{2}}}
	short := func(string) ([]byte, error) { return []byte("export const x = 1;\n"), nil }
	if got := Measure(files, []*Coverage{load(t, "coverage-typed.json")}, short); got[0].Measured || got[0].Reason != ReasonUnmappedSource {
		t.Fatalf("a map past the checkout's last line: %+v", got[0])
	}
	other := load(t, "coverage-typed.json")
	sm := other.SourceMapCache["file:///app/dist/typed.js"]
	text := string(ts) + "// another version\n"
	sm.Data.SourcesContent = []*string{&text}
	if got := Measure(files, []*Coverage{other}, fromTestdata); got[0].Measured || got[0].Reason != ReasonUnmappedSource {
		t.Fatalf("a map carrying another source text: %+v", got[0])
	}
	same := string(ts)
	sm.Data.SourcesContent = []*string{&same}
	if got := Measure(files, []*Coverage{other}, fromTestdata); !got[0].Measured || got[0].Exercised != 1 {
		t.Fatalf("a map carrying the checkout's text: %+v", got[0])
	}
}

// hostileCoverage is coverage a PR's process could write: scripts that all
// map to the changed file through a valid source map, each painting 15
// ranges of the most units a script may have.
func hostileCoverage(scripts int) []byte { return coverageOfScripts(scripts, 15, MaxScriptUnits) }

// coverageOfScripts is scripts that all map to the changed file through a
// valid source map, each painting ranges ranges of units units.
func coverageOfScripts(scripts, ranges, units int) []byte {
	var b, smc bytes.Buffer
	b.WriteString(`{"result":[`)
	for s := 0; s < scripts; s++ {
		if s > 0 {
			b.WriteByte(',')
			smc.WriteByte(',')
		}
		fmt.Fprintf(&b, `{"url":"file:///x%d/dist/plain.js","functions":[{"ranges":[`, s)
		for r := 0; r < ranges; r++ {
			if r > 0 {
				b.WriteByte(',')
			}
			fmt.Fprintf(&b, `{"startOffset":0,"endOffset":%d,"count":1}`, units)
		}
		b.WriteString(`]}]}`)
		fmt.Fprintf(&smc, `"file:///x%d/dist/plain.js":{"url":"plain.js.map","lineLengths":[%d],"data":{"sources":["../src/plain.js"],"mappings":"AAAA"}}`, s, units)
	}
	b.WriteString(`],"source-map-cache":{`)
	b.Write(smc.Bytes())
	b.WriteString(`}}`)
	return b.Bytes()
}

// One answer paints at most its budget (MaxPaint) units, every script of
// every file together: coverage that asks for more is coverage_too_large
// at once, never hours of the agent's core. The budget is lowered here so
// the answer is decided by the work it counts, not by how fast a loaded
// runner paints (N6).
func TestOneAnswerPaintsAtMostItsBudget(t *testing.T) {
	saved := paintBudget
	paintBudget = 3 * 1000
	t.Cleanup(func() { paintBudget = saved })
	answer := func(scripts int) (Result, error) {
		dir := t.TempDir()
		writeCoverage(t, dir, coverageOfScripts(scripts, 2, 500))
		got, err := Answer(context.Background(), []File{{Path: "src/plain.js", Lines: []int{1}}}, dir, fromTestdata)
		return got[0], err
	}
	if got, err := answer(3); err != nil || got.Reason == ReasonCoverageTooLarge {
		t.Fatalf("three scripts of 1000 units within a budget of 3000: %+v %v", got, err)
	}
	if got, err := answer(4); !errors.Is(err, ErrCoverageTooLarge) || got.Measured || got.Reason != ReasonCoverageTooLarge {
		t.Fatalf("four scripts of 1000 units past a budget of 3000: %+v %v, want coverage_too_large", got, err)
	}
	// At the real budget, a script that alone asks for more than all of it
	// is refused before a unit is painted.
	paintBudget = saved
	dir := t.TempDir()
	writeCoverage(t, dir, coverageOfScripts(200, MaxPaint/MaxScriptUnits+1, MaxScriptUnits))
	got, err := Answer(context.Background(), []File{{Path: "src/plain.js", Lines: []int{1}}}, dir, fromTestdata)
	if !errors.Is(err, ErrCoverageTooLarge) || got[0].Measured || got[0].Reason != ReasonCoverageTooLarge {
		t.Fatalf("got %+v %v, want coverage_too_large", got[0], err)
	}
}

// Scripts that map to no changed file are scanned, never painted: however
// many the coverage holds, they cost nothing of the budget.
func TestScriptsOfNoChangedFileAreNotPainted(t *testing.T) {
	dir := t.TempDir()
	writeCoverage(t, dir, bytes.ReplaceAll(hostileCoverage(200), []byte("../src/plain.js"), []byte("../node_modules/pkg/index.js")))
	got, err := Answer(context.Background(), []File{{Path: "src/plain.js", Lines: []int{1}}}, dir, fromTestdata)
	if err != nil || got[0].Reason != ReasonNotLoadedUnproven {
		t.Fatalf("got %+v %v, want not_loaded_unproven", got[0], err)
	}
}

// An answer stops when its context ends: coverage_too_large, not a count.
func TestAnAnswerStopsWithItsContext(t *testing.T) {
	dir := t.TempDir()
	writeCoverage(t, dir, []byte(plainCoverage(t)))
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	got, err := Answer(ctx, []File{{Path: "src/plain.js", Lines: []int{2}}}, dir, fromTestdata)
	if !errors.Is(err, context.Canceled) || got[0].Measured || got[0].Reason != ReasonCoverageTooLarge {
		t.Fatalf("got %+v %v", got[0], err)
	}
}
