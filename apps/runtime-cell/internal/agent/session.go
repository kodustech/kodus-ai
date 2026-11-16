package agent

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/hubclient"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/lease"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

type RunConfig struct {
	HubURL         string
	TLS            *tls.Config
	HeartbeatEvery time.Duration
	SweepEvery     time.Duration
	DeadManEvery   time.Duration
	// Backoff between reconnects; doubles up to MaxBackoff.
	Backoff    time.Duration
	MaxBackoff time.Duration
	// AckTimeout is how long a frame waits for its ack (default 5 s).
	AckTimeout time.Duration
	// MissedHeartbeats is how many heartbeats in a row the hub may leave
	// unanswered before the session is taken for dead (default 3).
	MissedHeartbeats int
}

// silence counts the heartbeats the hub left unanswered in a row. A path
// that dies without closing the socket (a tunnel or a load balancer that
// keeps the cell's end open) still takes the cell's frames, so only the
// missing acks tell: after max of them the session ends and the cell dials
// again, instead of holding a dead connection until the dead-man acts.
type silence struct{ missed, max int }

// after takes a heartbeat's result. An ack or a nack is the hub answering;
// anything else is a heartbeat it did not answer. The error ends the session.
func (s *silence) after(err error) error {
	var nack *hubclient.NackError
	if err == nil || errors.As(err, &nack) {
		s.missed = 0
		return nil
	}
	if s.missed++; s.missed < s.max {
		return nil
	}
	return fmt.Errorf("hub silent: %d heartbeats unanswered (last: %w)", s.missed, err)
}

// Run keeps the cell alive until ctx ends: it connects, says hello, sends
// heartbeats, and keeps the sweep and the dead-man going whether or not the
// hub is there.
func (a *Agent) Run(ctx context.Context, rc RunConfig) error {
	if rc.HeartbeatEvery == 0 {
		rc.HeartbeatEvery = 10 * time.Second
	}
	if rc.SweepEvery == 0 {
		rc.SweepEvery = time.Minute
	}
	if rc.DeadManEvery == 0 {
		rc.DeadManEvery = 5 * time.Second
	}
	if rc.Backoff == 0 {
		rc.Backoff = time.Second
	}
	if rc.MaxBackoff == 0 {
		rc.MaxBackoff = 30 * time.Second
	}
	if rc.MissedHeartbeats <= 0 {
		rc.MissedHeartbeats = 3
	}
	a.mu.Lock()
	a.runCtx = ctx
	a.mu.Unlock()
	housekept := make(chan struct{})
	go func() { defer close(housekept); a.housekeeping(ctx, rc) }()
	for i := range a.alertSources {
		a.goTracked(func(ctx context.Context) { a.watchAlerts(ctx, i) })
	}
	if a.sandboxPool != nil {
		a.goTracked(a.sandboxPool.run)
	}
	if a.cfg.DiskWatch != nil {
		a.goTracked(a.watchDisk)
	}
	backoff := rc.Backoff
	for ctx.Err() == nil {
		if a.deadman.Revoked() {
			// A revoked certificate does not get a new connection.
			<-ctx.Done()
			break
		}
		err := a.session(ctx, rc)
		if ctx.Err() != nil {
			break
		}
		a.log.Warn("hub.disconnected", "err", err, "retryIn", backoff)
		select {
		case <-time.After(backoff):
		case <-ctx.Done():
		}
		if backoff *= 2; backoff > rc.MaxBackoff {
			backoff = rc.MaxBackoff
		}
	}
	<-housekept
	a.Wait()
	return nil //nolint:nilerr // Run ends cleanly with its context; each session's error was logged and retried
}

func (a *Agent) session(ctx context.Context, rc RunConfig) error {
	conn, err := hubclient.Dial(ctx, hubclient.Config{URL: rc.HubURL, TLS: rc.TLS, CellID: a.cfg.CellID, AckTimeout: rc.AckTimeout, Log: a.log, Metrics: a.cfg.Metrics})
	if err != nil {
		return err
	}
	defer func() { _ = conn.Close("bye") }()
	sctx, cancel := context.WithCancel(ctx)
	defer cancel()
	served := make(chan error, 1)
	go func() {
		served <- conn.Serve(sctx, func(ctx context.Context, m *protocol.Message) error {
			err := a.Handle(ctx, m)
			if a.deadman.Revoked() {
				// Answer cell.revoked, then end the session for good.
				go cancel()
			}
			return err
		})
	}()
	ack, err := conn.RequestAck(sctx, protocol.Header{ID: a.cfg.NewID()}, a.Hello())
	if err != nil {
		return err
	}
	version, err := chosenVersion(ack)
	if err != nil {
		return err // Run logs it as hub.disconnected
	}
	accepts := protocol.Accepted(ack)
	a.mu.Lock()
	a.conn, a.version, a.accepts = conn, version, accepts
	a.mu.Unlock()
	defer func() {
		a.mu.Lock()
		if a.conn == hubclient.Sender(conn) {
			a.conn, a.version, a.accepts = nil, 0, nil
		}
		a.mu.Unlock()
	}()
	a.deadman.Contact()
	a.log.Info("hub.connected", "version", version, "accepts", len(accepts))
	t := time.NewTicker(rc.HeartbeatEvery)
	defer t.Stop()
	// The first heartbeat right after hello: the hub knows the cell's slots
	// and memory before it places a claim, not a tick later.
	a.nudgeHeartbeat()
	quiet := silence{max: rc.MissedHeartbeats}
	beat := func() error {
		err := conn.Request(sctx, protocol.Header{ID: a.cfg.NewID()}, a.Heartbeat())
		if err == nil {
			a.deadman.Contact()
		}
		return quiet.after(err)
	}
	for {
		select {
		case err := <-served:
			return err
		case <-sctx.Done():
			return errors.New("session ended")
		case <-t.C:
			if err := beat(); err != nil {
				return err
			}
		case <-a.beat:
			if err := beat(); err != nil {
				return err
			}
		}
	}
}

// housekeeping runs the dead-man and the sweep, and tears down the claims
// they leave without machines (ReapDeadClaims), so the slots come back.
func (a *Agent) housekeeping(ctx context.Context, rc RunConfig) {
	sweep := time.NewTicker(rc.SweepEvery)
	dm := time.NewTicker(rc.DeadManEvery)
	defer sweep.Stop()
	defer dm.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-dm.C:
			if a.deadman.Tick(ctx) != lease.Healthy {
				a.ReapDeadClaims(ctx)
			}
		case <-sweep.C:
			if n, err := a.leases.Sweep(ctx); n > 0 || err != nil {
				a.log.Info("sweep", "destroyed", n, "err", err)
			}
			a.ReapDeadClaims(ctx)
			a.pool.RefillAll()
		}
	}
}

// chosenVersion reads the protocol version the hub picked in its hello ack;
// it must be one this cell offered.
func chosenVersion(ack *protocol.AckBody) (int64, error) {
	if ack == nil || ack.Version == nil {
		return 0, errors.New("agent: hub ack of hello carries no protocol version")
	}
	for _, v := range protocol.SupportedVersions() {
		if v == *ack.Version {
			return v, nil
		}
	}
	return 0, fmt.Errorf("agent: hub chose protocol v%d; this cell speaks %v", *ack.Version, protocol.SupportedVersions())
}
