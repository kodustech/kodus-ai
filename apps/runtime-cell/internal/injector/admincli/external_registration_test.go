package admincli

import (
	"bytes"
	"context"
	"testing"
)

// The CLI did not expose the external ledger's metadata-only registration.
func TestOwnerCLIRegisterExternalUsesExplicitOperationAndNoOutput(t *testing.T) {
	input := `{"organizationId":"org-a","environmentId":"env-a","id":"payments","version":3,"expiresAt":"2030-01-01T01:00:00Z"}`
	var output, diagnostic bytes.Buffer
	called := false
	code := Run(context.Background(), []string{"-socket", "/private/admin.sock", "-operation", "register-external"}, testInput(input), &output, &diagnostic,
		func(ctx context.Context, socket, operation string, body []byte) ([]byte, error) {
			called = true
			if socket != "/private/admin.sock" || operation != "register-external" || string(body) != input || ctx.Err() != nil {
				t.Fatal("external registration changed explicit inputs")
			}
			return nil, nil
		})
	if code != 0 || !called || output.Len() != 0 || diagnostic.Len() != 0 {
		t.Fatalf("external registration failed: exit=%d called=%v", code, called)
	}
}
