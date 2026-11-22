package toollayer_test

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockergvisor/toollayer"
)

func refusal(err error) string {
	var r *toollayer.BuildRefusal
	if errors.As(err, &r) {
		return r.Reason
	}
	return ""
}

var (
	keyA = strings.Repeat("a", 64)
	keyB = strings.Repeat("b", 64)
	keyC = strings.Repeat("c", 64)
)

// Two simultaneous misses of one key run one build.
func TestASecondBuildOfTheSameKeyIsRefusedWhileOneRuns(t *testing.T) {
	b := toollayer.NewBuildsLimits(newClock().Now, 4, 4)
	end, err := b.Begin("org-1", keyA)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := b.Begin("org-1", keyA); refusal(err) != "in_flight" {
		t.Fatalf("second build: %v", err)
	}
	end(false)
	if _, err := b.Begin("org-1", keyA); err != nil {
		t.Fatalf("after a good build: %v", err)
	}
}

// A failed build is not retried for 10 minutes, and only for that key.
func TestAFailedBuildIsNotRetriedForTenMinutes(t *testing.T) {
	clk := newClock()
	b := toollayer.NewBuildsLimits(clk.Now, 4, 4)
	end, _ := b.Begin("org-1", keyA)
	end(true)
	end(true) // ending twice changes nothing
	if _, err := b.Begin("org-1", keyA); refusal(err) != "recent_failure" {
		t.Fatalf("retry at once: %v", err)
	}
	if _, err := b.Begin("org-1", keyB); err != nil {
		t.Fatalf("another key: %v", err)
	}
	if _, err := b.Begin("org-2", keyA); err != nil {
		t.Fatalf("another org: %v", err)
	}
	clk.Advance(9*time.Minute + 59*time.Second)
	if _, err := b.Begin("org-1", keyA); refusal(err) != "recent_failure" {
		t.Fatalf("just before ten minutes: %v", err)
	}
	clk.Advance(2 * time.Second)
	if _, err := b.Begin("org-1", keyA); err != nil {
		t.Fatalf("after ten minutes: %v", err)
	}
}

// One build at a time on the cell, two per org.
func TestBuildsAreBoundedPerCellAndPerOrg(t *testing.T) {
	b := toollayer.NewBuilds(newClock().Now)
	end, err := b.Begin("org-1", keyA)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := b.Begin("org-2", keyB); refusal(err) != "cell_busy" {
		t.Fatalf("a second build on the cell: %v", err)
	}
	end(false)
	if _, err := b.Begin("org-2", keyB); err != nil {
		t.Fatal(err)
	}

	b = toollayer.NewBuildsLimits(newClock().Now, 10, 2)
	for _, k := range []string{keyA, keyB} {
		if _, err := b.Begin("org-1", k); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := b.Begin("org-1", keyC); refusal(err) != "org_busy" {
		t.Fatalf("a third build of the org: %v", err)
	}
	if _, err := b.Begin("org-2", keyC); err != nil {
		t.Fatalf("another org: %v", err)
	}
}

func TestABuildNeedsAnOrgAndAHexKey(t *testing.T) {
	b := toollayer.NewBuilds(nil)
	for _, c := range [][2]string{{"", keyA}, {"org", "../x"}} {
		if _, err := b.Begin(c[0], c[1]); err == nil {
			t.Fatalf("accepted %v", c)
		}
	}
}
