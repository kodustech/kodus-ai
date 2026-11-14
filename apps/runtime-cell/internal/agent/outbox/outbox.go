// Package outbox delivers the cell's claim-scoped frames (claim.ready,
// claim.failed, step.result) until the hub acks them, over whatever
// connection the cell holds at each attempt: a frame lost with a connection
// is sent again on the next one. The hub is idempotent by claimId and
// stepId, so a resend of what it already has is acked.
package outbox

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/clock"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/hubclient"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/metrics"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// ErrNoConnection is an attempt made while the cell has no hub session.
var ErrNoConnection = errors.New("outbox: no hub connection")

// ErrUnwanted ends a delivery whose frame no longer matters (the claim was
// released).
var ErrUnwanted = errors.New("outbox: frame no longer wanted")

type Config struct {
	// Conn returns the current hub connection, nil between sessions.
	Conn func() hubclient.Sender
	// Attempts bounds the sends of one frame (default 6); Backoff is the
	// first wait between them, doubling up to MaxBackoff (defaults 1 s and
	// 30 s).
	Attempts   int
	Backoff    time.Duration
	MaxBackoff time.Duration
	Clock      clock.Clock
	NewID      func() string
	Metrics    *metrics.Registry
}

type Outbox struct {
	cfg        Config
	deliveries *metrics.Vec
	retries    *metrics.Vec
}

func New(cfg Config) *Outbox {
	if cfg.Attempts <= 0 {
		cfg.Attempts = 6
	}
	if cfg.Backoff <= 0 {
		cfg.Backoff = time.Second
	}
	if cfg.MaxBackoff <= 0 {
		cfg.MaxBackoff = 30 * time.Second
	}
	cfg.Clock = clock.Or(cfg.Clock)
	if cfg.NewID == nil {
		cfg.NewID = hubclient.NewID
	}
	return &Outbox{
		cfg:        cfg,
		deliveries: cfg.Metrics.Counter("cell_hub_deliveries_total", "Claim frames the cell delivered, by kind and outcome (acked, nacked, gave_up, dropped).", "kind", "outcome"),
		retries:    cfg.Metrics.Counter("cell_hub_delivery_retries_total", "Resends of claim frames the hub did not ack.", "kind"),
	}
}

// Frame is one claim-scoped frame to deliver.
type Frame struct {
	ClaimID string
	Kind    string // claim.ready, step.result...: logs and metrics
	Body    any
	Log     *slog.Logger
	// Wanted, when set, is asked before every attempt: false ends the
	// delivery with ErrUnwanted.
	Wanted func() bool
}

// Deliver sends f until the hub acks it (nil). A nack is final and
// returned; so is the last error after Attempts, ctx's end, or ErrUnwanted.
func (o *Outbox) Deliver(ctx context.Context, f Frame) error {
	log := f.Log
	if log == nil {
		log = slog.Default()
	}
	wait := o.cfg.Backoff
	for attempt := 1; ; attempt++ {
		if f.Wanted != nil && !f.Wanted() {
			o.deliveries.Inc(f.Kind, "dropped")
			log.Info(f.Kind+".dropped", "attempt", attempt, "reason", "claim released")
			return ErrUnwanted
		}
		var err error
		if conn := o.cfg.Conn(); conn == nil {
			err = ErrNoConnection
		} else {
			err = conn.Request(ctx, protocol.Header{ID: o.cfg.NewID(), ClaimID: f.ClaimID}, f.Body)
		}
		if err == nil {
			o.deliveries.Inc(f.Kind, "acked")
			if attempt > 1 {
				log.Info(f.Kind+".acked", "attempt", attempt)
			}
			return nil
		}
		if errors.Is(err, protocol.ErrRefusedToSend) {
			// The frame breaks the protocol: no retry can send it.
			o.deliveries.Inc(f.Kind, "refused")
			log.Error(f.Kind+".refused", "err", err)
			return err
		}
		var n *hubclient.NackError
		if errors.As(err, &n) {
			o.deliveries.Inc(f.Kind, "nacked")
			log.Warn(f.Kind+".nacked", "attempt", attempt, "code", n.Code, "message", n.Message)
			return err
		}
		if attempt >= o.cfg.Attempts || ctx.Err() != nil {
			o.deliveries.Inc(f.Kind, "gave_up")
			log.Error(f.Kind+".gave_up", "attempts", attempt, "err", err)
			return err
		}
		o.retries.Inc(f.Kind)
		log.Warn(f.Kind+".retry", "attempt", attempt, "err", err, "retryIn", wait)
		select {
		case <-o.cfg.Clock.After(wait):
		case <-ctx.Done():
		}
		if wait *= 2; wait > o.cfg.MaxBackoff {
			wait = o.cfg.MaxBackoff
		}
	}
}
