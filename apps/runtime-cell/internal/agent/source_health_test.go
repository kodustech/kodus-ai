package agent

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/claims"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/eventlog"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/hubclient"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/kodyexec"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/metrics"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

type sourceFunc func(context.Context, int64) ([]Alert, error)

func (f sourceFunc) Alerts(ctx context.Context, after int64) ([]Alert, error) { return f(ctx, after) }

// A configured alert feed used to advertise capacity and accept claims before
// the first poll established whether the producer could prove continuity.
func TestAlertSourceStartsClosedUntilHandshake(t *testing.T) {
	h := newHarness(t, func(c *Config) {
		c.Alerts = sourceFunc(func(context.Context, int64) ([]Alert, error) { return nil, nil })
	})
	if slots := h.a.Heartbeat().FreeSlots; slots != 0 {
		t.Fatalf("unverified source advertised %d slots", slots)
	}
	if code := nackCode(h.handle("claim-1", protocol.MessageTypeClaimAcquire, h.acquireBody())); code != "not_accepting" {
		t.Fatalf("unverified source accepted claim: %s", code)
	}
}

func TestAlertSourceHealthMetricsAndClosedErrors(t *testing.T) {
	registry := metrics.NewRegistry()
	h := newHarness(t, func(c *Config) {
		c.Metrics = registry
		c.Alerts = sourceFunc(func(context.Context, int64) ([]Alert, error) { return nil, nil })
	})
	var before bytes.Buffer
	if err := registry.WriteText(&before); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(before.String(), "cell_alert_source_available 0\n") {
		t.Fatal("unverified source has no explicit zero health")
	}
	h.a.alertSourceFailed(context.Background(), errors.New("PRIVATE_CONTROL_ERROR"))
	if strings.Contains(h.logs.String(), "PRIVATE_CONTROL_ERROR") {
		t.Fatal("upstream error leaked to source log")
	}
	h.a.alertSourceReady()
	if !h.a.alertSourceAvailable() {
		t.Fatal("continuous source did not recover from transient unavailability")
	}
	stale, ok := h.a.alertAdmissionSnapshot()
	if !ok {
		t.Fatal("healthy snapshot unavailable")
	}
	h.a.alertSourceFailed(context.Background(), &eventlog.FeedError{Reason: eventlog.ReasonRetentionGap})
	h.a.alertSourceReady()
	if h.a.alertSourceAvailable() || h.a.alertAdmissionCurrent(stale) {
		t.Fatal("a lost history reopened or admitted an old generation")
	}
	var after bytes.Buffer
	_ = registry.WriteText(&after)
	if !strings.Contains(after.String(), `cell_alert_source_failures_total{reason="retention_gap"} 1`) || strings.Contains(after.String(), "PRIVATE_CONTROL_ERROR") {
		t.Fatal("source failure metric is absent or unbounded")
	}
}

type checkingSourceSender struct {
	a    *Agent
	t    *testing.T
	next hubclient.Sender
}

func (s checkingSourceSender) Request(ctx context.Context, header protocol.Header, body any) error {
	if _, ok := body.(*protocol.BlockedBody); ok && s.a.alertSourceAvailable() {
		s.t.Error("backlog alert was delivered after reopening admission")
	}
	return s.next.Request(ctx, header, body)
}

func TestAlertBacklogIsAppliedBeforeAdmissionOpens(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	polls := 0
	h := newHarness(t, func(c *Config) {
		c.Alerts = sourceFunc(func(context.Context, int64) ([]Alert, error) {
			polls++
			if polls == 1 {
				return []Alert{{Seq: 1, ClaimID: "claim-1", Kind: "bait_exfiltration", Host: "fixture.invalid"}}, nil
			}
			cancel()
			return nil, ctx.Err()
		})
	})
	c := claims.New("claim-1", *h.acquireBody(), h.a.log, h.clk.Now())
	if err := h.a.claims.Add(c); err != nil {
		t.Fatal(err)
	}
	h.a.conn = checkingSourceSender{h.a, t, h.conn}
	h.a.watchAlerts(ctx)
	if c.Compromised() != "bait_exfiltration" || !h.a.alertSourceAvailable() {
		t.Fatal("backlog proof not applied before healthy admission")
	}
}

