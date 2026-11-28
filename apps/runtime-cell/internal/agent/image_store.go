package agent

import (
	"context"
	"sync"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/claims"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/outbox"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// The shared image store, cell side (docs/runtime/shared-image-store.md): the claim's credential from
// claim.acquire, renewed by claim.renew, held in memory only; the PR side's push reported as image.pushed;
// the digests a suite shard pulls instead of building. Every failure leaves the claim building as before.

// storePushWait bounds how long a release waits for a PR image push that is still running: the push reads
// the claim's built images, which the release removes.
const storePushWait = 3 * time.Minute

// claimStore is one claim's store state: its credential, and whether its PR push has reported.
type claimStore struct {
	creds *driver.StoreCreds
	// pushed is closed when the claim's push has said what it came to (or will never run); nil for a claim with no push right.
	pushed chan struct{}
	once   sync.Once
}

func (s *claimStore) finish() {
	if s.pushed != nil {
		s.once.Do(func() { close(s.pushed) })
	}
}

// grantOf is the wire grant as the driver holds it.
func grantOf(g protocol.ClaimAcquireBodyImageStoreGrant) (driver.StoreGrant, bool) {
	exp, err := protocol.ParseTime(g.ExpiresAt)
	if err != nil {
		return driver.StoreGrant{}, false
	}
	out := driver.StoreGrant{Endpoint: g.Endpoint, Prefix: g.Prefix, Token: g.Token, ExpiresAt: exp}
	for _, r := range g.Repos {
		out.Repos = append(out.Repos, driver.StoreRepo{Scope: string(r.Scope), Name: r.Name, Pull: r.Pull, Push: r.Push})
	}
	return out, true
}

// storeOf is the claim's store state, made from its acquire on first use; nil for a claim with no grant, or
// on a cell whose driver keeps no store.
func (a *Agent) storeOf(c *claims.Claim) *claimStore {
	if v, ok := a.stores.Load(c.ID); ok {
		return v.(*claimStore)
	}
	if c.Acquire.ImageStore == nil || !a.cfg.Driver.Capabilities().ImageStore {
		return nil
	}
	g, ok := grantOf(c.Acquire.ImageStore.Grant)
	if !ok {
		return nil
	}
	st := &claimStore{creds: driver.NewStoreCreds(g)}
	// Only a claim with a push right waits for its push, and only a hub that takes image.pushed hears it.
	if r, ok := g.Repo("pr"); ok && r.Push && a.hubAccepts(protocol.FeatureImageStore) {
		st.pushed = make(chan struct{})
	}
	actual, _ := a.stores.LoadOrStore(c.ID, st)
	return actual.(*claimStore)
}

// prImagesOf is the digests of the PR image the claim pulls instead of building.
func prImagesOf(acq protocol.ClaimAcquireBody) []driver.SharedImage {
	if acq.ImageStore == nil || len(acq.ImageStore.PrImages) == 0 {
		return nil
	}
	out := make([]driver.SharedImage, 0, len(acq.ImageStore.PrImages))
	for _, s := range acq.ImageStore.PrImages {
		out = append(out, driver.SharedImage{Fingerprint: s.Fingerprint, Digest: s.Digest})
	}
	return out
}

// storeFields adds the claim's store to its Up request.
func (a *Agent) storeFields(c *claims.Claim, req driver.UpRequest) driver.UpRequest {
	st := a.storeOf(c)
	if st == nil {
		return req
	}
	req.ImageStore = st.creds
	req.PRImages = prImagesOf(c.Acquire)
	if st.pushed != nil {
		req.PRPushed = func(p driver.PRPush) { a.tellPRPushed(c, st, p) }
	}
	return req
}

// tellPRPushed reports what the PR side's push came to (image.pushed), delivered until acked like a claim's frames.
// The hub records a digest only from the claim that was granted the write.
func (a *Agent) tellPRPushed(c *claims.Claim, st *claimStore, p driver.PRPush) {
	defer st.finish()
	body := &protocol.ImagePushedBody{Status: protocol.ServiceHealthFailed, Images: []protocol.ImagePushedBodyImagesItem{}}
	if p.OK {
		body.Status = protocol.ServiceHealthOk
	}
	if p.Reason != "" {
		reason := p.Reason
		body.Reason = &reason
	}
	for _, im := range p.Images {
		body.Images = append(body.Images, protocol.ImagePushedBodyImagesItem{Fingerprint: im.Fingerprint, Digest: im.Digest, Bytes: im.Bytes, PushMs: im.PushMs})
	}
	if len(body.Images) > protocol.MaxSharedImages {
		body.Images = body.Images[:protocol.MaxSharedImages]
	}
	c.Log.Info("image.pushed", "status", string(body.Status), "images", len(body.Images), "reason", p.Reason)
	a.goTracked(func(ctx context.Context) {
		_ = a.outbox.Deliver(ctx, outbox.Frame{ClaimID: c.ID, Kind: "image.pushed", Body: body, Log: c.Log})
	})
}

// renewStore takes the credential a claim.renew carried: a later token and expiry for the same repositories.
func (a *Agent) renewStore(claimID string, g *protocol.ClaimAcquireBodyImageStoreGrant) {
	if g == nil {
		return
	}
	v, ok := a.stores.Load(claimID)
	if !ok {
		return
	}
	if next, ok := grantOf(*g); ok {
		v.(*claimStore).creds.Renew(next)
	}
}

// endStore waits (bounded) for the claim's PR push to report, then forgets the credential. Called before the
// claim's images are removed.
func (a *Agent) endStore(ctx context.Context, c *claims.Claim) {
	v, ok := a.stores.Load(c.ID)
	if !ok {
		return
	}
	st := v.(*claimStore)
	if st.pushed != nil {
		wait := a.cfg.StorePushWait
		if wait == 0 {
			wait = storePushWait
		}
		// A real timer: this is network work, not the claim's lease.
		timer := time.NewTimer(wait)
		defer timer.Stop()
		select {
		case <-st.pushed:
		case <-timer.C:
			c.Log.Warn("claim.release.pr_push_still_running", "waitedMs", wait.Milliseconds())
		case <-ctx.Done():
		}
	}
	a.stores.Delete(c.ID)
}
