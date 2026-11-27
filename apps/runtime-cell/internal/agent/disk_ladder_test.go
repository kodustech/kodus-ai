package agent

import (
	"context"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/metrics"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// ladderFakes record the order the rungs ran in and give back what each is
// told to, on the free space the test's watchdog reads.
type ladderFakes struct {
	free    *atomic.Uint64
	calls   []string
	trim    uint64
	prune   uint64 // per tier
	reclaim uint64
}

func (l *ladderFakes) Trim(context.Context) (uint64, error) {
	l.calls = append(l.calls, "fstrim")
	l.free.Add(l.trim)
	return l.trim, nil
}

func (l *ladderFakes) PruneBuildCache(_ context.Context, age time.Duration) (int64, error) {
	l.calls = append(l.calls, "prune:"+age.String())
	l.free.Add(l.prune)
	return int64(l.prune), nil
}

func (l *ladderFakes) ReclaimDisk() error {
	l.calls = append(l.calls, "reclaim")
	l.free.Add(l.reclaim)
	return nil
}

// The watchdog gives disk back before it stops anybody: fstrim first, then the
// cell's build cache oldest first, then ReclaimDisk, measuring free space
// after each rung and stopping at the first that gets above the line.
func TestTheReliefLadderStopsAtTheFirstRungThatClearsTheLine(t *testing.T) {
	allTiers := []string{"prune:168h0m0s", "prune:24h0m0s", "prune:1h0m0s", "prune:0s"}
	cases := []struct {
		name  string
		start uint64
		f     ladderFakes
		want  []string
		clear bool
	}{
		{"fstrim alone clears the floor", 1 << 30, ladderFakes{trim: 20 << 30}, []string{"fstrim"}, true},
		{"the oldest cache clears it after fstrim gave little", 1 << 30, ladderFakes{trim: 1 << 30, prune: 20 << 30}, []string{"fstrim", "prune:168h0m0s"}, true},
		{"reclaim is last, after every prune tier", 1 << 30, ladderFakes{reclaim: 20 << 30}, append(append([]string{"fstrim"}, allTiers...), "reclaim"), true},
		{"nothing helps: every rung ran in order and the disk is still low", 1 << 30, ladderFakes{}, append(append([]string{"fstrim"}, allTiers...), "reclaim"), false},
		{"a disk already above the line runs no rung", 50 << 30, ladderFakes{trim: 1 << 30}, nil, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var free atomic.Uint64
			free.Store(tc.start)
			f := tc.f
			f.free = &free
			h := diskHarness(t, &free, readyComposer{})
			h.a.cfg.DiskWatch.Trim = f.Trim
			h.a.cfg.Parts.BuildCache = &f
			h.a.cfg.Parts.DiskReclaim = &f
			got := h.a.relieveLadder(context.Background(), tc.start, diskFloor)
			if !reflect.DeepEqual(f.calls, tc.want) {
				t.Fatalf("rungs ran %v, want %v", f.calls, tc.want)
			}
			if (got >= diskFloor) != tc.clear {
				t.Fatalf("free after the ladder %d MiB, clear=%v want %v", got>>20, got >= diskFloor, tc.clear)
			}
		})
	}
}

// What each rung freed is recorded, by rung, in a counter and in the log.
func TestEachRungRecordsItsFreedBytes(t *testing.T) {
	var free atomic.Uint64
	free.Store(1 << 30)
	f := &ladderFakes{free: &free, trim: 2 << 30, prune: 3 << 30}
	h := diskHarness(t, &free, readyComposer{})
	h.a.m = newAgentMetrics(metrics.NewRegistry())
	h.a.cfg.DiskWatch.Trim = f.Trim
	h.a.cfg.Parts.BuildCache = f
	h.a.relieveLadder(context.Background(), 1<<30, 30<<30)
	if got := h.a.m.diskFreed.Value("fstrim"); got != float64(2<<30) {
		t.Fatalf("fstrim freed %v", got)
	}
	if got := h.a.m.diskFreed.Value("build_cache"); got != float64(12<<30) { // four tiers of 3 GiB
		t.Fatalf("build_cache freed %v", got)
	}
	if !strings.Contains(h.logs.String(), "disk.rung") || !strings.Contains(h.logs.String(), "rung=fstrim") {
		t.Fatalf("no rung in the log:\n%s", h.logs.String())
	}
}

// The sparse file under the build-state volume can be full while the inner
// filesystem shows room: the watchdog works with the smaller of the two, so
// the ladder runs when only the outer disk is low.
func TestTheOuterFilesystemCountsWhenItHasLessRoomThanTheInnerOne(t *testing.T) {
	cases := []struct {
		name         string
		inner, outer uint64
		outerNil     bool
		wantLadder   bool
	}{
		{"inner has room, outer is low", 100 << 30, 1 << 30, false, true},
		{"both have room", 100 << 30, 100 << 30, false, false},
		{"inner is low, outer has room", 1 << 30, 100 << 30, false, true},
		{"no outer disk configured", 100 << 30, 0, true, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var inner, outer atomic.Uint64
			inner.Store(tc.inner)
			outer.Store(tc.outer)
			f := &ladderFakes{free: &inner}
			h := diskHarness(t, &inner, readyComposer{})
			if !tc.outerNil {
				h.a.cfg.DiskWatch.Outer = func() (uint64, error) { return outer.Load(), nil }
			}
			h.a.cfg.DiskWatch.Trim = f.Trim
			h.a.checkDisk()
			h.a.Wait()
			if ran := len(f.calls) > 0; ran != tc.wantLadder {
				t.Fatalf("ladder ran=%v calls=%v, want %v", ran, f.calls, tc.wantLadder)
			}
		})
	}
}

