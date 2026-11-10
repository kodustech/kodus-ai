package sandbox

import (
	"errors"
	"strings"
	"testing"

	"go.yaml.in/yaml/v3"
)

// A Run's decoy file (ADR-043) is bound read-only into every service at
// DecoyTarget, and nothing of the checkout may mount there instead.
func TestApplyMountsTheDecoyOnEveryService(t *testing.T) {
	dir := checkout(t)
	o := opts(dir)
	o.Decoy = "/var/lib/kodus-cell/compose/decoy/kodus-claim-1-workload.npmrc"
	out, err := Apply([]byte("services:\n  api:\n    image: a\n  db:\n    image: b\n"), o)
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
	for name, svc := range doc.Services {
		found := false
		for _, v := range svc.Volumes {
			if v["source"] == o.Decoy && v["target"] == DecoyTarget && v["read_only"] == true && v["type"] == "bind" {
				found = true
			}
		}
		if !found {
			t.Fatalf("%s has no decoy mount: %v", name, svc.Volumes)
		}
	}
	var re *RefusedError
	if _, err := Apply([]byte("services:\n  api:\n    image: a\n    volumes: [\"./src:"+DecoyTarget+":ro\"]\n"), o); !errors.As(err, &re) {
		t.Fatalf("a mount over the decoy: %v", err)
	}
}

// What compose would run must still bind the decoy, and only the cell's.
func TestVerifyCanonicalWantsTheDecoy(t *testing.T) {
	dir := checkout(t)
	o := opts(dir)
	o.Decoy = "/var/lib/kodus-cell/compose/decoy/kodus-claim-1-workload.npmrc"
	decoy := `{"type":"bind","source":"` + o.Decoy + `","target":"` + DecoyTarget + `","read_only":true}`
	if err := VerifyCanonical([]byte(canonical(decoy)), o); err != nil {
		t.Fatal(err)
	}
	var re *RefusedError
	if err := VerifyCanonical([]byte(canonical(`{"type":"volume","source":"data","target":"/d"}`)), o); !errors.As(err, &re) {
		t.Fatalf("no decoy accepted: %v", err)
	}
	moved := strings.Replace(decoy, DecoyTarget, "/etc/passwd", 1)
	if err := VerifyCanonical([]byte(canonical(moved)), o); !errors.As(err, &re) {
		t.Fatalf("the decoy file bound elsewhere accepted: %v", err)
	}
}
