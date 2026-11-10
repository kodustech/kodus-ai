package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy/control"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

func TestPolicyPusherSignsTrustedEnvironmentWithoutInventingCredentialHosts(t *testing.T) {
	pub, key, _ := ed25519.GenerateKey(rand.Reader)
	store := policy.NewStore(nil)
	server := httptest.NewServer((&control.Server{Policies: store, AgentKey: pub}).Handler())
	defer server.Close()
	pusher := policyPusher{client: control.Pusher{Endpoints: []control.Endpoint{{Name: "injector", URL: server.URL}}, HTTP: &http.Client{}, Key: key}}
	claim := agent.ClaimInfo{ClaimID: "claim-a", Acquire: protocol.ClaimAcquireBody{OrgID: "org-a", EnvironmentID: "trusted-env", Side: protocol.SidePr, HardExpiresAt: time.Now().Add(time.Hour).UTC().Format(time.RFC3339)}, Workload: driver.MachineRef{PrivateAddress: "10.0.0.1"}, Observer: driver.MachineRef{PrivateAddress: "10.0.0.2"}, ExtraAllow: []string{"api.example.test"}}
	if err := pusher.Apply(context.Background(), claim); err != nil {
		t.Fatal(err)
	}
	p, ok := store.ForClaim(claim.ClaimID)
	if !ok || p.EnvironmentID != "trusted-env" || p.OrgID != "org-a" {
		t.Fatal("trusted claim environment was not signed")
	}
	if len(p.CredentialHosts) != 0 {
		t.Fatal("approved egress was turned into credential authorization")
	}
}
