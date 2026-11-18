package buildprogress

import (
	"os"
	"reflect"
	"strings"
	"testing"
	"time"
)

// The fixtures in testdata are synthetic, in the shape BuildKit v0.34's
// plain progress prints (captured from a local rootless build of a made-up
// project): a Node setup exported as a docker tarball, the same project's
// pull request pushed to a registry, and a setup stopped while it exported.

func feedFile(t *testing.T, tr *Tracker, name string) {
	t.Helper()
	b, err := os.ReadFile("testdata/" + name)
	if err != nil {
		t.Fatal(err)
	}
	feed(tr, string(b))
}

// The cold setup: the install, the export of its layers and the tarball
// are where the time went, and the export is split into its parts.
func TestPhasesOfAColdSetupExportedAsATarball(t *testing.T) {
	tr := New()
	feedFile(t, tr, "node-setup-docker.txt")
	got := tr.Phases(8)
	want := []Phase{
		{Name: "export layers", Ms: 1_260_400},
		{Name: "yarn install", Ms: 1_005_300},
		{Name: "yarn build", Ms: 412_700},
		{Name: "COPY . .", Ms: 88_200},
		{Name: "send tarball", Ms: 87_100},
		{Name: "send context", Ms: 71_000},
		{Name: "pull node:20-bookworm", Ms: 33_600}, // FROM 31.2 s + metadata 2.4 s
		{Name: "rm", Ms: 2_100},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("phases:\n%+v\nwant:\n%+v", got, want)
	}
}

// A pull request pushed to the cell's registry: the cached install is no
// phase, the export says it pushed instead of sending a tarball.
func TestPhasesOfAPullRequestPushedToTheRegistry(t *testing.T) {
	tr := New()
	feedFile(t, tr, "node-pr-registry.txt")
	got := tr.Phases(-1)
	want := []Phase{
		{Name: "yarn build", Ms: 96_400},
		{Name: "export layers", Ms: 31_600},
		{Name: "COPY . .", Ms: 9_800},
		{Name: "push layers", Ms: 6_200},
		{Name: "send context", Ms: 4_000},
		{Name: "pull node:20-bookworm", Ms: 1_200},
		{Name: "rm", Ms: 1_000},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("phases:\n%+v\nwant:\n%+v", got, want)
	}
}

// The claim's ceiling stopped the build while it exported: the export
// counts from the line that started it to now, and says it was running.
func TestAPhaseStillRunningCountsUntilNow(t *testing.T) {
	at := time.Date(2026, 11, 11, 10, 0, 0, 0, time.UTC)
	now := at
	tr := NewAt(func() time.Time { return now })
	b, err := os.ReadFile("testdata/node-ceiling.txt")
	if err != nil {
		t.Fatal(err)
	}
	for _, l := range strings.Split(string(b), "\n") {
		tr.Line(l)
		now = now.Add(time.Second)
	}
	now = now.Add(20 * time.Minute)
	got := tr.Phases(3)
	if len(got) != 3 || got[0].Name != "export layers" || !got[0].Running || got[0].Ms < 20*60_000 || got[0].Ms > 21*60_000 {
		t.Fatalf("phases: %+v", got)
	}
	if got[1] != (Phase{Name: "yarn install", Ms: 1_005_300}) || got[2] != (Phase{Name: "COPY . .", Ms: 88_200}) {
		t.Fatalf("phases: %+v", got)
	}
}

// A step that failed counts until its last line, and is not running.
func TestAFailedStepCountsUntilItsLastLine(t *testing.T) {
	now := time.Date(2026, 11, 11, 10, 0, 0, 0, time.UTC)
	tr := NewAt(func() time.Time { return now })
	tr.Line("#6 [deps 3/5] RUN npm ci")
	now = now.Add(90 * time.Second)
	tr.Line(`#6 ERROR: process "/bin/sh -c npm ci" did not complete successfully: exit code: 1`)
	now = now.Add(time.Hour)
	if got := tr.Phases(-1); len(got) != 1 || got[0] != (Phase{Name: "npm ci", Ms: 90_000}) {
		t.Fatalf("phases: %+v", got)
	}
}

// A phase name comes from the step's name, which the tracker already
// redacted: a secret on a RUN line never reaches it.
func TestPhaseNamesComeFromRedactedNames(t *testing.T) {
	tr := New()
	tr.Line("#1 [a 1/1] RUN NPM_TOKEN=npm_0123456789abcdefghijABCDEFGHIJ012345 npm ci")
	tr.Line("#1 DONE 3.0s")
	if got := tr.Phases(1); len(got) != 1 || got[0].Name != "npm ci" {
		t.Fatalf("phases: %+v", got)
	}
}
