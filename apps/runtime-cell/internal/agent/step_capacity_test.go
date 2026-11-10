package agent

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/claims"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// Distinct steps used to start without a limit: 32 channel-blocked fake
// callbacks entered concurrently on one ready claim (#2463).
func TestClaimStepAdmissionBoundsFanout(t *testing.T) {
	h := newHarness(t)
	h.ready("claim-fanout")
	unblock := make(chan struct{})
	defer close(unblock)
	accepted := 0
	for i := 0; i < 32; i++ {
		s := stepAdmission{kind: protocol.MessageTypeExec, claimID: "claim-fanout", stepID: fmt.Sprintf("step-%d", i), canon: []byte("synthetic"), allowHeld: true}
		err := h.a.admitStep(s, func(context.Context, *claims.Claim) { <-unblock })
		switch code := nackCode(err); code {
		case "":
			accepted++
		case "step_capacity":
		default:
			t.Fatalf("admission: %v", err)
		}
	}
	if accepted != 4 {
		t.Fatalf("admitted %d concurrent steps; want default 4", accepted)
	}
	if h.a.steps.Len() != 4 {
		t.Fatalf("refused steps consumed dedup entries: %d", h.a.steps.Len())
	}
}

func TestClaimStepCapacityIsSharedByKindsAndIndependentAcrossClaims(t *testing.T) {
	for _, limit := range []int{1, 8} {
		t.Run(fmt.Sprint(limit), func(t *testing.T) {
			h := newHarness(t, func(c *Config) { c.MaxClaimSteps = limit })
			h.ready("claim-a")
			h.ready("claim-b")
			unblock := make(chan struct{})
			defer close(unblock)
			work := func(context.Context, *claims.Claim) { <-unblock }
			for i := 0; i < limit; i++ {
				if err := h.a.admitStep(stepAdmission{kind: protocol.MessageTypeExec, claimID: "claim-a", stepID: fmt.Sprintf("a-%d", i)}, work); err != nil {
					t.Fatal(err)
				}
			}
			for _, kind := range []protocol.MessageType{protocol.MessageTypeExec, protocol.MessageTypeProbeRun, protocol.MessageTypeMachineReset} {
				if code := nackCode(h.a.admitStep(stepAdmission{kind: kind, claimID: "claim-a", stepID: string(kind)}, work)); code != "step_capacity" {
					t.Fatalf("%s: %s", kind, code)
				}
			}
			if err := h.a.admitStep(stepAdmission{kind: protocol.MessageTypeExec, claimID: "claim-b", stepID: "b-1"}, work); err != nil {
				t.Fatalf("another claim: %v", err)
			}
		})
	}
}

func TestClaimStepCapacityPreservesDeduplicationAndRetryAfterRoom(t *testing.T) {
	h := newHarness(t, func(c *Config) { c.MaxClaimSteps = 1 })
	h.ready("claim-a")
	unblock := make(chan struct{})
	var once sync.Once
	finish := func() { once.Do(func() { close(unblock) }); h.a.Wait() }
	defer finish()
	s := stepAdmission{kind: protocol.MessageTypeExec, claimID: "claim-a", stepID: "first", canon: []byte("first")}
	var calls atomic.Int32
	started := make(chan struct{}, 1)
	work := func(context.Context, *claims.Claim) { calls.Add(1); started <- struct{}{}; <-unblock }
	if err := h.a.admitStep(s, work); err != nil {
		t.Fatal(err)
	}
	if err := h.a.admitStep(s, work); err != nil {
		t.Fatalf("duplicate at saturation: %v", err)
	}
	conflict := s
	conflict.canon = []byte("changed")
	if code := nackCode(h.a.admitStep(conflict, work)); code != "step_conflict" {
		t.Fatalf("conflict: %s", code)
	}
	second := stepAdmission{kind: protocol.MessageTypeExec, claimID: "claim-a", stepID: "second"}
	if code := nackCode(h.a.admitStep(second, work)); code != "step_capacity" {
		t.Fatalf("capacity: %s", code)
	}
	<-started
	finish()
	if calls.Load() != 1 {
		t.Fatalf("duplicate work ran %d times", calls.Load())
	}
	if err := h.a.admitStep(second, func(context.Context, *claims.Claim) {}); err != nil {
		t.Fatalf("retry after room: %v", err)
	}
	h.a.Wait()
	if h.a.steps.Len() != 2 {
		t.Fatalf("dedup entries: %d", h.a.steps.Len())
	}
}

func TestCancelledClaimStepHoldsCapacityUntilItsWorkReturns(t *testing.T) {
	h := newHarness(t, func(c *Config) { c.MaxClaimSteps = 1 })
	h.ready("claim-a")
	started, cancelled, exit := make(chan struct{}), make(chan struct{}), make(chan struct{})
	s := stepAdmission{kind: protocol.MessageTypeExec, claimID: "claim-a", stepID: "first"}
	if err := h.a.admitStep(s, func(ctx context.Context, _ *claims.Claim) { close(started); <-ctx.Done(); close(cancelled); <-exit }); err != nil {
		t.Fatal(err)
	}
	<-started
	c, _ := h.a.claims.Get("claim-a")
	c.CancelStep("first")
	<-cancelled
	second := stepAdmission{kind: protocol.MessageTypeExec, claimID: "claim-a", stepID: "second"}
	if code := nackCode(h.a.admitStep(second, func(context.Context, *claims.Claim) {})); code != "step_capacity" {
		close(exit)
		t.Fatalf("cancel freed running work: %s", code)
	}
	close(exit)
	h.a.Wait()
	if err := h.a.admitStep(second, func(context.Context, *claims.Claim) {}); err != nil {
		t.Fatalf("refused step was consumed or capacity leaked: %v", err)
	}
	h.a.Wait()
}

