package agent

import (
	"context"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/claims"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/outbox"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// orgPurge answers org.purge: the data this cell keeps at rest for one org
// goes (docs/runtime/persistent-state.md D13). The request is acked at once,
// since a large tree takes longer than the hub's ack wait; the removal runs in
// the background and org.purged says it is done, delivered until the hub acks
// it. It refuses while a claim of the org is live on this cell: a mounted
// layer is held by the sandbox that uses it, and the hub asks again once its
// claims are released. Running it again finds nothing and answers the same.
//
// This is the one place a new kind of at-rest data joins the purge: the tool
// layers today; the preview's kept state (feature A) calls its own store here
// and adds its kind to purged.
func (a *Agent) orgPurge(b protocol.OrgPurgeBody) error {
	for _, c := range a.claims.All() {
		if c.Acquire.OrgID == b.OrgID && c.State() != claims.Released {
			return nack("org_busy", "a claim of this organization is live on this cell")
		}
	}
	log := a.log.With("org", b.OrgID)
	a.goTracked(func(ctx context.Context) {
		purged := []protocol.OrgPurgedBodyPurgedItem{}
		if tl := a.cfg.Parts.ToolLayers; tl != nil {
			if err := tl.PurgeOrg(b.OrgID); err != nil {
				// No org.purged: the hub keeps the org pending and sends org.purge again.
				log.Error("org.purge.failed", "kind", "toolLayers", "err", err)
				return
			}
			purged = append(purged, protocol.OrgPurgedBodyPurgedItemToolLayers)
		}
		log.Info("org.purge", "kinds", len(purged))
		_ = a.outbox.Deliver(ctx, outbox.Frame{Kind: "org.purged", Body: &protocol.OrgPurgedBody{OrgID: b.OrgID, Purged: purged}, Log: log})
	})
	return nil
}
