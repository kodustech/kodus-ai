package agent

import (
	"archive/tar"
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// blockingComposer holds Up until its context ends, as a long build does.
type blockingComposer struct{ started chan struct{} }

func (b *blockingComposer) Up(ctx context.Context, _ driver.UpRequest) ([]string, error) {
	close(b.started)
	<-ctx.Done()
	return nil, ctx.Err()
}

type readyComposer struct{}

func (readyComposer) Up(context.Context, driver.UpRequest) ([]string, error) {
	return []string{"172.30.0.2"}, nil
}

const diskFloor = 10 << 30

func diskHarness(t *testing.T, free *atomic.Uint64, composer driver.ComposeBooter) *harness {
	t.Helper()
	srv := repoServerWith(t, func(tw *tar.Writer) {
		const compose = "services:\n  api:\n    image: alpine:3.20\n"
		_ = tw.WriteHeader(&tar.Header{Name: "o-r-0123/compose.yaml", Typeflag: tar.TypeReg, Mode: 0o644, Size: int64(len(compose))})
		_, _ = tw.Write([]byte(compose))
	})
	return newHarness(t, func(c *Config) {
		c.Parts.Composer = composer
		c.Repo = func(protocol.ClaimAcquireBody) (string, error) { return srv + "/tarball", nil }
		c.DiskWatch = &DiskWatch{Free: func() (uint64, error) { return free.Load(), nil }, MinFreeBytes: diskFloor}
	})
}

func diskAcquire(h *harness) *protocol.ClaimAcquireBody {
	b := h.acquireBody()
	b.Expose = []protocol.Expose{{Service: "api", Port: 3000, Kind: protocol.ExposeKindHTTP}}
	return b
}

// A claim still booting when Docker's disk falls under the floor fails with
// the cell_disk_full blocker, which says why (review #7).
func TestABootingClaimFailsWhenTheDiskRunsLow(t *testing.T) {
	var free atomic.Uint64
	free.Store(1 << 30)
	bc := &blockingComposer{started: make(chan struct{})}
	h := diskHarness(t, &free, bc)
	if err := h.handle("claim-boot", protocol.MessageTypeClaimAcquire, diskAcquire(h)); err != nil {
		t.Fatal(err)
	}
	// Before the harness waits for the agent: a boot nothing stopped ends.
	t.Cleanup(func() {
		if c, ok := h.a.claims.Get("claim-boot"); ok {
			c.Release()
		}
	})
	select {
	case <-bc.started:
	case <-time.After(5 * time.Second):
		t.Fatal("the claim never reached Up")
	}
	if !h.a.checkDisk() {
		t.Fatal("the watchdog saw no low disk")
	}
	f := h.conn.next(t, isFailed).(*protocol.ClaimFailedBody)
	if f.Kind != protocol.BlockerKindResources || f.Signature != "cell_disk_full" || !strings.Contains(f.Reason, "free") {
		t.Fatalf("claim.failed %+v", f)
	}
}

// A ready claim is stopped and its machines go, so it writes no more and
// gives its disk back.
func TestAReadyClaimIsStoppedWhenTheDiskRunsLow(t *testing.T) {
	var free atomic.Uint64
	free.Store(100 << 30)
	h := diskHarness(t, &free, readyComposer{})
	if err := h.handle("claim-ready", protocol.MessageTypeClaimAcquire, diskAcquire(h)); err != nil {
		t.Fatal(err)
	}
	h.conn.next(t, isReady)
	if h.a.checkDisk() {
		t.Fatal("the watchdog stopped claims above the floor")
	}
	if _, ok := h.a.claims.Get("claim-ready"); !ok || len(h.drv.Machines()) == 0 {
		t.Fatal("a claim went above the floor")
	}
	free.Store(1 << 30)
	if !h.a.checkDisk() {
		t.Fatal("the watchdog saw no low disk")
	}
	h.a.Wait()
	if _, ok := h.a.claims.Get("claim-ready"); ok || len(h.drv.Machines()) != 0 {
		t.Fatalf("the ready claim kept running: %d machines", len(h.drv.Machines()))
	}
}

// A disk the watchdog cannot read stops nothing.
func TestADiskTheWatchdogCannotReadStopsNothing(t *testing.T) {
	h := newHarness(t, func(c *Config) {
		c.DiskWatch = &DiskWatch{Free: func() (uint64, error) { return 0, errors.New("statfs: no such file") }, MinFreeBytes: diskFloor}
	})
	if h.a.checkDisk() {
		t.Fatal("an unreadable disk stopped claims")
	}
}

// diskUsers is what each claim holds on Docker's disk, as a test sets it.
type diskUsers struct {
	usage atomic.Pointer[map[string]int64]
}

func (d *diskUsers) ClaimDiskUsage(context.Context) (map[string]int64, error) {
	return *d.usage.Load(), nil
}

// R3-03: a named volume has no quota, and the watchdog stopped every claim
// once one claim's volume filled the disk to the floor. Under the margin
// above it (twice the floor), the cell first stops the one claim whose disk
// grew the most since the last look, and the others run on.
func TestTheClaimWhoseDiskGrowsTheMostIsStoppedFirst(t *testing.T) {
	var free atomic.Uint64
	free.Store(100 << 30)
	users := &diskUsers{}
	h := diskHarness(t, &free, readyComposer{})
	h.a.cfg.Parts.DiskUsers = users
	for _, id := range []string{"claim-big", "claim-quiet"} {
		if err := h.handle(id, protocol.MessageTypeClaimAcquire, diskAcquire(h)); err != nil {
			t.Fatal(err)
		}
		h.conn.next(t, isReady)
	}
	set := func(m map[string]int64) { users.usage.Store(&m) }
	// The quiet claim holds more, the big one grows.
	set(map[string]int64{"claim-big": 1 << 30, "claim-quiet": 8 << 30})
	free.Store(15 << 30) // under the margin, above the floor
	if h.a.checkDisk() {
		t.Fatal("the floor was not reached")
	}
	h.a.Wait()
	if n := len(h.a.claims.All()); n != 2 {
		t.Fatalf("a first look stopped a claim (%d left): growth needs two", n)
	}
	set(map[string]int64{"claim-big": 4 << 30, "claim-quiet": 8<<30 + 1<<20})
	h.a.checkDisk()
	h.a.Wait()
	if _, ok := h.a.claims.Get("claim-big"); ok {
		t.Fatal("the claim whose disk grew the most still runs")
	}
	if _, ok := h.a.claims.Get("claim-quiet"); !ok {
		t.Fatal("the quiet claim was stopped too")
	}
}

// N7: the one claim the margin stops is the one that wrote the disk full, so
// it fails as resources/disk_top_writer, which excuses nothing. Only the
// stop-everything at the floor says resources/cell_disk_full, the cell's
// fault that excuses a PR's boot.
func TestTheTopWriterFailsAsItsOwnSignatureNotTheCellsDisk(t *testing.T) {
	var free atomic.Uint64
	free.Store(100 << 30)
	users := &diskUsers{}
	bc := &blockingComposer{started: make(chan struct{})}
	h := diskHarness(t, &free, bc)
	h.a.cfg.Parts.DiskUsers = users
	if err := h.handle("claim-boot", protocol.MessageTypeClaimAcquire, diskAcquire(h)); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if c, ok := h.a.claims.Get("claim-boot"); ok {
			c.Release()
		}
	})
	select {
	case <-bc.started:
	case <-time.After(5 * time.Second):
		t.Fatal("the claim never reached Up")
	}
	set := func(m map[string]int64) { users.usage.Store(&m) }
	free.Store(15 << 30) // under the margin, above the floor
	set(map[string]int64{"claim-boot": 1 << 30})
	if h.a.checkDisk() {
		t.Fatal("the floor was not reached")
	}
	waitDiskLook(t, h)
	set(map[string]int64{"claim-boot": 6 << 30})
	h.a.checkDisk()
	f := h.conn.next(t, isFailed).(*protocol.ClaimFailedBody)
	if f.Kind != protocol.BlockerKindResources || f.Signature != "disk_top_writer" || !strings.Contains(f.Reason, "grew the most") {
		t.Fatalf("claim.failed %+v", f)
	}
}

// waitDiskLook waits for the watchdog's look under the margin to end.
func waitDiskLook(t *testing.T, h *harness) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for h.a.disk.busy.Load() {
		if time.Now().After(deadline) {
			t.Fatal("the disk look never ended")
		}
		time.Sleep(5 * time.Millisecond)
	}
}
