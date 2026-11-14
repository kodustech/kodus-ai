//go:build linux

package gvisoregress

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver/drivertest"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockergvisor"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy"
)

// A compose project the driver boots: one service serves, the other asks
// it by name and asks the internet through the cell. The machines resolve
// through the cell resolver alone, so service names come from the driver.
const twoServices = `services:
  web:
    image: nginx:1.27-alpine
  client:
    image: alpine:3.20
    command: ["sleep", "300"]
`

func TestDriverBootsAComposeThatReachesItsServicesAndOnlyAllowedHosts(t *testing.T) {
	if os.Getenv("KODY_E2E_GVISOR") != "1" {
		t.Skip("KODY_E2E_GVISOR=1 runs it on a Linux Docker with runsc")
	}
	dir := t.TempDir()
	e := startEgress(t, dir, "kodus-egress-drv")
	ctx := context.Background()
	d, err := dockergvisor.New(ctx, dockercli.CLI{}, dockergvisor.Config{CellID: "cell-e2e", HolderImage: "alpine:3.20",
		WorkDir: filepath.Join(dir, "cell"), EgressContainer: e.name})
	if err != nil {
		t.Fatal(err)
	}
	n, err := d.PrepareClaim(ctx, driver.ClaimNetworkSpec{CellID: "cell-e2e", OrgID: "org-e2e", ClaimID: "claim-drv"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.ReleaseClaim(context.Background(), n) })
	spec := drivertest.BaseSpec("cell-e2e", "claim-drv", n)
	spec.OrgID, spec.ExpiresAt, spec.HardExpiresAt = "org-e2e", time.Now().Add(10*time.Minute), time.Now().Add(time.Hour)
	ref, err := d.Create(ctx, spec)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Destroy(context.Background(), ref) })

	project := filepath.Join(dir, "checkout")
	if err := os.MkdirAll(project, 0o755); err != nil {
		t.Fatal(err)
	}
	sources, err := d.Up(ctx, ref, []byte(twoServices), project)
	if err != nil {
		t.Fatalf("up: %v", err)
	}
	if err := e.push.Push(ctx, policy.ClaimPolicy{
		ClaimID: "claim-drv", OrgID: "org-e2e", Phase: policy.PhaseTest, Sources: append([]string{ref.PrivateAddress}, sources...),
		Allow: []string{allowed, "pastebin.com"}, SteerTo: n.EgressAddress, ExpiresAt: time.Now().Add(time.Hour), IssuedAt: time.Now(),
	}); err != nil {
		t.Fatalf("push policy: %v", err)
	}

	client := ref.MachineID + "-client-1"
	run := func(args ...string) (string, bool) {
		out, err := exec.Command("docker", append([]string{"exec", client}, args...)...).CombinedOutput()
		return string(out), err == nil
	}
	deadline := time.Now().Add(30 * time.Second)
	for {
		out, ok := run("wget", "-q", "-T", "5", "-O", "-", "http://web/")
		if ok && strings.Contains(out, "Welcome to nginx") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("client did not reach web by name: %s", out)
		}
		time.Sleep(time.Second)
	}
	if out, ok := run("wget", "-q", "-T", "15", "-O", "-", "https://"+allowed+"/alpine/"); !ok || !strings.Contains(out, "v3.") {
		t.Fatalf("allowed host not reached through the egress: %s", out)
	}
	if out, ok := run("wget", "-q", "-T", "8", "-O", "-", "https://pastebin.com/"); ok {
		t.Fatalf("denied host went through: %s", out)
	}
	if out, ok := run("cat", "/etc/resolv.conf"); !ok || !strings.Contains(out, "nameserver "+n.EgressAddress) {
		t.Fatalf("the service does not resolve through the cell: %s", out)
	}
}
