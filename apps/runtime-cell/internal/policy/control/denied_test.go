package control

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

// The bundle's denied egress: what the proxy and the resolver refused this
// claim, one entry per host, never another claim's, never what was allowed.
func TestDeniedReaderReadsBothRefusalsOfOneClaim(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/events":
			_, _ = w.Write([]byte(`[
{"claimId":"c1","host":"api.stripe.com","port":443,"reason":"not_allowed","at":"2026-11-04T10:00:02Z"},
{"claimId":"c2","host":"other.example","port":443,"reason":"not_allowed","at":"2026-11-04T10:00:01Z"},
{"claimId":"c1","host":"10.0.0.9","port":443,"reason":"bad_host","at":"2026-11-04T10:00:03Z"},
{"claimId":"c1","host":"metadata.google.internal","port":80,"reason":"denied","at":"2026-11-04T10:00:03Z"},
{"claimId":"c1","host":"api.stripe.com","port":443,"reason":"not_allowed","at":"2026-11-04T10:00:04Z"}]`))
		case "/v1/queries":
			if r.URL.Query().Get("claim") != "c1" {
				t.Errorf("queries for %q", r.URL.Query().Get("claim"))
			}
			_, _ = w.Write([]byte(`[
{"name":"dl-cdn.alpinelinux.org","rcode":"NXDOMAIN","denied":true,"at":"2026-11-04T10:00:00Z"},
{"name":"registry-1.docker.io","rcode":"NOERROR","at":"2026-11-04T10:00:00Z"},
{"name":"nope.invalid","rcode":"NXDOMAIN","at":"2026-11-04T10:00:00Z"}]`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	r := DeniedReader{Endpoints: []Endpoint{{Name: EndpointEgress, URL: srv.URL}, {Name: EndpointResolver, URL: srv.URL}}, HTTP: srv.Client()}
	got, err := r.Denied(context.Background(), "c1")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 || got[0].Host != "dl-cdn.alpinelinux.org" || got[0].Port != 53 || got[1].Host != "api.stripe.com" || got[1].Port != 443 || got[1].Platform {
		t.Fatalf("%+v", got)
	}
	// The platform deny list's refusal is reported as such: no approval lifts it.
	if got[2].Host != "metadata.google.internal" || !got[2].Platform {
		t.Fatalf("%+v", got[2])
	}
}

// One component down still reports what the other refused.
func TestDeniedReaderKeepsWhatOneEndpointAnswered(t *testing.T) {
	ok := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`[{"name":"dl-cdn.alpinelinux.org","denied":true,"at":"2026-11-04T10:00:00Z"}]`))
	}))
	defer ok.Close()
	down := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusBadGateway) }))
	defer down.Close()
	r := DeniedReader{Endpoints: []Endpoint{{Name: EndpointEgress, URL: down.URL}, {Name: EndpointResolver, URL: ok.URL}}, HTTP: ok.Client()}
	got, err := r.Denied(context.Background(), "c1")
	if err == nil || len(got) != 1 || got[0].Host != "dl-cdn.alpinelinux.org" {
		t.Fatalf("%+v %v", got, err)
	}
}
