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
	a.mu.Lock()
	a.runCtx = ctx
	a.mu.Unlock()
	housekept := make(chan struct{})
	go func() { defer close(housekept); a.housekeeping(ctx, rc) }()
	if a.cfg.Alerts != nil {
		a.goTracked(a.watchAlerts)
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
	return nil
}

func (a *Agent) session(ctx context.Context, rc RunConfig) error {
	conn, err := hubclient.Dial(ctx, hubclient.Config{URL: rc.HubURL, TLS: rc.TLS, CellID: a.cfg.CellID, AckTimeout: rc.AckTimeout, Log: a.log, Metrics: a.cfg.Metrics})
	if err != nil {
		return err
	}
	defer conn.Close("bye")
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
		a.log.Error("hub.version", "err", err)
		return err
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
	for {
		select {
		case err := <-served:
			return err
		case <-sctx.Done():
			return errors.New("session ended")
		case <-t.C:
			if err := conn.Request(sctx, protocol.Header{ID: a.cfg.NewID()}, a.Heartbeat()); err == nil {
				a.deadman.Contact()
			}
		case <-a.beat:
			if err := conn.Request(sctx, protocol.Header{ID: a.cfg.NewID()}, a.Heartbeat()); err == nil {
				a.deadman.Contact()
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
