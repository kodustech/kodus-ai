//go:build unix

package agent

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver/fake"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// The shared image store on the cell (docs/runtime/shared-image-store.md): the credential of a claim and what it
// does with it. The store only makes things faster: a cell with no store, or a hub that never heard of it, boots as before.

const storeToken = "bearer-token-one"

func prGrant(token string, push bool, expires time.Time) protocol.ClaimAcquireBodyImageStoreGrant {
	return protocol.ClaimAcquireBodyImageStoreGrant{
		Endpoint: "https://store.example", Prefix: "kodus-ci", Token: token, ExpiresAt: protocol.FormatTime(expires),
		Repos: []protocol.ClaimAcquireBodyImageStoreGrantReposItem{{Scope: protocol.ClaimAcquireBodyImageStoreGrantReposItemScopePr, Name: "kodus-ci/o-a/e-b/pr-c", Pull: true, Push: push}},
	}
}

// storeComposer keeps each Up's request and, when asked, reports a push as the driver does.
type storeComposer struct {
	mu   sync.Mutex
	reqs []driver.UpRequest
	// pushWhen, when set, is closed by the test to let the claim's push report.
	pushWhen chan struct{}
}

func (c *storeComposer) Up(_ context.Context, req driver.UpRequest) ([]string, error) {
	c.mu.Lock()
	c.reqs = append(c.reqs, req)
	when := c.pushWhen
	c.mu.Unlock()
	if req.PRPushed != nil {
		go func() {
			if when != nil {
				<-when
			}
			req.PRPushed(driver.PRPush{OK: true, Images: []driver.PushedImage{{Fingerprint: strings.Repeat("f", 64), Digest: "sha256:" + strings.Repeat("d", 64), Bytes: 10, PushMs: 5}}})
		}()
	}
	return []string{"172.30.0.2"}, nil
}

func (c *storeComposer) last(t *testing.T) driver.UpRequest {
	t.Helper()
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.reqs) == 0 {
		t.Fatal("no Up")
	}
	return c.reqs[len(c.reqs)-1]
}

func storeHarness(t *testing.T, cp *storeComposer, withStore bool, accepts ...string) *harness {
	t.Helper()
	h := newHarness(t, func(c *Config) {
		c.StorePushWait = 5 * time.Second
		c.Parts.Composer = cp
		c.Driver.(*fake.Driver).ImageStore = withStore
	})
	h.a.accepts = protocol.Accepted(&protocol.AckBody{Accepts: accepts})
	return h
}

func acquireWithStore(t *testing.T, h *harness, claim string, store *protocol.ClaimAcquireBodyImageStore) {
	t.Helper()
	b := h.acquireBody()
	b.ImageStore = store
	b.Expose = []protocol.Expose{{Service: "api", Port: 3000, Kind: protocol.ExposeKindHTTP}}
	if err := h.handle(claim, protocol.MessageTypeClaimAcquire, b); err != nil {
		t.Fatal(err)
	}
	h.conn.next(t, isReady)
}

func isImagePushed(f any) bool { _, ok := f.(*protocol.ImagePushedBody); return ok }

// A shard's claim.acquire hands the driver the claim's credential and the digests of the PR image it pulls instead of building.
func TestAClaimsStoreGrantAndPRImagesReachItsBoot(t *testing.T) {
	cp := &storeComposer{}
	h := storeHarness(t, cp, true, protocol.FeatureImageStore)
	digests := []protocol.ClaimAcquireBodySharedImagesItem{{Fingerprint: strings.Repeat("a", 64), Digest: "sha256:" + strings.Repeat("b", 64)}}
	acquireWithStore(t, h, "claim-1", &protocol.ClaimAcquireBodyImageStore{Grant: prGrant(storeToken, false, h.clk.Now().Add(10*time.Minute)), PrImages: digests})
	req := cp.last(t)
	if req.ImageStore == nil || req.ImageStore.Token() != storeToken || len(req.PRImages) != 1 || req.PRImages[0].Fingerprint != digests[0].Fingerprint {
		t.Fatalf("up got store %v, images %+v", req.ImageStore, req.PRImages)
	}
	if req.PRPushed != nil {
		t.Fatal("a claim with no push right was given a push")
	}
}

// A claim with no grant, and a cell whose driver keeps no store, boot as they always did.
func TestAClaimWithNoGrantOrOnACellWithNoStoreBootsAsBefore(t *testing.T) {
	for name, c := range map[string]struct {
		withStore bool
		store     func(h *harness) *protocol.ClaimAcquireBodyImageStore
	}{
		"no grant": {true, func(*harness) *protocol.ClaimAcquireBodyImageStore { return nil }},
		"driver no store": {false, func(h *harness) *protocol.ClaimAcquireBodyImageStore {
			return &protocol.ClaimAcquireBodyImageStore{Grant: prGrant(storeToken, true, h.clk.Now().Add(time.Minute))}
		}},
	} {
		t.Run(name, func(t *testing.T) {
			cp := &storeComposer{}
			h := storeHarness(t, cp, c.withStore, protocol.FeatureImageStore)
			acquireWithStore(t, h, "claim-1", c.store(h))
			if req := cp.last(t); req.ImageStore != nil || req.PRImages != nil || req.PRPushed != nil {
				t.Fatalf("up got a store: %+v", req)
			}
		})
	}
}