func TestAlertSourceLossRacesAcquireWithoutLeavingNewWork(t *testing.T) {
	h := newHarness(t, func(c *Config) {
		c.Alerts = sourceFunc(func(context.Context, int64) ([]Alert, error) { return nil, nil })
	})
	h.a.alertSourceReady()
	start := make(chan struct{})
	var callers sync.WaitGroup
	for i := range 16 {
		callers.Add(1)
		go func() {
			defer callers.Done()
			<-start
			err := h.handle(fmt.Sprintf("claim-%d", i), protocol.MessageTypeClaimAcquire, h.acquireBody())
			if code := nackCode(err); err != nil && code != "not_accepting" {
				t.Errorf("unexpected acquire refusal: %s", code)
			}
		}()
	}
	callers.Add(1)
	go func() {
		defer callers.Done()
		<-start
		h.a.alertSourceFailed(context.Background(), &eventlog.FeedError{Reason: eventlog.ReasonProducerRestart})
	}()
	close(start)
	callers.Wait()
	h.a.Wait()
	if h.a.claims.Len() != 0 || h.a.Heartbeat().FreeSlots != 0 {
		t.Fatal("a racing acquire escaped the lost source")
	}
	machines, err := h.drv.List(context.Background(), nil)
	if err != nil || len(machines) != 0 {
		t.Fatalf("racing acquire left machines: %v %v", machines, err)
	}
}

// A lost feed used to leave claims running. Loss is infrastructure failure,
// not evidence that any claim exfiltrated a credential or destabilized a VM.
func TestAlertHistoryLossCancelsClaimsWithoutSecurityIncident(t *testing.T) {
	for _, reason := range []eventlog.Reason{eventlog.ReasonProducerRestart, eventlog.ReasonRetentionGap} {
		t.Run(string(reason), func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			started := make(chan struct{})
			var h *harness
			polls := 0
			feed := sourceFunc(func(context.Context, int64) ([]Alert, error) {
				polls++
				switch polls {
				case 1:
					return []Alert{}, nil
				case 2:
					h.ready("claim-1")
					if err := h.handle("claim-1", protocol.MessageTypeExec, &protocol.ExecBody{StepID: step1, Command: "id", TimeoutMs: 1000}); err != nil {
						t.Fatal(err)
					}
					<-started
					return nil, &eventlog.FeedError{Reason: reason}
				default:
					cancel()
					return nil, ctx.Err()
				}
			})
			h = newHarness(t, func(c *Config) {
				c.Alerts = feed
				c.Transport = stubTransport{exec: func(ctx context.Context, _ kodyexec.Request) (kodyexec.Result, error) {
					close(started)
					<-ctx.Done()
					return kodyexec.Result{}, ctx.Err()
				}}
			})
			defer func() {
				for _, c := range h.a.claims.All() {
					c.Release()
				}
				h.a.Wait()
			}()
			h.a.watchAlerts(ctx)
			if c, ok := h.a.claims.Get("claim-1"); ok && (c.State() != claims.Released || c.Compromised() != "") {
				t.Fatalf("loss left claim active or invented compromise: %s %s", c.State(), c.Compromised())
			}
			if h.a.Heartbeat().FreeSlots != 0 {
				t.Fatal("lost source advertised capacity")
			}
			if code := nackCode(h.handle("claim-2", protocol.MessageTypeClaimAcquire, h.acquireBody())); code != "not_accepting" {
				t.Fatalf("history loss accepted new claim: %s", code)
			}
			h.a.Wait()
			if h.conn.attempts(isResult(step1)) != 0 {
				t.Fatal("a cancelled step supplied a result")
			}
			if h.conn.attempts(func(f any) bool { _, ok := f.(*protocol.BlockedBody); return ok }) != 0 {
				t.Fatal("history loss fabricated a security blocked frame")
			}
		})
	}
}
