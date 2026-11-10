package observerclient

import (
	"context"
	"encoding/json"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/observer"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/observerauth"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync/atomic"
	"testing"
)

// A private config PUT must never replay its credential body at a redirect.
func TestConfigurationNeverFollowsCredentialRedirect(t *testing.T) {
	c, err := observerauth.NewCredential("db", 5432, "fixture")
	if err != nil {
		t.Fatal("fixture credential generation failed")
	}
	cc := observer.ClaimConfig{ClaimID: "claim-a", ImageID: "img-a", Generation: 1, Targets: []observer.Target{{Service: "db", Port: 5432, Kind: "postgres", Address: "127.0.0.1:5432"}}, SQL: []observerauth.Credential{c}}
	fingerprint, err := observer.ConfigFingerprint(cc)
	if err != nil {
		t.Fatal("fixture config invalid")
	}
	var reached atomic.Int32
	spy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reached.Add(1)
		w.Header().Set(observer.ConfigFingerprintHeader, fingerprint)
		w.Header().Set(observer.ConfigGenerationHeader, strconv.FormatUint(cc.Generation, 10))
		w.WriteHeader(204)
	}))
	defer spy.Close()
	control := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var got observer.ClaimConfig
		if json.NewDecoder(r.Body).Decode(&got) != nil {
			t.Error("invalid private request")
		}
		w.Header().Set("Location", spy.URL)
		w.WriteHeader(http.StatusTemporaryRedirect)
	}))
	defer control.Close()
	client, err := Configure(context.Background(), control.Client(), control.URL, cc)
	if err == nil || client != nil || reached.Load() != 0 {
		t.Fatalf("configuration escaped observer boundary (requests=%d)", reached.Load())
	}
}