type waitingResultSender struct{ started, ack chan struct{} }

func (s waitingResultSender) Request(ctx context.Context, _ protocol.Header, _ any) error {
	close(s.started)
	select {
	case <-s.ack:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func TestClaimStepCapacitySettlesBeforeResultDelivery(t *testing.T) {
	h := newHarness(t, func(c *Config) { c.MaxClaimSteps = 1 })
	h.ready("claim-a")
	sender := waitingResultSender{started: make(chan struct{}), ack: make(chan struct{})}
	h.a.mu.Lock()
	h.a.conn = sender
	h.a.mu.Unlock()
	defer close(sender.ack)
	s := stepAdmission{kind: protocol.MessageTypeExec, claimID: "claim-a", stepID: "first"}
	if err := h.a.admitStep(s, func(ctx context.Context, c *claims.Claim) {
		h.a.sendStepResult(ctx, c, "exec", &protocol.StepResultBody{StepID: "first", Executor: protocol.ExecutorVM, VMHealth: protocol.VMHealthOk})
	}); err != nil {
		t.Fatal(err)
	}
	<-sender.started
	second := stepAdmission{kind: protocol.MessageTypeMachineReset, claimID: "claim-a", stepID: "second"}
	if err := h.a.admitStep(second, func(context.Context, *claims.Claim) {}); err != nil {
		t.Fatalf("result ACK consumed active capacity: %v", err)
	}
	c, _ := h.a.claims.Get("claim-a")
	if !c.CancelStep("first") {
		t.Fatal("delivery lost its cancellation registration")
	}
}

func TestClaimStepLimitDefaultsAndValidation(t *testing.T) {
	h := newHarness(t)
	for _, n := range []int{0, 1, 8, 64, -1, 65} {
		cfg := h.a.cfg
		cfg.MaxClaimSteps = n
		a, err := New(cfg)
		if n < 0 || n > 64 {
			if err == nil {
				t.Fatalf("accepted limit %d", n)
			}
			continue
		}
		if err != nil {
			t.Fatal(err)
		}
		want := n
		if want == 0 {
			want = 4
		}
		if a.cfg.MaxClaimSteps != want {
			t.Fatalf("limit %d resolved to %d", n, a.cfg.MaxClaimSteps)
		}
	}
}

func TestClaimStepCapacityBoundsWorkAwaitingPreparation(t *testing.T) {
	for _, release := range []bool{false, true} {
		t.Run(fmt.Sprintf("released=%v", release), func(t *testing.T) {
			h := newHarness(t, func(c *Config) { c.MaxClaimSteps = 1 })
			c := claims.New("claim-pending", protocol.ClaimAcquireBody{}, h.a.log, h.clk.Now())
			if err := h.a.claims.Add(c); err != nil {
				t.Fatal(err)
			}
			var calls atomic.Int32
			work := func(context.Context, *claims.Claim) { calls.Add(1) }
			first := stepAdmission{kind: protocol.MessageTypeExec, claimID: c.ID, stepID: "first"}
			if err := h.a.admitStep(first, work); err != nil {
				t.Fatal(err)
			}
			second := first
			second.stepID = "second"
			if code := nackCode(h.a.admitStep(second, work)); code != "step_capacity" {
				t.Fatalf("waiting work was not bounded: %s", code)
			}
			if release {
				c.Release()
			} else {
				c.MarkFailed(errors.New("preparation failed"), nil, time.Time{})
			}
			h.a.Wait()
			if calls.Load() != 0 || c.CancelStep("first") {
				t.Fatal("unsettled work ran or retained registration")
			}
			if !release {
				if err := c.TryAddStep("check", func() {}, 1); err != nil {
					t.Fatalf("failed preparation leaked capacity: %v", err)
				}
				c.RemoveStep("check")
			}
		})
	}
}

func TestClaimStepCapacityIsAtomicAcrossConcurrentAdmissions(t *testing.T) {
	h := newHarness(t)
	h.ready("claim-a")
	unblock := make(chan struct{})
	defer close(unblock)
	var submitted sync.WaitGroup
	var accepted atomic.Int32
	for i := 0; i < 32; i++ {
		submitted.Add(1)
		go func(i int) {
			defer submitted.Done()
			err := h.a.admitStep(stepAdmission{kind: protocol.MessageTypeExec, claimID: "claim-a", stepID: fmt.Sprint(i)}, func(context.Context, *claims.Claim) { <-unblock })
			if err == nil {
				accepted.Add(1)
			} else if nackCode(err) != "step_capacity" {
				t.Errorf("admission: %v", err)
			}
		}(i)
	}
	submitted.Wait()
	if accepted.Load() != 4 {
		t.Fatalf("racing admissions accepted %d", accepted.Load())
	}
}
