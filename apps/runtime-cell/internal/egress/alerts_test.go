package egress_test

import (
	"context"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/egress"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/injector"
)

// The proxy's placeholder leaks reach the cell agent through the same feed
// client as the injector's alerts: the control port serves them in that
// format, with the continuity the client checks.
func TestPlaceholderLeaksAreServedInTheInjectorAlertFormat(t *testing.T) {
	alerts := egress.NewAlerts(10)
	srv := httptest.NewServer((&egress.Control{Alerts: alerts}).Handler())
	t.Cleanup(srv.Close)
	client := &injector.AlertClient{URL: srv.URL, HTTP: srv.Client(), Wait: time.Millisecond}
	if got, err := client.After(context.Background(), 0); err != nil || len(got) != 0 {
		t.Fatalf("empty feed: %v %+v", err, got)
	}
	alerts.PlaceholderLeak("claim-1", "plain.example", time.Now())
	got, err := client.After(context.Background(), 0)
	if err != nil || len(got) != 1 {
		t.Fatalf("feed: %v %+v", err, got)
	}
	if a := got[0]; a.Seq != 1 || a.ClaimID != "claim-1" || a.Host != "plain.example" || a.Kind != egress.ReasonPlaceholderLeak {
		t.Fatalf("alert %+v", a)
	}
}
