package injector

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/eventlog"
)

func TestAlertClientReadsTheControlFeed(t *testing.T) {
	log := eventlog.New[Alert](10)
	log.Add(func(seq int64) Alert {
		return Alert{Seq: seq, ClaimID: "claim-1", Host: "evil.example", Kind: AlertCredentialExfiltration}
	})
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/alerts", log.Handler())
	srv := httptest.NewServer(mux)
	defer srv.Close()
	c := AlertClient{URL: srv.URL, Wait: 10 * time.Millisecond}
	got, err := c.After(context.Background(), 0)
	if err != nil || len(got) != 1 || got[0].ClaimID != "claim-1" || got[0].Seq != 1 {
		t.Fatalf("%+v %v", got, err)
	}
	if got, err := c.After(context.Background(), 1); err != nil || len(got) != 0 {
		t.Fatalf("after the last: %+v %v", got, err)
	}
}