// PerRunBytes is the room one more Run needs above the floor: the margin is the
// floor plus it, and twice the floor when it is zero.
func TestThePerRunFloorSetsTheMargin(t *testing.T) {
	cases := []struct {
		perRun uint64
		want   uint64
	}{{0, 2 * diskFloor}, {4 << 30, diskFloor + 4<<30}, {30 << 30, diskFloor + 30<<30}}
	for _, tc := range cases {
		w := &DiskWatch{MinFreeBytes: diskFloor, PerRunBytes: tc.perRun}
		if got := w.margin(); got != tc.want {
			t.Fatalf("perRun %d: margin %d, want %d", tc.perRun, got, tc.want)
		}
	}
}

// A claim that turned ready within the grace window is never the one stopped
// for being the top writer while another claim can be; it is stopped only when
// nothing else is left, loudly, with the reason recorded.
func TestAClaimThatJustTurnedReadyIsSparedAsTheTopWriter(t *testing.T) {
	cases := []struct {
		name string
		// older is acquired first and is claim-quiet; claim-big (the top
		// writer) is acquired after the gap and is ageAfter old when the
		// watchdog looks.
		gap, ageAfter time.Duration
		wantGone      string
		wantLoud      bool
	}{
		{"both are past the grace window: the top writer is stopped", 10 * time.Minute, 10 * time.Minute, "claim-big", false},
		{"the top writer just turned ready: the older claim is stopped instead", 10 * time.Minute, 0, "claim-quiet", false},
		{"both just turned ready: the top writer is stopped, loudly", 0, 0, "claim-big", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var free atomic.Uint64
			free.Store(100 << 30)
			users := &diskUsers{}
			h := diskHarness(t, &free, readyComposer{})
			h.a.cfg.Parts.DiskUsers = users
			h.a.cfg.DiskWatch.ReadyGrace = 2 * time.Minute
			for i, id := range []string{"claim-quiet", "claim-big"} {
				if i == 1 {
					h.clk.Advance(tc.gap)
				}
				if err := h.handle(id, protocol.MessageTypeClaimAcquire, diskAcquire(h)); err != nil {
					t.Fatal(err)
				}
				h.conn.next(t, isReady)
			}
			h.clk.Advance(tc.ageAfter)
			set := func(m map[string]int64) { users.usage.Store(&m) }
			set(map[string]int64{"claim-big": 1 << 30, "claim-quiet": 1 << 30})
			free.Store(15 << 30) // under the margin, above the floor
			h.a.checkDisk()
			h.a.Wait()
			set(map[string]int64{"claim-big": 6 << 30, "claim-quiet": 1<<30 + 1<<20})
			free.Store(15 << 30)
			h.a.checkDisk()
			h.a.Wait()
			for _, id := range []string{"claim-big", "claim-quiet"} {
				_, alive := h.a.claims.Get(id)
				if gone := !alive; gone != (id == tc.wantGone) {
					t.Fatalf("%s gone=%v, want gone only for %s", id, gone, tc.wantGone)
				}
			}
			if loud := strings.Contains(h.logs.String(), "disk.victim_in_grace"); loud != tc.wantLoud {
				t.Fatalf("victim_in_grace logged=%v, want %v:\n%s", loud, tc.wantLoud, h.logs.String())
			}
		})
	}
}

// At the floor, a claim in its ready grace window is stopped only when no
// other claim was left to stop.
func TestTheFloorSparesAClaimThatJustTurnedReadyWhileAnotherCanStop(t *testing.T) {
	cases := []struct {
		name     string
		gap      time.Duration
		wantGone []string
		wantLoud bool
	}{
		{"an old claim is stopped and the new one is spared", 10 * time.Minute, []string{"claim-old"}, false},
		{"only a new claim is left: it is stopped, loudly", 0, []string{"claim-old", "claim-new"}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var free atomic.Uint64
			free.Store(100 << 30)
			h := diskHarness(t, &free, readyComposer{})
			h.a.cfg.DiskWatch.ReadyGrace = 2 * time.Minute
			for i, id := range []string{"claim-old", "claim-new"} {
				if i == 1 {
					h.clk.Advance(tc.gap)
				}
				if err := h.handle(id, protocol.MessageTypeClaimAcquire, diskAcquire(h)); err != nil {
					t.Fatal(err)
				}
				h.conn.next(t, isReady)
			}
			free.Store(1 << 30) // under the floor
			if !h.a.checkDisk() {
				t.Fatal("the floor was not reached")
			}
			h.a.Wait()
			gone := map[string]bool{}
			for _, id := range []string{"claim-old", "claim-new"} {
				if _, ok := h.a.claims.Get(id); !ok {
					gone[id] = true
				}
			}
			for _, id := range []string{"claim-old", "claim-new"} {
				want := false
				for _, g := range tc.wantGone {
					want = want || g == id
				}
				if gone[id] != want {
					t.Fatalf("%s gone=%v, want %v", id, gone[id], want)
				}
			}
			if loud := strings.Contains(h.logs.String(), "disk.victim_in_grace"); loud != tc.wantLoud {
				t.Fatalf("victim_in_grace logged=%v, want %v", loud, tc.wantLoud)
			}
		})
	}
}
