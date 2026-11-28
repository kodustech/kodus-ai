package agent

import (
	"context"
	"errors"
	"net/http"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/claims"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/hubclient"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/observer"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/preview"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/redact"
)

// Previews is the cell's preview tunnel and its routes
// (docs/runtime/preview-urls.md §4.2): preview.Service in production.
type Previews interface {
	Tunnel(ctx context.Context, url, ticket string) error
	Route(r preview.Route) error
	Unroute(previewID, claimID string) bool
	ReleaseClaim(claimID string) int
}

// PreviewUpstreamFactory returns the handler a claim's preview streams go
// to: its observer's /v1/preview proxy (configured for the claim if it was
// not yet).
type PreviewUpstreamFactory func(ctx context.Context, c ClaimInfo, targets []observer.Target) (http.Handler, error)

// PreviewCapability is the optional preview feature: both parts or none.
type PreviewCapability struct {
	Service   Previews
	Upstreams PreviewUpstreamFactory
}

// previewTunnel is preview.tunnel: dial the edge in the background. The
// ack only means the cell will try; the worker sends another frame when the
// edge still has no tunnel of this cell.
func (a *Agent) previewTunnel(b *protocol.PreviewTunnelBody) error {
	if a.cfg.Preview == nil {
		return nack("not_supported", "this cell serves no previews")
	}
	expires, err := protocol.ParseTime(b.ExpiresAt)
	if err != nil {
		return nack("invalid_body", "expiresAt")
	}
	if !a.clock.Now().Before(expires) {
		return nack("ticket_expired", "the tunnel ticket has expired")
	}
	url, ticket := b.URL, b.Ticket
	a.goTracked(func(ctx context.Context) {
		if err := a.cfg.Preview.Service.Tunnel(ctx, url, ticket); err != nil {
			a.log.Warn("preview.tunnel.failed", "err", err)
		}
	})
	return nil
}

// previewRoute is preview.route: only a ready claim of consumer preview
// serves a preview, never a Run's machines, and only to one of its http
// expose entries. The upstream may configure the observer: the answer waits
// for it.
func (a *Agent) previewRoute(claimID string, b *protocol.PreviewRouteBody) error {
	if a.cfg.Preview == nil {
		return nack("not_supported", "this cell serves no previews")
	}
	c, ok := a.claims.Get(claimID)
	if !ok || c.State() == claims.Released {
		return nack("unknown_claim", "%s", claimID)
	}
	if c.Acquire.Consumer != protocol.ConsumerPreview {
		return nack("not_preview_claim", "only a preview claim serves a preview")
	}
	if c.State() != claims.Ready {
		return nack("claim_not_ready", "%s", claimID)
	}
	if !previewTargetExposed(c.Acquire.Expose, b.Target) {
		return nack("invalid_body", "target is not an http expose entry of the claim")
	}
	until, err := protocol.ParseTime(b.Until)
	if err != nil {
		return nack("invalid_body", "until")
	}
	if !a.clock.Now().Before(until) {
		return nack("invalid_body", "until is past")
	}
	previewID, target := b.PreviewID, preview.Target{Service: b.Target.Service, Port: int(b.Target.Port)}
	return hubclient.Later(func(ctx context.Context) error {
		upstream, err := a.cfg.Preview.Upstreams(ctx, info(c), observerTargets(c))
		if err != nil {
			msg, _ := redact.Clip(err.Error(), 256)
			c.Log.Warn("preview.route.failed", "previewId", previewID, "err", msg)
			return nack("observer_unavailable", "the claim's observer did not answer")
		}
		err = a.cfg.Preview.Service.Route(preview.Route{PreviewID: previewID, ClaimID: c.ID, Target: target, Until: until, Upstream: upstream})
		if errors.Is(err, preview.ErrOtherClaim) {
			return nack("invalid_body", "the preview id is routed to another claim")
		}
		if err != nil {
			return nack("invalid_body", "route")
		}
		// A release that ran while the observer was configured leaves no route.
		if c.State() == claims.Released {
			a.cfg.Preview.Service.ReleaseClaim(c.ID)
			return nack("unknown_claim", "%s", claimID)
		}
		c.Log.Info("preview.route", "previewId", previewID, "until", protocol.FormatTime(until))
		return nil
	})
}

// previewUnroute is preview.unroute: idempotent, so a late one is acked.
func (a *Agent) previewUnroute(claimID string, b *protocol.PreviewUnrouteBody) error {
	if a.cfg.Preview == nil {
		return nack("not_supported", "this cell serves no previews")
	}
	if a.cfg.Preview.Service.Unroute(b.PreviewID, claimID) {
		a.log.Info("preview.unroute", "claim", claimID, "previewId", b.PreviewID)
	}
	return nil
}

// previewTargetExposed reports whether target is one of the claim's http
// expose entries.
func previewTargetExposed(expose []protocol.Expose, target protocol.ProbeTarget) bool {
	for _, e := range expose {
		if e.Kind == protocol.ExposeKindHTTP && e.Service == target.Service && e.Port == target.Port {
			return true
		}
	}
	return false
}
