package exercised

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCollectReadsCoverageFilesAndSkipsTheRest(t *testing.T) {
	dir := t.TempDir()
	raw, _ := os.ReadFile(filepath.Join("testdata", "coverage-plain.json"))
	for name, body := range map[string]string{"coverage-1.json": string(raw), "coverage-2.json": "{not json", "notes.txt": "x"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(filepath.Join(dir, "coverage-1.json"), filepath.Join(dir, "coverage-3.json")); err != nil {
		t.Fatal(err)
	}
	covs, err := Collect(dir)
	if err != nil || len(covs) != 1 {
		t.Fatalf("got %d coverages, %v; want the one regular file that parses", len(covs), err)
	}
}

func TestAMissingDirIsNoCoverage(t *testing.T) {
	got := Answer([]File{{Path: "src/a.js", Lines: []int{1}}}, filepath.Join(t.TempDir(), "absent"), fromTestdata)
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
	got := Answer([]File{{Path: "src/a.js", Lines: []int{1}}}, dir, fromTestdata)
	if got[0].Measured || got[0].Reason != ReasonCoverageTooLarge {
		t.Fatalf("got %+v", got[0])
	}
}
