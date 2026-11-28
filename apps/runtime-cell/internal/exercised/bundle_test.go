package exercised

import (
	"fmt"
	"testing"
)

// A Nitro-like production build: .output/server/chunks/routes/api/hello.mjs
// (generated from server/api/hello.ts), the way `nuxt build` lays it out.
// Everything here is synthetic.

const bundleURL = "file:///app/.output/server/chunks/routes/api/hello.mjs"

var bundleLines = []string{"export default () => 1;", "export const never = () => 2;"}

func bundleScript() Script {
	size := len(bundleLines[0]) + 1 + len(bundleLines[1])
	return Script{URL: bundleURL, Functions: []Function{
		{Ranges: []Range{{Start: 0, End: size, Count: 1}}},
		{Ranges: []Range{{Start: len(bundleLines[0]) + 1, End: size, Count: 0}}},
	}}
}

// bundleMap is the map `nuxt build` writes next to the chunk: no sourcesContent,
// the source path relative to the map, line 1 to source line 1, line 2 to line 2.
func bundleMap() map[string]SourceMap {
	sm := SourceMap{URL: "hello.mjs.map", LineLengths: []int{len(bundleLines[0]), len(bundleLines[1])}}
	sm.Data = &struct {
		Sources        []string  `json:"sources"`
		SourcesContent []*string `json:"sourcesContent"`
		SourceRoot     string    `json:"sourceRoot"`
		Mappings       string    `json:"mappings"`
	}{Sources: []string{"../../../../../server/api/hello.ts"}, Mappings: "AAAA;AACA"}
	return map[string]SourceMap{bundleURL: sm}
}

func readBundleSources(repoPath string) ([]byte, error) {
	if repoPath == "server/api/hello.ts" {
		return []byte("export default () => 1;\nexport const never = () => 2;\n"), nil
	}
	if repoPath == "scripts/plain.js" {
		return []byte("x\ny\n"), nil
	}
	return nil, fmt.Errorf("no %s", repoPath)
}

func TestABundledBuildWithItsSourceMapCountsTheChangedSourceLines(t *testing.T) {
	cov := &Coverage{Result: []Script{bundleScript()}, SourceMapCache: bundleMap()}
	got := Measure([]File{{Path: "server/api/hello.ts", Lines: []int{1, 2}}}, []*Coverage{cov}, readBundleSources)
	want := Result{Path: "server/api/hello.ts", Changed: 2, Exercised: 1, Measured: true}
	if got[0] != want {
		t.Fatalf("got %+v, want %+v", got[0], want)
	}
}

func TestABundledBuildWithoutSourceMapsIsNeverZeroOfN(t *testing.T) {
	// The chunk carries no source-map-cache entry. Another changed file (a plain script, loaded as itself)
	// maps, which used to "prove" the mapping and turn the bundled file into a measured 0 of 2.
	plain := Script{URL: "file:///app/scripts/plain.js", Functions: []Function{{Ranges: []Range{{Start: 0, End: 4, Count: 1}}}}}
	cov := &Coverage{Result: []Script{bundleScript(), plain}}
	got := Measure([]File{{Path: "server/api/hello.ts", Lines: []int{1, 2}}, {Path: "scripts/plain.js", Lines: []int{1}}}, []*Coverage{cov}, readBundleSources)
	if got[0].Measured || got[0].Reason != ReasonUnmappedSource {
		t.Fatalf("bundled file: got %+v, want unknown/%s", got[0], ReasonUnmappedSource)
	}
	if !got[1].Measured || got[1].Exercised != 1 {
		t.Fatalf("plain file still counts: got %+v", got[1])
	}
}

func TestAnUnbundledAppKeepsItsMeasuredZero(t *testing.T) {
	// No build output among the scripts: a changed file nothing loaded is a real 0.
	plain := Script{URL: "file:///app/scripts/plain.js", Functions: []Function{{Ranges: []Range{{Start: 0, End: 4, Count: 1}}}}}
	got := Measure([]File{{Path: "scripts/plain.js", Lines: []int{1}}, {Path: "src/unloaded.js", Lines: []int{1, 2}}}, []*Coverage{{Result: []Script{plain}}}, readBundleSources)
	if !got[1].Measured || got[1].Exercised != 0 || got[1].Changed != 2 {
		t.Fatalf("got %+v", got[1])
	}
}
