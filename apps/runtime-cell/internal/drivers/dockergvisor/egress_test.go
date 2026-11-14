package dockergvisor

import (
	"context"
	"net/netip"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver/drivertest"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockercli"
)

func withEgress(t *testing.T) (*Driver, *memDocker) {
	t.Helper()
	docker := newMemDocker()
	docker.plant(dockercli.Container{ID: "cegress", Name: "kodus-egress", Networks: map[string]string{"kodus-cell": "10.9.0.2"}})
	d, err := New(context.Background(), docker, Config{CellID: "cell-1", HolderImage: "kodus/holder@sha256:abc", WorkDir: t.TempDir(), EgressContainer: "kodus-egress"})
	if err != nil {
		t.Fatal(err)
	}
	recordChowns(d)
	return d, docker
}

// A claim network has no route out; the egress joins it and leaves with it.
func TestClaimNetworkGetsTheEgress(t *testing.T) {
	d, docker := withEgress(t)
	ctx := context.Background()
	n, err := d.PrepareClaim(ctx, driver.ClaimNetworkSpec{CellID: "cell-1", OrgID: "org-a", ClaimID: "claim-1"})
	if err != nil {
		t.Fatal(err)
	}
	if n.EgressAddress == "" || docker.containers["kodus-egress"].Networks[n.WorkloadGroupID] != n.EgressAddress {
		t.Fatalf("network %+v, egress on %v", n, docker.containers["kodus-egress"].Networks)
	}
	spec := drivertest.BaseSpec("cell-1", "claim-1", n)
	spec.ExpiresAt, spec.HardExpiresAt = time.Now().Add(10*time.Minute), time.Now().Add(time.Hour)
	ref, err := d.Create(ctx, spec)
	if err != nil {
		t.Fatal(err)
	}
	// Release detaches the egress first: Docker removes no network with an
	// endpoint on it.
	if err := d.Destroy(ctx, ref); err != nil {
		t.Fatal(err)
	}
	if err := d.ReleaseClaim(ctx, n); err != nil {
		t.Fatal(err)
	}
	if _, ok := docker.networks[n.WorkloadGroupID]; ok {
		t.Fatal("the claim network is still there")
	}
	if _, on := docker.containers["kodus-egress"].Networks[n.WorkloadGroupID]; on {
		t.Fatal("the egress is still on the released network")
	}
}

// An egress that cannot join refuses the claim and leaves no network behind:
// a claim never boots half wired.
func TestClaimIsRefusedWhenTheEgressCannotJoin(t *testing.T) {
	docker := newMemDocker()
	d, err := New(context.Background(), docker, Config{CellID: "cell-1", HolderImage: "kodus/holder@sha256:abc", WorkDir: t.TempDir(), EgressContainer: "kodus-egress"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := d.PrepareClaim(context.Background(), driver.ClaimNetworkSpec{CellID: "cell-1", OrgID: "org-a", ClaimID: "claim-1"}); err == nil {
		t.Fatal("a claim was prepared with no egress to join")
	}
	if len(docker.networks) != 0 {
		t.Fatalf("networks left behind: %v", docker.networks)
	}
}

// The claim's machines resolve through the cell resolver alone, by a file
// the cell writes next to its own state and removes with the network.
func TestClaimResolvNamesTheEgressAndGoesWithTheNetwork(t *testing.T) {
	d, _ := withEgress(t)
	ctx := context.Background()
	n, err := d.PrepareClaim(ctx, driver.ClaimNetworkSpec{CellID: "cell-1", OrgID: "org-a", ClaimID: "claim-1"})
	if err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(d.resolvPath(n.WorkloadGroupID))
	if err != nil || !strings.HasPrefix(string(b), "nameserver "+n.EgressAddress+"\n") {
		t.Fatalf("resolv.conf %q, %v", b, err)
	}
	if err := d.ReleaseClaim(ctx, n); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(d.resolvPath(n.WorkloadGroupID)); !os.IsNotExist(err) {
		t.Fatalf("resolv.conf left behind: %v", err)
	}
}

// A /24 another network holds is skipped, not shared.
func TestClaimNetworkSkipsATakenSubnet(t *testing.T) {
	docker := newMemDocker()
	docker.subnets["someone-else"] = "10.213.0.0/24"
	d, err := New(context.Background(), docker, Config{CellID: "cell-1", HolderImage: "kodus/holder@sha256:abc", WorkDir: t.TempDir(),
		ClaimSubnets: netip.MustParsePrefix("10.213.0.0/23")})
	if err != nil {
		t.Fatal(err)
	}
	n, err := d.PrepareClaim(context.Background(), driver.ClaimNetworkSpec{CellID: "cell-1", OrgID: "org-a", ClaimID: "claim-1"})
	if err != nil {
		t.Fatal(err)
	}
	if got := docker.subnets[n.WorkloadGroupID]; got != "10.213.1.0/24" {
		t.Fatalf("claim network on %s, want the free 10.213.1.0/24", got)
	}
}
