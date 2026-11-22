//go:build unix

package agent

import (
	"errors"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

func isPurged(f any) bool { _, ok := f.(*protocol.OrgPurgedBody); return ok }

// org.purge removes the org's tool layers through the driver's store and the
// cell says so in org.purged, naming what it removed.
func TestOrgPurgeRemovesTheOrgsLayersAndSaysSo(t *testing.T) {
	h, lf := newLayerHarness(t, imageDigest)
	if err := h.handle("", protocol.MessageTypeOrgPurge, &protocol.OrgPurgeBody{OrgID: "org-a"}); err != nil {
		t.Fatal(err)
	}
	done := h.conn.next(t, isPurged).(*protocol.OrgPurgedBody)
	if done.OrgID != "org-a" || len(done.Purged) != 1 || done.Purged[0] != protocol.OrgPurgedBodyPurgedItemToolLayers {
		t.Fatalf("org.purged %+v", done)
	}
	lf.mu.Lock()
	defer lf.mu.Unlock()
	if len(lf.purged) != 1 || lf.purged[0] != "org-a" {
		t.Fatalf("purged %v", lf.purged)
	}
}

// A claim of the org that is live on the cell holds its layers: the cell
// refuses, touching nothing, and the hub asks again once the claim is released.
func TestOrgPurgeIsRefusedWhileAClaimOfTheOrgIsLive(t *testing.T) {
	h, lf := newLayerHarness(t, imageDigest)
	h.sandboxReady("sbx-p1", "org-a")
	if got := nackCode(h.handle("", protocol.MessageTypeOrgPurge, &protocol.OrgPurgeBody{OrgID: "org-a"})); got != "org_busy" {
		t.Fatalf("nack %q, want org_busy", got)
	}
	lf.mu.Lock()
	n := len(lf.purged)
	lf.mu.Unlock()
	if n != 0 {
		t.Fatalf("purged %d times while a claim was live", n)
	}
	// Another org's purge is not held up by it.
	if err := h.handle("", protocol.MessageTypeOrgPurge, &protocol.OrgPurgeBody{OrgID: "org-b"}); err != nil {
		t.Fatal(err)
	}
	h.conn.next(t, isPurged)
}

// A purge that failed sends no org.purged, so the hub keeps the org pending and asks again.
func TestOrgPurgeThatFailsSendsNoAcknowledgement(t *testing.T) {
	h, lf := newLayerHarness(t, imageDigest)
	lf.purgeErr = errors.New("disk")
	if err := h.handle("", protocol.MessageTypeOrgPurge, &protocol.OrgPurgeBody{OrgID: "org-a"}); err != nil {
		t.Fatal(err)
	}
	h.a.Wait()
	h.conn.mu.Lock()
	defer h.conn.mu.Unlock()
	for _, f := range h.conn.frames {
		if isPurged(f) {
			t.Fatal("org.purged sent after a failed purge")
		}
	}
}

// A cell that keeps no layers has nothing at rest: it answers org.purged with an empty list.
func TestOrgPurgeOnACellWithoutLayersFindsNothing(t *testing.T) {
	h, _ := newSandboxHarness(t, 0)
	if err := h.handle("", protocol.MessageTypeOrgPurge, &protocol.OrgPurgeBody{OrgID: "org-a"}); err != nil {
		t.Fatal(err)
	}
	if done := h.conn.next(t, isPurged).(*protocol.OrgPurgedBody); len(done.Purged) != 0 {
		t.Fatalf("purged %v", done.Purged)
	}
}
