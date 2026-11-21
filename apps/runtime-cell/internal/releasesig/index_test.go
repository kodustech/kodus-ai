package releasesig

import (
	"crypto/ed25519"
	"crypto/rand"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

var t0 = time.Date(2026, 11, 16, 12, 0, 0, 0, time.UTC)

func writeIndex(t *testing.T, priv ed25519.PrivateKey, ix Index) string {
	t.Helper()
	dir := t.TempDir()
	if err := signIndexFile(priv, dir, ix); err != nil {
		t.Fatal(err)
	}
	return dir
}

func index(over func(*Index)) Index {
	ix := Index{Issued: t0, Expires: t0.Add(90 * 24 * time.Hour), Latest: "v1.4.0", Minimum: "v1.2.0"}
	if over != nil {
		over(&ix)
	}
	return ix
}

func TestACurrentIndexOfAPinnedKeyVerifies(t *testing.T) {
	priv, keys := testKey(t)
	ix, err := VerifyIndex(writeIndex(t, priv, index(nil)), keys, nil, t0.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if ix.Latest != "v1.4.0" || ix.Minimum != "v1.2.0" || !ix.Issued.Equal(t0) {
		t.Fatalf("index %+v", ix)
	}
}

// Freeze: a mirror that keeps serving an old index stops being believed once it expires.
func TestAnExpiredIndexOrOneIssuedInTheFutureIsRefused(t *testing.T) {
	priv, keys := testKey(t)
	dir := writeIndex(t, priv, index(nil))
	if _, err := VerifyIndex(dir, keys, nil, t0.Add(90*24*time.Hour)); err == nil || !strings.Contains(err.Error(), "expired") {
		t.Errorf("expired: %v", err)
	}
	if _, err := VerifyIndex(dir, keys, nil, t0.Add(-time.Hour)); err == nil || !strings.Contains(err.Error(), "future") {
		t.Errorf("future: %v", err)
	}
}

func TestAnIndexIsRefusedWhenItsKeyIsRevokedUnpinnedOrItsBytesChanged(t *testing.T) {
	priv, keys := testKey(t)
	now := t0.Add(time.Hour)
	dir := writeIndex(t, priv, index(nil))
	// The host already saw this key revoked: a later index signed by it is refused.
	if _, err := VerifyIndex(dir, keys, []string{keys[0].ID}, now); err == nil || !strings.Contains(err.Error(), "revoked") {
		t.Errorf("revoked by the host: %v", err)
	}
	_, other := testKey(t)
	if _, err := VerifyIndex(dir, other, nil, now); err == nil || !strings.Contains(err.Error(), "not pinned") {
		t.Errorf("unpinned: %v", err)
	}
	p := filepath.Join(dir, IndexName)
	b, _ := os.ReadFile(p)
	if err := os.WriteFile(p, []byte(strings.Replace(string(b), "v1.2.0", "v0.1.0", 1)), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := VerifyIndex(dir, keys, nil, now); err == nil || !strings.Contains(err.Error(), "does not verify") {
		t.Errorf("edited minimum: %v", err)
	}
	if _, err := VerifyIndex(t.TempDir(), keys, nil, now); err == nil || !strings.Contains(err.Error(), "signed release index") {
		t.Errorf("no index: %v", err)
	}
}

// A key cannot sign an index that revokes it, and an index cannot claim a validity past the bound.
func TestAnIndexCannotRevokeItsOwnKeyNorHoldPastTheBound(t *testing.T) {
	priv, keys := testKey(t)
	if err := signIndexFile(priv, t.TempDir(), index(func(ix *Index) { ix.RevokedKeys = []string{keys[0].ID} })); err == nil {
		t.Error("signed an index that revokes its own key")
	}
	if err := signIndexFile(priv, t.TempDir(), index(func(ix *Index) { ix.Expires = t0.Add(MaxIndexValidity + time.Hour) })); err == nil {
		t.Error("signed an index past the bound")
	}
}

// A release signature never passes for an index signature, nor the reverse: their prefixes differ.
func TestAReleaseSignatureIsNotAnIndexSignature(t *testing.T) {
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	text, err := MarshalIndex(index(nil))
	if err != nil {
		t.Fatal(err)
	}
	pub := priv.Public().(ed25519.PublicKey)
	if ed25519.Verify(pub, Message("v1.4.0", text), ed25519.Sign(priv, IndexMessage(text))) {
		t.Error("an index signature verified as a release one")
	}
}
