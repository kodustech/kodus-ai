package sandbox

import (
	"encoding/json"
	"errors"
	"maps"
	"testing"

	"go.yaml.in/yaml/v3"
)

// R3-02: with no aggregate parent every service got the claim's whole
// memory, so a project of N services could use N times what the cell
// counted for the claim. With MemShared they share it, among the services
// compose starts: one behind a profile never starts on the cell, so it
// takes no share of the others' (N3).
func TestServicesShareTheClaimsMemoryWithNoAggregateParent(t *testing.T) {
	dir := checkout(t)
	o := opts(dir) // 4g
	o.MemShared = true
	compose := "services:\n  a:\n    image: img-a\n  b:\n    image: img-b\n    profiles: []\n  c:\n    image: img-c\n    profiles: [extra]\n  d:\n    image: img-d\n  e:\n    image: img-e\n    profiles: [tools, debug]\n"
	out, err := Apply([]byte(compose), o)
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err := yaml.Unmarshal(out, &doc); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"a", "b", "d"} {
		if got := doc["services"].(map[string]any)[name].(map[string]any)["mem_limit"]; got != "1228m" {
			t.Errorf("%s: mem_limit %v, want a third of 4g less the sandbox's headroom (the profiled services never start)", name, got)
		}
	}
	o.MemLimit = "150m"
	var re *RefusedError
	if _, err := Apply([]byte(compose), o); !errors.As(err, &re) {
		t.Fatalf("three services sharing 150m: %v", err)
	}
}

func TestVerifyCanonicalHoldsTheSharedMemory(t *testing.T) {
	dir := checkout(t)
	o := opts(dir)
	o.MemShared = true
	// The canonical project with its one service twice, each at mem.
	twice := func(mem string) []byte {
		var doc map[string]any
		if err := json.Unmarshal([]byte(canonical(``)), &doc); err != nil {
			t.Fatal(err)
		}
		services := doc["services"].(map[string]any)
		api := services["api"].(map[string]any)
		api["mem_limit"] = mem
		web := maps.Clone(api)
		services["web"] = web
		// No fixed addresses here (opts has no subnet): two copies are fine.
		raw, _ := json.Marshal(doc)
		return raw
	}
	if err := VerifyCanonical(twice("2147483648"), o); err != nil {
		t.Fatalf("two services with half each: %v", err)
	}
	var re *RefusedError
	if err := VerifyCanonical(twice("4294967296"), o); !errors.As(err, &re) {
		t.Fatalf("two services with the whole each accepted: %v", err)
	}
}