// The PR side's push reaches a hub that accepts imageStore as image.pushed, on its own claim, with the digests.
func TestThePRSidesPushReachesTheHubAsImagePushed(t *testing.T) {
	cp := &storeComposer{pushWhen: make(chan struct{})}
	h := storeHarness(t, cp, true, protocol.FeatureImageStore)
	acquireWithStore(t, h, "claim-1", &protocol.ClaimAcquireBodyImageStore{Grant: prGrant(storeToken, true, h.clk.Now().Add(10*time.Minute))})
	close(cp.pushWhen) // after claim.ready, which the helper consumed
	got := h.conn.next(t, isImagePushed).(*protocol.ImagePushedBody)
	if got.Status != protocol.ServiceHealthOk || len(got.Images) != 1 || got.Images[0].Digest != "sha256:"+strings.Repeat("d", 64) || got.Images[0].PushMs != 5 {
		t.Fatalf("image.pushed %+v", got)
	}
}

// A hub older than imageStore never gets image.pushed, which its strict decoder would refuse.
func TestAnOlderHubNeverHearsImagePushed(t *testing.T) {
	cp := &storeComposer{}
	h := storeHarness(t, cp, true)
	acquireWithStore(t, h, "claim-1", &protocol.ClaimAcquireBodyImageStore{Grant: prGrant(storeToken, true, h.clk.Now().Add(10*time.Minute))})
	h.a.Wait()
	if n := h.conn.attempts(isImagePushed); n != 0 {
		t.Fatalf("%d image.pushed sent to an older hub", n)
	}
}

// claim.renew moves the claim's token and expiry and never what it may reach.
func TestARenewedGrantMovesTheTokenAndNeverTheRepositories(t *testing.T) {
	cp := &storeComposer{}
	h := storeHarness(t, cp, true, protocol.FeatureImageStore)
	acquireWithStore(t, h, "claim-1", &protocol.ClaimAcquireBodyImageStore{Grant: prGrant(storeToken, false, h.clk.Now().Add(10*time.Minute))})
	widened := prGrant("bearer-token-two", true, h.clk.Now().Add(20*time.Minute))
	widened.Repos = append(widened.Repos, protocol.ClaimAcquireBodyImageStoreGrantReposItem{Scope: protocol.ClaimAcquireBodyImageStoreGrantReposItemScopeMain, Name: "kodus-ci/o-a/e-b/main", Pull: true, Push: true})
	body := &protocol.ClaimRenewBody{LeaseExpiresAt: protocol.FormatTime(h.clk.Now().Add(30 * time.Minute)), ImageStoreGrant: &widened}
	if err := h.handle("claim-1", protocol.MessageTypeClaimRenew, body); err != nil {
		t.Fatal(err)
	}
	g := cp.last(t).ImageStore.Current()
	if g.Token != "bearer-token-two" || len(g.Repos) != 1 || g.Repos[0].Push {
		t.Fatalf("grant after renewal: %d repos, push %v, token moved %v", len(g.Repos), g.Repos[0].Push, g.Token == "bearer-token-two")
	}
	// An older token never replaces a newer one.
	stale := prGrant("bearer-token-old", false, h.clk.Now().Add(time.Minute))
	_ = h.handle("claim-1", protocol.MessageTypeClaimRenew, &protocol.ClaimRenewBody{LeaseExpiresAt: body.LeaseExpiresAt, ImageStoreGrant: &stale})
	if cp.last(t).ImageStore.Token() != "bearer-token-two" {
		t.Fatal("a stale token replaced the newer one")
	}
}

// A release waits for the push that reads the claim's images, then tears the claim down.
func TestAReleaseWaitsForThePRPushThenCleansUp(t *testing.T) {
	cp := &storeComposer{pushWhen: make(chan struct{})}
	h := storeHarness(t, cp, true, protocol.FeatureImageStore)
	acquireWithStore(t, h, "claim-1", &protocol.ClaimAcquireBodyImageStore{Grant: prGrant(storeToken, true, h.clk.Now().Add(10*time.Minute))})
	done := make(chan error, 1)
	go func() { done <- h.handle("claim-1", protocol.MessageTypeClaimRelease, &protocol.ClaimReleaseBody{}) }()
	<-done
	time.Sleep(100 * time.Millisecond)
	// The push has not reported: the claim is not cleaned yet.
	if strings.Contains(h.logs.String(), "claim.cleaned") {
		t.Fatal("the claim was cleaned while its push was running:\n" + h.logs.String())
	}
	close(cp.pushWhen)
	deadline := time.Now().Add(5 * time.Second)
	for !strings.Contains(h.logs.String(), "claim.cleaned") {
		if time.Now().After(deadline) {
			t.Fatal("the claim was never cleaned after its push reported")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// A push that never reports does not hold a release for ever: past its bound the claim is cleaned up anyway.
func TestAReleaseDoesNotWaitPastTheBoundForAPushThatNeverReports(t *testing.T) {
	cp := &storeComposer{pushWhen: make(chan struct{})}
	h := storeHarness(t, cp, true, protocol.FeatureImageStore)
	h.a.cfg.StorePushWait = 50 * time.Millisecond
	acquireWithStore(t, h, "claim-1", &protocol.ClaimAcquireBodyImageStore{Grant: prGrant(storeToken, true, h.clk.Now().Add(10*time.Minute))})
	if err := h.handle("claim-1", protocol.MessageTypeClaimRelease, &protocol.ClaimReleaseBody{}); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for !strings.Contains(h.logs.String(), "claim.cleaned") {
		if time.Now().After(deadline) {
			t.Fatal("the claim was never cleaned")
		}
		time.Sleep(5 * time.Millisecond)
	}
	close(cp.pushWhen)
}
