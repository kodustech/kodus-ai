package main

import (
	"context"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/eventlog"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/injector"
)

// The adapter used to copy the client on every poll, losing its epoch/cursor.
func TestInjectorAlertsKeepsNegotiatedContinuityAcrossPolls(t *testing.T) {
	log := eventlog.New[injector.Alert](10)
	log.Add(func(seq int64) injector.Alert {
		return injector.Alert{Seq: seq, ClaimID: "claim-a", Kind: "bait_exfiltration"}
	})
	server := httptest.NewServer(log.Handler())
	defer server.Close()
	source := injectorAlerts{c: &injector.AlertClient{URL: server.URL, HTTP: server.Client(), Wait: time.Nanosecond}}
	first, err := source.Alerts(context.Background(), 0)
	if err != nil || len(first) != 1 {
		t.Fatalf("first poll: %v (%d events)", err, len(first))
	}
	log.Add(func(seq int64) injector.Alert {
		return injector.Alert{Seq: seq, ClaimID: "claim-a", Kind: "bait_exfiltration"}
	})
	second, err := source.Alerts(context.Background(), first[0].Seq)
	if err != nil || len(second) != 1 || second[0].Seq != 2 {
		t.Fatalf("second poll lost continuity: %v (%d events)", err, len(second))
	}
}
