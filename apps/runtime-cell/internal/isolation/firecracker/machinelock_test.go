package firecracker

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/placement/hostnet"
)

// F2-01: the reaper's orphan pass read the records once, then removed what
// no record named; a Create that wrote its record after that read lost its
// jail and cgroup while it booted. A Create now waits for the pass, and the
// pass for a Create, so the pass never removes a machine being made.
func TestTheOrphanPassNeverRemovesAMachineBeingMade(t *testing.T) {
	vmm := &fakeVMM{t: t, state: map[string]string{}, args: map[string][]string{}}
	n := &invNet{fakeNet: &fakeNet{taps: map[string]hostnet.Attachment{}}}
	b := newBackend(t, vmm, n.fakeNet)
	b.cfg.Network = n
	rp, err := ForReaper(b.cfg)
	if err != nil {
		t.Fatal(err)
	}
	read, resume := make(chan struct{}), make(chan struct{})
	rp.orphanPassRead = func() { close(read); <-resume }
	type result struct {
		gone []string
		err  error
	}
	pass := make(chan result, 1)
	go func() {
		gone, err := rp.ReapOrphans(context.Background())
		pass <- result{gone, err}
	}()
	<-read // the pass has its records: none yet
	created := make(chan error, 1)
	var made isolation.Machine
	go func() {
		m, err := b.Create(context.Background(), isolation.Spec{Shape: isolation.ShapeSandbox, Name: "kodus-a-workload", Network: "kodus-a"})
		made = m
		created <- err
	}()
	// Without the lock the Create ends here, before the pass removes
	// anything; with it, the Create waits for the pass.
	select {
	case err := <-created:
		if err != nil {
			t.Fatal(err)
		}
		created <- nil
	case <-time.After(300 * time.Millisecond):
	}
	close(resume)
	r := <-pass
	if r.err != nil {
		t.Fatal(r.err)
	}
	if err := <-created; err != nil {
		t.Fatal(err)
	}
	for _, g := range r.gone {
		if strings.Contains(g, made.ID) {
			t.Fatalf("the pass removed %q of the machine being made", g)
		}
	}
	if _, err := os.Stat(b.jailDir(made.ID)); err != nil {
		t.Fatalf("the new machine's jail: %v", err)
	}
}
