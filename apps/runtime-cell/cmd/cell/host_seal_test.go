package main

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// A host with the seal unit is a fleet host: sealing starts that unit without
// waiting for it. A host without it has no sealer, so cell.seal is refused.
func TestHostSealerStartsTheSealUnitDetachedOnAFleetHost(t *testing.T) {
	unit := filepath.Join(t.TempDir(), hostSealUnit)
	if hostSealer(unit, nil) != nil {
		t.Fatal("a host without the seal unit got a sealer")
	}
	if err := os.WriteFile(unit, []byte("[Service]\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	var got []string
	s := hostSealer(unit, func(_ context.Context, name string, args ...string) error {
		got = append([]string{name}, args...)
		return nil
	})
	if s == nil {
		t.Fatal("a host with the seal unit got no sealer")
	}
	if err := s.Seal(context.Background()); err != nil {
		t.Fatal(err)
	}
	if want := []string{"systemctl", "start", "--no-block", "kodus-cell-seal.service"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("ran %v, want %v", got, want)
	}
}
