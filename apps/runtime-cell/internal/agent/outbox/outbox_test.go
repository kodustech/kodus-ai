package outbox

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/clock"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/hubclient"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// scripted answers each Request with the next error of its script.
type scripted struct {
	mu     sync.Mutex
	script []error
	sent   int
}

func (s *scripted) Request(context.Context, protocol.Header, any) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sent++
	if len(s.script) == 0 {
		return nil
	}
	err := s.script[0]
	s.script = s.script[1:]
	return err
}

func box(conn func() hubclient.Sender, clk *clock.Fake) *Outbox {
	return New(Config{Conn: conn, Clock: clk, Attempts: 4, Backoff: time.Second, MaxBackoff: 3 * time.Second})
}

func TestDeliverRetriesUntilAckWithoutSleeping(t *testing.T) {
	clk := clock.NewFake(time.Unix(0, 0))
	s := &scripted{script: []error{hubclient.ErrAckTimeout, hubclient.ErrClosed}}
	start := time.Now()
	if err := box(func() hubclient.Sender { return s }, clk).Deliver(context.Background(), Frame{ClaimID: "c", Kind: "step.result", Body: &protocol.StepResultBody{}}); err != nil {
		t.Fatal(err)
	}
	if s.sent != 3 || clk.Now() != time.Unix(3, 0) || time.Since(start) > time.Second {
		t.Fatalf("sent %d, clock %s, took %s", s.sent, clk.Now(), time.Since(start))
	}
}

func TestDeliverStopsAtANackAndAfterItsAttempts(t *testing.T) {
	clk := clock.NewFake(time.Unix(0, 0))
	s := &scripted{script: []error{hubclient.ErrAckTimeout, &hubclient.NackError{Code: "unknown_claim"}}}
	var n *hubclient.NackError
	if err := box(func() hubclient.Sender { return s }, clk).Deliver(context.Background(), Frame{Kind: "claim.ready"}); !errors.As(err, &n) || s.sent != 2 {
		t.Fatalf("nack: %v after %d sends", err, s.sent)
	}
	// No connection at all: four attempts, 1+2+3 s of backoff (capped), then
	// the last error.
	if err := box(func() hubclient.Sender { return nil }, clk).Deliver(context.Background(), Frame{Kind: "claim.ready"}); !errors.Is(err, ErrNoConnection) {
		t.Fatalf("no connection: %v", err)
	}
	if clk.Now() != time.Unix(1+6, 0) {
		t.Fatalf("backoff waited until %s", clk.Now())
	}
}

func TestDeliverDropsAFrameNobodyWants(t *testing.T) {
	s := &scripted{}
	err := box(func() hubclient.Sender { return s }, clock.NewFake(time.Unix(0, 0))).Deliver(context.Background(), Frame{Kind: "step.result", Wanted: func() bool { return false }})
	if !errors.Is(err, ErrUnwanted) || s.sent != 0 {
		t.Fatalf("%v, sent %d", err, s.sent)
	}
}

// A frame the cell's own encoder refuses is never sent again: no retry fixes it.
func TestDeliverStopsAtAFrameTheProtocolRefuses(t *testing.T) {
	clk := clock.NewFake(time.Unix(0, 0))
	refused := fmt.Errorf("%w claim.ready: invalid_body: body.manifest.imageId: longer than 128", protocol.ErrRefusedToSend)
	s := &scripted{script: []error{refused}}
	if err := box(func() hubclient.Sender { return s }, clk).Deliver(context.Background(), Frame{Kind: "claim.ready"}); !errors.Is(err, protocol.ErrRefusedToSend) || s.sent != 1 || clk.Now() != time.Unix(0, 0) {
		t.Fatalf("%v after %d sends, clock %s", err, s.sent, clk.Now())
	}
}
