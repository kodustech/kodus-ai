package toollayer_test

import (
	"testing"
	"time"
)

func TestShouldBuildOnlyOnTheSecondMissWithinSevenDays(t *testing.T) {
	r := newRig(t)
	key := hex64("1")
	if r.store.ShouldBuild("o", key) {
		t.Fatal("build before any miss")
	}
	if err := r.store.RecordMiss("o", key); err != nil {
		t.Fatal(err)
	}
	if r.store.ShouldBuild("o", key) {
		t.Fatal("build on the first miss: it already paid one install in the review")
	}
	r.clock.Advance(2 * 24 * time.Hour)
	if err := r.store.RecordMiss("o", key); err != nil {
		t.Fatal(err)
	}
	if !r.store.ShouldBuild("o", key) {
		t.Fatal("no build on the second miss")
	}
	// Still true until the window passes over both.
	r.clock.Advance(4 * 24 * time.Hour)
	if !r.store.ShouldBuild("o", key) {
		t.Fatal("one miss fell out of the window too early")
	}
}

func TestMissesOutsideTheWindowDoNotCount(t *testing.T) {
	r := newRig(t)
	key := hex64("1")
	r.store.RecordMiss("o", key)
	r.clock.Advance(8 * 24 * time.Hour)
	r.store.RecordMiss("o", key)
	if r.store.ShouldBuild("o", key) {
		t.Fatal("two misses 8 days apart count as a repeat")
	}
	r.clock.Advance(time.Hour)
	r.store.RecordMiss("o", key)
	if !r.store.ShouldBuild("o", key) {
		t.Fatal("two misses inside the window do not")
	}
}

func TestMissesAreKeptPerOrgAndKeyAndSurviveARestart(t *testing.T) {
	r := newRig(t)
	r.store.RecordMiss("a", hex64("1"))
	r.store.RecordMiss("a", hex64("1"))
	r.store.RecordMiss("a", hex64("2"))
	r.store.RecordMiss("b", hex64("1"))
	r.reopen()
	if !r.store.ShouldBuild("a", hex64("1")) {
		t.Fatal("misses lost on restart")
	}
	if r.store.ShouldBuild("a", hex64("2")) || r.store.ShouldBuild("b", hex64("1")) {
		t.Fatal("misses leaked across keys or orgs")
	}
}

func TestRecordMissRefusesAnInvalidKey(t *testing.T) {
	r := newRig(t)
	if err := r.store.RecordMiss("o", "../../x"); err == nil {
		t.Fatal("hostile key accepted")
	}
	if r.store.ShouldBuild("o", "../../x") {
		t.Fatal("hostile key builds")
	}
}
