package dockergvisor

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose/sandbox"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
)

// Up of a project in a workspace (ws/shop beside ws/billing) lets the
// project bind ../billing only when the agent names the workspace root, and
// never what is outside it. Without the root, the project is its own root
// as it always was.
func TestUpHoldsTheProjectInsideItsWorkspace(t *testing.T) {
	base := t.TempDir()
	ws := filepath.Join(base, "ws")
	shop := filepath.Join(ws, "shop")
	for _, dir := range []string{shop, filepath.Join(ws, "billing", "conf"), filepath.Join(base, "outside")} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	up := func(root, file string) error {
		d, r, _ := newDriver(t, `{"runsc":{}}`)
		ref, err := d.Create(context.Background(), spec())
		if err != nil {
			t.Fatal(err)
		}
		ref.Tags[driver.TagOrg], ref.Tags[driver.TagRole] = "", ""
		r.answers["compose config"] = canonicalFor(shop)
		r.answers["ps"] = "s1\n"
		r.answers["inspect"] = `[{"Id":"s1","Name":"/kodus-claim-1-workload-a-1","Config":{"Labels":{"kodus.cell":"cell-1"}},"NetworkSettings":{"Networks":{"kodus-claim-1":{"IPAddress":"172.30.0.9"}}}}]`
		_, err = d.Up(context.Background(), driver.UpRequest{Ref: ref, Compose: []byte(file), ProjectDir: shop, WorkspaceRoot: root})
		return err
	}
	sibling := "services:\n  a:\n    image: x\n    volumes: ['../billing/conf:/etc/billing']\n"
	var refused *sandbox.RefusedError
	if err := up("", sibling); !errors.As(err, &refused) {
		t.Fatalf("one repository reached its parent: %v", err)
	}
	if err := up(ws, sibling); err != nil {
		t.Fatalf("a workspace project binding ../billing: %v", err)
	}
	if err := up(ws, "services:\n  a:\n    image: x\n    volumes: ['../../outside:/x']\n"); !errors.As(err, &refused) {
		t.Fatalf("a workspace project left the workspace: %v", err)
	}
}
