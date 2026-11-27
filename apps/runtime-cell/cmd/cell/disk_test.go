package main

import (
	"context"
	"errors"
	"testing"
	"time"
)

// The watchdog reads the data root's free space; 0 turns it off.
func TestDiskWatchReadsTheDataRoot(t *testing.T) {
	if diskWatch("/var/lib/docker", 0) != nil {
		t.Fatal("a zero floor made a watchdog")
	}
	w := diskWatch(t.TempDir(), 5)
	if w == nil || w.MinFreeBytes != 5<<30 {
		t.Fatalf("watch %+v", w)
	}
	if free, err := w.Free(); err != nil || free == 0 {
		t.Fatalf("free %d, %v", free, err)
	}
	if _, err := diskWatch("/no/such/dir", 5).Free(); err == nil {
		t.Fatal("a missing data root read as free")
	}
}

// fstrim -v says how much it gave back in one line; the cell sums it over each
// distinct filesystem of the paths it trims, runs the rest when one fails, and
// reports that failure.
func TestTheTrimmerSumsWhatFstrimReports(t *testing.T) {
	const out17 = "/var/lib/kodus-cell: 17 GiB (18253611008 bytes) trimmed\n"
	cases := []struct {
		name    string
		paths   func(t *testing.T) []string
		run     func(path string) (string, error)
		want    uint64
		wantErr bool
	}{
		{"one filesystem is trimmed once", func(t *testing.T) []string { d := t.TempDir(); return []string{d, d} },
			func(string) (string, error) { return out17, nil }, 18253611008, false},
		{"output without a byte count is zero", func(t *testing.T) []string { return []string{t.TempDir()} },
			func(string) (string, error) { return "fstrim: not supported", nil }, 0, false},
		{"a failure is reported", func(t *testing.T) []string { return []string{t.TempDir()} },
			func(string) (string, error) { return "", errors.New("discard not supported") }, 0, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			paths := tc.paths(t)
			trim := trimmer(diskOptions{trimPaths: paths, fstrim: func(_ context.Context, p string) (string, error) { return tc.run(p) }})
			got, err := trim(context.Background())
			if got != tc.want || (err != nil) != tc.wantErr {
				t.Fatalf("trimmed %d err=%v, want %d wantErr=%v", got, err, tc.want, tc.wantErr)
			}
		})
	}
}

// -disk-outer-path adds a second disk the watchdog reads, and -disk-per-run-free-gb
// and -disk-ready-grace reach the watchdog.
func TestDiskWatchCarriesTheLadderSettings(t *testing.T) {
	w := diskWatch(t.TempDir(), 5, diskOptions{perRunGB: 8, outerPath: t.TempDir(), grace: time.Minute, trimPaths: []string{t.TempDir()}})
	if w.PerRunBytes != 8<<30 || w.ReadyGrace != time.Minute || w.Outer == nil || w.Trim == nil {
		t.Fatalf("watchdog %+v", w)
	}
	if bare := diskWatch(t.TempDir(), 5); bare.Outer != nil || bare.Trim != nil {
		t.Fatal("a watchdog with no options has an outer disk or a trim")
	}
}
