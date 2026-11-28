package injector

import (
	"bytes"
	"context"
	"encoding/base64"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
)

// storingUpstream keeps what a request wrote in X-Amz-Meta-Note (a header
// an object store keeps on the object) and hands it back to any later read,
// in that header and in the body, plain and base64.
func storingUpstream() http.HandlerFunc {
	var mu sync.Mutex
	var stored string
	return func(w http.ResponseWriter, req *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		if v := req.Header.Get("X-Amz-Meta-Note"); v != "" {
			stored = v
			return
		}
		w.Header().Set("X-Amz-Meta-Note", stored)
		_, _ = io.WriteString(w, `{"note":"`+stored+`","b64":"`+base64.StdEncoding.EncodeToString([]byte(stored))+`"}`)
	}
}

// Finding 6 of the 2026-11-14 review: request A sends the placeholder in a
// header the host stores; request B, with no placeholder, reads the stored
// value back. The value of every secret the host may receive is masked on
// every response from it, not only the ones this request used.
func TestStoredSecretReadBackWithoutAPlaceholderIsMasked(t *testing.T) {
	r := newSecretRig(t, fullStore(), storingUpstream())
	if status, body := r.do(t, http.MethodPut, "https://"+npmHost+"/obj", http.Header{"X-Amz-Meta-Note": {r.npm.Placeholder}}); status != http.StatusOK {
		t.Fatalf("store: %d %q", status, body)
	}
	if got := r.upstreamSaw(t).Header.Get("X-Amz-Meta-Note"); got != npmValue {
		t.Fatal("the upstream did not store the value in place of the placeholder")
	}

	// A HEAD reads the stored header alone (S3's x-amz-meta-* on HEAD).
	resp, err := r.vm.Head("https://" + npmHost + "/obj")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	r.upstreamSaw(t)
	if got := resp.Header.Get("X-Amz-Meta-Note"); got != Masked {
		t.Fatalf("HEAD: the stored header reached the VM as %d bytes, want the mask", len(got))
	}

	resp, err = r.vm.Get("https://" + npmHost + "/obj")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	r.upstreamSaw(t)
	var head bytes.Buffer
	_ = resp.Header.Write(&head)
	for _, form := range []string{npmValue, base64.StdEncoding.EncodeToString([]byte(npmValue))} {
		if bytes.Contains(body, []byte(form)) || bytes.Contains(head.Bytes(), []byte(form)) {
			t.Fatalf("the stored value reached the VM (%d bytes form): body %q", len(form), body)
		}
	}
	if resp.Header.Get("X-Amz-Meta-Note") != Masked || strings.Count(string(body), Masked) != 2 {
		t.Fatalf("not masked: header %q body %q", resp.Header.Get("X-Amz-Meta-Note"), body)
	}
}

// unreadableSecret is the store with one secret it cannot read right now.
type unreadableSecret struct {
	*memorySecrets
	id  string
	err error
}

func (s unreadableSecret) Secret(ctx context.Context, org, id string) (StoredSecret, error) {
	if id == s.id {
		return StoredSecret{}, s.err
	}
	return s.memorySecrets.Secret(ctx, org, id)
}

// A secret of the host the store cannot read now (unavailable, timeout)
// cannot be masked: the request is refused before it goes out, even when it
// does not use that secret.
func TestHostSecretTheStoreCannotReadRefusesThePlaceholderFreeRequest(t *testing.T) {
	r := newSecretRig(t, unreadableSecret{memorySecrets: fullStore(), id: "npm", err: ErrVaultUnavailable})
	if status, body := r.do(t, http.MethodGet, "https://"+npmHost+"/obj", http.Header{}); status != http.StatusBadGateway {
		t.Fatalf("status %d %q, want 502", status, body)
	}
	r.upstreamSawNothing(t)
}

// A secret the store no longer has for this org (the admin deleted it) has
// no value to mask with: a request that does not use it still goes out.
func TestDeletedHostSecretDoesNotBlockThePlaceholderFreeRequest(t *testing.T) {
	store := fullStore()
	store.Delete("org-a", "npm")
	r := newSecretRig(t, store)
	if status, body := r.do(t, http.MethodGet, "https://"+npmHost+"/obj", http.Header{}); status != http.StatusOK {
		t.Fatalf("status %d %q", status, body)
	}
	r.upstreamSaw(t)
}

// A request that writes the real value of a host's secret (one the machine
// should never know), even without using its placeholder, is refused.
func TestRealValueOfAnUnusedHostSecretIsRefused(t *testing.T) {
	r := newSecretRig(t, fullStore())
	if status, _ := r.do(t, http.MethodGet, "https://"+npmHost+"/obj", http.Header{"X-Note": {npmValue}}); status != http.StatusForbidden {
		t.Fatalf("status %d", status)
	}
	r.upstreamSawNothing(t)
}
