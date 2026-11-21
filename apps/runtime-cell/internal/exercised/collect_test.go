package exercised

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestAnswerReadsCoverageFilesAndSkipsTheRest(t *testing.T) {
	dir := t.TempDir()
	raw, _ := os.ReadFile(filepath.Join("testdata", "coverage-plain.json"))
	never := strings.ReplaceAll(string(raw), `"count": 1`, `"count": 0`)
	for name, body := range map[string]string{"coverage-1.json": string(raw), "coverage-2.json": "{not json", "notes.txt": never} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(filepath.Join(dir, "coverage-1.json"), filepath.Join(dir, "coverage-3.json")); err != nil {
		t.Fatal(err)
	}
	started(t, dir, 1, 2, 3)
	got, err := Answer(context.Background(), []File{{Path: "src/plain.js", Lines: []int{2, 6}}}, dir, fromTestdata)
	if want := (Result{Path: "src/plain.js", Changed: 2, Exercised: 1, Measured: true}); err != nil || got[0] != want {
		t.Fatalf("got %+v %v, want %+v from the one regular coverage file that parses", got[0], err, want)
	}
}

func TestAMissingDirIsNoCoverage(t *testing.T) {
	got, _ := Answer(context.Background(), []File{{Path: "src/a.js", Lines: []int{1}}}, filepath.Join(t.TempDir(), "absent"), fromTestdata)
	if got[0].Measured || got[0].Reason != ReasonNoCoverageWritten {
		t.Fatalf("got %+v", got[0])
	}
}

func TestCoveragePastTheBoundIsUnknown(t *testing.T) {
	dir := t.TempDir()
	big := `{"result":[],"pad":"` + strings.Repeat("x", MaxCoverageBytes) + `"}`
	if err := os.WriteFile(filepath.Join(dir, "coverage-1.json"), []byte(big), 0o600); err != nil {
		t.Fatal(err)
	}
	started(t, dir, 1)
	got, _ := Answer(context.Background(), []File{{Path: "src/a.js", Lines: []int{1}}}, dir, fromTestdata)
	if got[0].Measured || got[0].Reason != ReasonCoverageTooLarge {
		t.Fatalf("got %+v", got[0])
	}
}

// S1-04: a coverage file counts only when a process the cell's preload
// started wrote it: its pid has the start marker the preload leaves. A file
// no started process wrote (an echo, a process that dropped the preload)
// is skipped, so it can only lower the count, never raise it.
func TestACoverageFileCountsOnlyFromAProcessThePreloadStarted(t *testing.T) {
	dir := t.TempDir()
	raw, _ := os.ReadFile(filepath.Join("testdata", "coverage-plain.json"))
	if err := os.WriteFile(filepath.Join(dir, "coverage-7-1700000000000-0.json"), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	files := []File{{Path: "src/plain.js", Lines: []int{2, 6}}}
	got, err := Answer(context.Background(), files, dir, fromTestdata)
	if err != nil || got[0].Measured || got[0].Reason != ReasonNoCoverageWritten {
		t.Fatalf("a file of no started process counted: %+v %v", got[0], err)
	}
	// Another process's start does not vouch for it either.
	if err := os.WriteFile(filepath.Join(dir, StartMarkerPrefix+"70-1700000000000"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if got, _ := Answer(context.Background(), files, dir, fromTestdata); got[0].Measured {
		t.Fatalf("pid 70's start vouched for pid 7: %+v", got[0])
	}
	if err := os.WriteFile(filepath.Join(dir, StartMarkerPrefix+"7-1699999999000"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if got, err := Answer(context.Background(), files, dir, fromTestdata); err != nil || !got[0].Measured || got[0].Exercised != 1 {
		t.Fatalf("the started process's file: %+v %v", got[0], err)
	}
}

// More process starts than Answer reads is unknown, as more coverage is.
func TestStartsPastTheBoundAreUnknown(t *testing.T) {
	dir := t.TempDir()
	writeCoverage(t, dir, []byte(`{"result":[]}`))
	for i := range MaxStartMarkers + 1 {
		if err := os.WriteFile(filepath.Join(dir, StartMarkerPrefix+strconv.Itoa(1000+i)+"-0"), nil, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	got, err := Answer(context.Background(), []File{{Path: "src/a.js", Lines: []int{1}}}, dir, fromTestdata)
	if !errors.Is(err, ErrCoverageTooLarge) || got[0].Measured || got[0].Reason != ReasonCoverageTooLarge {
		t.Fatalf("got %+v %v", got[0], err)
	}
}
