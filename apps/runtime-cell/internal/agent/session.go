package agent

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/hubclient"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/hubprotocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/lease"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
	buildversion "github.com/kodustech/kodus-ai/apps/runtime-cell/internal/version"
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
	// RefusedBackoff is the least wait after a hub refused the hello for
	// the cell's protocol version (default 5 min): that refusal holds until
	// an operator upgrades the hub or the cell, so dialing at the reconnect
	// pace only repeats it.
	RefusedBackoff time.Duration
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
	if rc.RefusedBackoff == 0 {
		rc.RefusedBackoff = 5 * time.Minute
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
		reached := a.established.Load()
		err := a.session(ctx, rc)
		if ctx.Err() != nil {
			break
		}
		// A session that reached the hub starts the pace over: the failures
		// before it say nothing about this drop.
		if a.established.Load() != reached {
			backoff = rc.Backoff
		}
		wait := backoff
		var refused *versionRefusedError
		if errors.As(err, &refused) {
			wait = max(backoff, rc.RefusedBackoff)
			a.log.Error("hub.refused_version", "code", refused.Code, "reason", refused.Message,
				"cellProtocol", protocol.ProtocolVersion, "cellVersions", protocol.SupportedVersions(), "cellRelease", buildversion.Version,
				"fix", "a cell is never newer than its hub nor older than the oldest protocol it speaks: upgrade the side the reason names", "retryIn", wait)
		} else {
			a.log.Warn("hub.disconnected", "err", err, "retryIn", backoff)
		}
		select {
		case <-time.After(wait):
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
	trim := a.trimHello.Swap(false)
	hello := a.hello(trim)
	ack, err := conn.RequestAck(sctx, protocol.Header{ID: a.cfg.NewID()}, hello)
	if err != nil {
		if !trim && len(hello.Features) > olderHubFeatureLimit && refusedBody(err) {
			// A hub before the 64 limit: the next hello fits its 32, and
			// the one after that tries the whole list again.
			a.trimHello.Store(true)
			a.log.Warn("hub.hello_features_refused", "features", len(hello.Features), "next", olderHubFeatureLimit)
		}
		return asVersionRefusal(err)
	}
	version, err := chosenVersion(ack)
	if err != nil {
		return err // Run logs it as hub.disconnected
	}
	accepts := protocol.Accepted(ack)
	a.recordHubProtocol(version, ack.CellProtocols)
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
	a.established.Add(1)
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

// recordHubProtocol keeps what the hub's hello ack said for `cell update`
// (Config.HubProtocolState). A failed write is logged, never the session's
// end: the hub accepted the cell, and the update reads an older state or none.
func (a *Agent) recordHubProtocol(version int64, accepts *protocol.AckBodyCellProtocols) {
	if a.cfg.HubProtocolState == "" {
		return
	}
	s := hubprotocol.State{Version: version, At: time.Now().UTC()}
	if accepts != nil {
		s.Accepts = &hubprotocol.Range{Min: accepts.Min, Max: accepts.Max}
	}
	if err := hubprotocol.Save(a.cfg.HubProtocolState, s); err != nil {
		a.log.Warn("hub.protocol_state_failed", "err", err, "path", a.cfg.HubProtocolState)
	}
}

// refusedBody is a hello the hub's schema may have refused: a nack of its
// body, or no answer at all, since a hub nacks a frame it cannot decode
// without `re` (cell-hub.ts onMessage) and the cell drops such a nack. A
// slow hub read this way costs one trimmed session, never the session.
func refusedBody(err error) bool {
	var nack *hubclient.NackError
	if errors.As(err, &nack) {
		return nack.Code == string(protocol.CodeInvalidBody)
	}
	return errors.Is(err, hubclient.ErrAckTimeout)
}

// versionRefusedError is a hello the hub refused for the cell's protocol
// version (the skew policy, libs/runtime/protocol/envelope.ts): the cell is
// newer than the hub, or older than the oldest protocol the hub speaks.
type versionRefusedError struct{ *hubclient.NackError }

func (e *versionRefusedError) Unwrap() error { return e.NackError }

// asVersionRefusal marks a hello nack that refuses the cell's version: the
// codes of the skew policy, and unsupported_version, what a hub before it
// sent a cell older than itself.
func asVersionRefusal(err error) error {
	var nack *hubclient.NackError
	if !errors.As(err, &nack) {
		return err
	}
	switch nack.Code {
	case protocol.HelloRefusedCellTooOld, protocol.HelloRefusedCellTooNew, string(protocol.CodeUnsupportedVersion):
		return &versionRefusedError{nack}
	}
	return err
}
