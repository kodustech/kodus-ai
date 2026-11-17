package hubprotocol

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// What the agent writes after a hello ack is what cell update reads back,
// in a file only its owner reads, and a write leaves no temporary behind.
func TestTheStateTheAgentSavesIsTheOneCellUpdateLoads(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "state", StateName)
	want := State{Version: 1, Accepts: &Range{Min: 1, Max: 2}, At: time.Date(2026, 11, 16, 12, 0, 0, 0, time.UTC)}
	if err := Save(path, want); err != nil {
		t.Fatal(err)
	}
	got, ok, err := Load(path)
	if err != nil || !ok || got.Version != 1 || *got.Accepts != *want.Accepts || !got.At.Equal(want.At) {
		t.Fatalf("Load = %+v %v %v", got, ok, err)
	}
	fi, err := os.Stat(path)
	if err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v %v, want 0600", fi.Mode(), err)
	}
	entries, _ := os.ReadDir(filepath.Dir(path))
	if len(entries) != 1 {
		t.Fatalf("left %d files in the state dir, want only %s", len(entries), StateName)
	}
	// A second save replaces the first.
	if err := Save(path, State{Version: 1, At: want.At}); err != nil {
		t.Fatal(err)
	}
	if got, _, _ := Load(path); got.Accepts != nil {
		t.Fatalf("the second save kept the first range: %+v", got)
	}
}

// A host whose cell never reached a hub has no state: that is not an error.
func TestNoStateIsNotAnError(t *testing.T) {
	_, ok, err := Load(filepath.Join(t.TempDir(), StateName))
	if ok || err != nil {
		t.Fatalf("ok %v err %v", ok, err)
	}
}

// A state that does not read as one is refused, never taken for none: cell
// update would install a release the hub refuses.
func TestAStateThatDoesNotReadIsRefused(t *testing.T) {
	for name, text := range map[string]string{
		"not json":     "v1",
		"no version":   `{"at":"2026-11-16T12:00:00Z"}`,
		"inverted":     `{"version":1,"accepts":{"min":2,"max":1},"at":"2026-11-16T12:00:00Z"}`,
		"zero minimum": `{"version":1,"accepts":{"min":0,"max":1},"at":"2026-11-16T12:00:00Z"}`,
		"extra field":  `{"version":1,"secret":"x","at":"2026-11-16T12:00:00Z"}`,
	} {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), StateName)
			if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
				t.Fatal(err)
			}
			if _, _, err := Load(path); err == nil || !strings.Contains(err.Error(), path) {
				t.Fatalf("err %v, want a refusal naming %s", err, path)
			}
		})
	}
	if err := Save(filepath.Join(t.TempDir(), StateName), State{Version: 1, Accepts: &Range{Min: 3, Max: 2}}); err == nil {
		t.Fatal("saved an inverted range")
	}
}

// The range a hub accepts is the one it named; a hub that names none (every
// hub before the field speaks protocol 1) is taken to speak the version it
// chose, and to accept one protocol older at most, as the skew policy says.
func TestTheAcceptedRangeIsTheNamedOneOrTheChosenVersion(t *testing.T) {
	if r, named := (State{Version: 1, Accepts: &Range{Min: 1, Max: 2}}).Accepted(); !named || r != (Range{1, 2}) {
		t.Fatalf("named: %+v %v", r, named)
	}
	if r, named := (State{Version: 1}).Accepted(); named || r != (Range{1, 1}) {
		t.Fatalf("v1 unnamed: %+v %v", r, named)
	}
	if r, named := (State{Version: 3}).Accepted(); named || r != (Range{2, 3}) {
		t.Fatalf("v3 unnamed: %+v %v", r, named)
	}
}
