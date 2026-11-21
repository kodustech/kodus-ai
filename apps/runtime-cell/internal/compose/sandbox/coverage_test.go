package sandbox

import (
	"errors"
	"strings"
	"testing"

	"go.yaml.in/yaml/v3"
)

func coverageOpts(dir string) Options {
	o := opts(dir)
	o.Coverage = Coverage{
		Dir:      "/var/lib/kodus-cell/claims/claim-1/coverage",
		Preload:  "/var/lib/kodus-cell/claims/claim-1/coverage-preload.cjs",
		Services: []string{"api"},
	}
	return o
}

// A Run's instrumented services (feature exercisedLines) get the claim's
// coverage directory, the one writable bind, and the preload read-only;
// the others get neither.
func TestApplyMountsCoverageOnTheInstrumentedServicesOnly(t *testing.T) {
	o := coverageOpts(checkout(t))
	out, err := Apply([]byte("services:\n  api:\n    image: node:22\n  db:\n    image: postgres:16\n"), o)
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Services map[string]struct {
			Volumes []map[string]any `yaml:"volumes"`
		} `yaml:"services"`
	}
	if err := yaml.Unmarshal(out, &doc); err != nil {
		t.Fatal(err)
	}
	has := func(svc, source, target string, readOnly bool) bool {
		for _, v := range doc.Services[svc].Volumes {
			if v["type"] == "bind" && v["source"] == source && v["target"] == target && v["read_only"] == readOnly {
				return true
			}
		}
		return false
	}
	if !has("api", o.Coverage.Dir, CoverageTarget, false) || !has("api", o.Coverage.Preload, CoveragePreloadTarget, true) {
		t.Fatalf("api lacks the coverage mounts: %v", doc.Services["api"].Volumes)
	}
	for _, v := range doc.Services["db"].Volumes {
		if v["source"] == o.Coverage.Dir || v["source"] == o.Coverage.Preload {
			t.Fatalf("db got a coverage mount: %v", v)
		}
	}
}

// The coverage targets are the cell's whether coverage is on or not: no
// checkout mounts there, nor under the directory.
func TestApplyRefusesAMountOverTheCoverageTargets(t *testing.T) {
	dir := checkout(t)
	for _, o := range []Options{opts(dir), coverageOpts(dir)} {
		for _, target := range []string{CoverageTarget, CoverageTarget + "/x.json", CoveragePreloadTarget} {
			var re *RefusedError
			if _, err := Apply([]byte("services:\n  api:\n    image: node:22\n    volumes: [\"./src:"+target+"\"]\n"), o); !errors.As(err, &re) {
				t.Fatalf("a mount at %s (coverage %v): %v", target, o.Coverage.Set(), err)
			}
		}
	}
}

// What compose will run must bind the coverage directory writable at its
// target on an instrumented service, and nowhere else.
func TestVerifyCanonicalWantsTheCoverageMountsAndOnlyThem(t *testing.T) {
	o := coverageOpts(checkout(t))
	dirBind := `{"type":"bind","source":"` + o.Coverage.Dir + `","target":"` + CoverageTarget + `"}`
	preload := `{"type":"bind","source":"` + o.Coverage.Preload + `","target":"` + CoveragePreloadTarget + `","read_only":true}`
	if err := VerifyCanonical([]byte(canonical(dirBind+","+preload)), o); err != nil {
		t.Fatal(err)
	}
	var re *RefusedError
	bad := map[string]string{
		"no coverage mounts":       canonical(`{"type":"volume","source":"data","target":"/d"}`),
		"no preload":               canonical(dirBind),
		"preload writable":         canonical(dirBind + "," + strings.Replace(preload, `,"read_only":true`, "", 1)),
		"coverage dir elsewhere":   canonical(strings.Replace(dirBind, CoverageTarget, "/app", 1) + "," + preload),
		"another dir at target":    canonical(strings.Replace(dirBind, o.Coverage.Dir, "/etc", 1) + "," + preload),
		"another writable bind":    canonical(dirBind + "," + preload + `,{"type":"bind","source":"/var/lib/kodus-cell","target":"/x"}`),
		"a volume under the dir":   canonical(dirBind + "," + preload + `,{"type":"volume","source":"data","target":"` + CoverageTarget + `/sub"}`),
		"a tmpfs over the preload": canonical(dirBind + "," + preload + `,{"type":"tmpfs","target":"` + CoveragePreloadTarget + `"}`),
	}
	for name, raw := range bad {
		if err := VerifyCanonical([]byte(raw), o); !errors.As(err, &re) {
			t.Errorf("%s accepted: %v", name, err)
		}
	}
	// A service not instrumented never takes the coverage directory.
	other := o
	other.Coverage.Services = []string{"web"}
	if err := VerifyCanonical([]byte(canonical(dirBind+","+preload)), other); !errors.As(err, &re) {
		t.Fatalf("the coverage dir on a service not instrumented: %v", err)
	}
}
