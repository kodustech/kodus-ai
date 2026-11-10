package control

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// A probe round's outbound evidence: the claim's calls in the window, let
// through or refused, oldest first; never another claim's, never outside it.
func TestOutboundReaderReadsOneClaimsWindow(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/events":
			_, _ = w.Write([]byte(`[
{"claimId":"c1","host":"api.stripe.com","port":443,"reason":"not_allowed","at":"2026-11-06T12:00:00.020Z"},
{"claimId":"c1","host":"early.example","port":443,"reason":"not_allowed","at":"2026-11-06T11:59:59Z"},
{"claimId":"c2","host":"other.example","port":443,"reason":"not_allowed","at":"2026-11-06T12:00:00.010Z"}]`))
		case "/v1/connections":
			_, _ = w.Write([]byte(`[
{"claimId":"c1","host":"registry.npmjs.org","port":443,"reason":"allowed","at":"2026-11-06T12:00:00.005Z"},
{"claimId":"c1","host":"late.example","port":443,"reason":"allowed","at":"2026-11-06T12:00:02Z"}]`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	t0 := time.Date(2026, 11, 6, 12, 0, 0, 0, time.UTC)
	r := OutboundReader{Endpoints: []Endpoint{{Name: EndpointEgress, URL: srv.URL}}, HTTP: srv.Client()}
	got, err := r.Outbound(context.Background(), "c1", t0, t0.Add(time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].Host != "registry.npmjs.org" || !got[0].Allowed || got[1].Host != "api.stripe.com" || got[1].Allowed {
		t.Fatalf("%+v", got)
	}
}

// A proxy older than the connections log still gives its refusals.
func TestOutboundReaderWithoutConnectionsLog(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/events" {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(`[{"claimId":"c1","host":"api.stripe.com","port":443,"reason":"not_allowed","at":"2026-11-06T12:00:00.020Z"}]`))
	}))
	defer srv.Close()
	t0 := time.Date(2026, 11, 6, 12, 0, 0, 0, time.UTC)
	got, err := OutboundReader{Endpoints: []Endpoint{{Name: EndpointEgress, URL: srv.URL}}, HTTP: srv.Client()}.Outbound(context.Background(), "c1", t0, t0.Add(time.Second))
	if err == nil || len(got) != 1 || got[0].Allowed {
		t.Fatalf("%+v %v", got, err)
	}
}
