package agent

import (
	"context"
	"net/http"
	"net/http/httptest"
	"slices"
	"sync/atomic"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/observer"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/preview"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

const previewID = "prv_aaaaaaaaaaaaaaaaaaaaaaaaaa"

type previewHarness struct {
	*harness
	svc       *preview.Service
	upstreams atomic.Int32
	upstream  http.Handler
}

func newPreviewHarness(t *testing.T) *previewHarness {
	t.Helper()
	p := &previewHarness{upstream: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("app")) })}
	p.harness = newHarness(t, func(c *Config) {
		p.svc = preview.New(preview.Config{Clock: c.Clock, Log: c.Log})
		c.Preview = &PreviewCapability{Service: p.svc, Upstreams: func(context.Context, ClaimInfo, []observer.Target) (http.Handler, error) {
			p.upstreams.Add(1)
			return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { p.upstream.ServeHTTP(w, r) }), nil
		}}
	})
	t.Cleanup(p.svc.Close)
	return p
}

func previewClaim(b *protocol.ClaimAcquireBody) {
	b.Consumer = protocol.ConsumerPreview
	b.Side = protocol.SidePr
	b.Expose = []protocol.Expose{{Service: "web", Port: 3000, Kind: protocol.ExposeKindHTTP}, {Service: "db", Port: 5432, Kind: protocol.ExposeKindPostgres}}
}

func (p *previewHarness) route(claimID string, service string, port int64) error {
	return p.handle(claimID, protocol.MessageTypePreviewRoute, &protocol.PreviewRouteBody{
		PreviewID: previewID, Target: protocol.ProbeTarget{Service: service, Port: port}, Until: protocol.FormatTime(p.clk.Now().Add(15 * time.Minute)),
	})
}

func TestHelloNamesPreviewOnlyWhenTheCellServesPreviews(t *testing.T) {
	if slices.Contains(newHarness(t).a.Hello().Features, protocol.FeaturePreview) {
		t.Fatal("a cell without a preview tunnel names the preview feature")
	}
	if !slices.Contains(newPreviewHarness(t).a.Hello().Features, protocol.FeaturePreview) {
		t.Fatal("a cell with a preview tunnel does not name the preview feature")
	}
}

func TestAPreviewRouteOnAClaimThatIsNotAPreviewIsNacked(t *testing.T) {
	p := newPreviewHarness(t)
	p.ready("claim-run", func(b *protocol.ClaimAcquireBody) {
		previewClaim(b)
		b.Consumer = protocol.ConsumerRuntime
	})
	if code := nackCode(p.route("claim-run", "web", 3000)); code != "not_preview_claim" {
		t.Fatalf("preview.route on a Run's claim: %q, want not_preview_claim", code)
	}
	if p.svc.Routes() != 0 || p.upstreams.Load() != 0 {
		t.Fatal("a Run's claim got a preview route")
	}
}

func TestAPreviewRouteOutsideTheClaimsHTTPExposeIsNacked(t *testing.T) {
	p := newPreviewHarness(t)
	p.ready("claim-p", previewClaim)
	for _, target := range []struct {
		service string
		port    int64
	}{{"db", 5432}, {"web", 3001}, {"admin", 3000}} {
		if code := nackCode(p.route("claim-p", target.service, target.port)); code != "invalid_body" {
			t.Fatalf("%s:%d: %q, want invalid_body", target.service, target.port, code)
		}
	}
	if code := nackCode(p.route("claim-unknown", "web", 3000)); code != "unknown_claim" {
		t.Fatalf("an unknown claim: %q", code)
	}
	if p.svc.Routes() != 0 {
		t.Fatal("a refused route was kept")
	}
}

func TestAPreviewClaimIsRoutedUntilItIsReleased(t *testing.T) {
	p := newPreviewHarness(t)
	p.ready("claim-p", previewClaim)
	if err := p.route("claim-p", "web", 3000); err != nil {
		t.Fatalf("preview.route: %v", err)
	}
	// The hub renews the route with the lease: one route still.
	if err := p.route("claim-p", "web", 3000); err != nil || p.svc.Routes() != 1 {
		t.Fatalf("renewed route: %v, %d routes", err, p.svc.Routes())
	}
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set(preview.HeaderPreviewID, previewID)
	rec := httptest.NewRecorder()
	p.svc.Handler().ServeHTTP(rec, req)
	if rec.Body.String() != "app" {
		t.Fatalf("a routed stream: %d %s", rec.Code, rec.Body.String())
	}
	if err := p.handle("claim-p", protocol.MessageTypeClaimRelease, &protocol.ClaimReleaseBody{}); err != nil {
		t.Fatal(err)
	}
	p.a.Wait()
	if p.svc.Routes() != 0 {
		t.Fatal("a released claim left its preview route")
	}
}

func TestPreviewUnrouteIsIdempotent(t *testing.T) {
	p := newPreviewHarness(t)
	p.ready("claim-p", previewClaim)
	if err := p.route("claim-p", "web", 3000); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := p.handle("claim-p", protocol.MessageTypePreviewUnroute, &protocol.PreviewUnrouteBody{PreviewID: previewID}); err != nil {
			t.Fatalf("preview.unroute: %v", err)
		}
	}
	if p.svc.Routes() != 0 {
		t.Fatal("the route survived its unroute")
	}
}

func TestPreviewFramesAreNackedByACellWithoutPreviews(t *testing.T) {
	h := newHarness(t)
	tunnel := &protocol.PreviewTunnelBody{URL: "wss://edge.example/v1/cells/tunnel", Ticket: "t", ExpiresAt: protocol.FormatTime(h.clk.Now().Add(time.Minute))}
	if code := nackCode(h.handle("", protocol.MessageTypePreviewTunnel, tunnel)); code != "not_supported" {
		t.Fatalf("preview.tunnel: %q", code)
	}
	p := newPreviewHarness(t)
	tunnel.ExpiresAt = protocol.FormatTime(p.clk.Now().Add(-time.Second))
	if code := nackCode(p.handle("", protocol.MessageTypePreviewTunnel, tunnel)); code != "ticket_expired" {
		t.Fatalf("an expired ticket: %q", code)
	}
}

func TestASlowPreviewResponseDoesNotDelayAControlAnswer(t *testing.T) {
	p := newPreviewHarness(t)
	release := make(chan struct{})
	started := make(chan struct{})
	p.upstream = http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		close(started)
		<-release
	})
	p.ready("claim-p", previewClaim)
	if err := p.route("claim-p", "web", 3000); err != nil {
		t.Fatal(err)
	}
	go func() {
		req := httptest.NewRequest(http.MethodGet, "/slow", nil)
		req.Header.Set(preview.HeaderPreviewID, previewID)
		p.svc.Handler().ServeHTTP(httptest.NewRecorder(), req)
	}()
	<-started
	start := time.Now()
	if err := p.route("claim-p", "web", 3000); err != nil {
		t.Fatal(err)
	}
	if took := time.Since(start); took > time.Second {
		t.Fatalf("a control frame waited %v behind a preview stream", took)
	}
	close(release)
}

// A preview claim used to take the default 45 min ceiling: the hub's 120 min
// (HARD_EXPIRY_MINUTES.preview) was nacked ceiling_exceeded.
func TestAPreviewClaimTakesItsTwoHourCeilingAndNoMore(t *testing.T) {
	p := newPreviewHarness(t)
	b := p.acquireBody()
	previewClaim(b)
	b.HardExpiresAt = protocol.FormatTime(p.clk.Now().Add(120 * time.Minute))
	if err := p.handle("claim-p", protocol.MessageTypeClaimAcquire, b); err != nil {
		t.Fatalf("a preview claim of 120 min: %v", err)
	}
	b.HardExpiresAt = protocol.FormatTime(p.clk.Now().Add(125 * time.Minute))
	if code := nackCode(p.handle("claim-q", protocol.MessageTypeClaimAcquire, b)); code != "ceiling_exceeded" {
		t.Fatalf("a preview claim past 120 min: %q", code)
	}
}
