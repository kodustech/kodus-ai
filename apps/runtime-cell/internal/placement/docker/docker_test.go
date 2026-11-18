package docker

import (
	"context"
	"errors"
	"net/netip"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/placement"
)

// networks is a Docker that keeps its networks and refuses an overlapping subnet.
type networks struct {
	byName  map[string]dockercli.NetworkSpec
	members map[string]map[string]bool
}

func newNetworks() *networks {
	return &networks{byName: map[string]dockercli.NetworkSpec{}, members: map[string]map[string]bool{}}
}

func (n *networks) NetworkCreate(_ context.Context, s dockercli.NetworkSpec) error {
	for _, o := range n.byName {
		if o.Subnet == s.Subnet {
			return errors.New("Pool overlaps with other one on this address space")
		}
	}
	n.byName[s.Name] = s
	n.members[s.Name] = map[string]bool{}
	return nil
}

func (n *networks) NetworkConnect(_ context.Context, network, c string) (string, error) {
	n.members[network][c] = true
	return "10.213.0.200", nil
}

func (n *networks) NetworkDisconnect(_ context.Context, network, c string) error {
	delete(n.members[network], c)
	return nil
}

func (n *networks) NetworkRemove(_ context.Context, name string) error {
	if len(n.members[name]) > 0 {
		return errors.New("network has active endpoints")
	}
	delete(n.byName, name)
	return nil
}

func (n *networks) NetworkLabels(_ context.Context, name string) (map[string]string, error) {
	// A missing network has no labels (nil), as the real Docker answers.
	return n.byName[name].Labels, nil
}

func TestAClaimNetworkHasNoRouteOutAndTakesTheNextFreeSlashTwentyFour(t *testing.T) {
	n := newNetworks()
	p := Placement{N: n}
	pool := netip.MustParsePrefix("10.213.0.0/23") // two slots
	first, err := p.CreateNetwork(context.Background(), placement.NetworkSpec{Name: "kodus-a", Key: "a", Pool: pool, Labels: map[string]string{"kodus.cell": "c"}})
	if err != nil {
		t.Fatal(err)
	}
	// The same key starts at the same slot; the taken one is skipped.
	second, err := p.CreateNetwork(context.Background(), placement.NetworkSpec{Name: "kodus-b", Key: "a", Pool: pool})
	if err != nil {
		t.Fatal(err)
	}
	if first == second || !pool.Contains(first.Addr()) || !pool.Contains(second.Addr()) || first.Bits() != 24 {
		t.Fatalf("subnets %s %s", first, second)
	}
	// Internal: no route out. Dynamic addresses only from the upper half of the /24.
	a := n.byName["kodus-a"]
	dynamic := netip.MustParsePrefix(a.IPRange)
	if !a.Internal || a.Subnet != first.String() || dynamic.Bits() != 25 || !first.Contains(dynamic.Addr()) || dynamic.Addr().As4()[3] != 128 {
		t.Fatalf("network %+v", a)
	}
	if _, err := p.CreateNetwork(context.Background(), placement.NetworkSpec{Name: "kodus-c", Key: "c", Pool: pool}); err == nil {
		t.Fatal("a third network fit in a pool of two")
	}
	if labels, _ := p.NetworkLabels(context.Background(), "kodus-a"); labels["kodus.cell"] != "c" {
		t.Fatalf("labels %v", labels)
	}
}

func TestANetworkIsRemovedOnlyOnceTheEgressLeftIt(t *testing.T) {
	n := newNetworks()
	p := Placement{N: n}
	_, _ = p.CreateNetwork(context.Background(), placement.NetworkSpec{Name: "kodus-a", Key: "a", Labels: map[string]string{"kodus.cell": "c"}})
	if addr, err := p.AttachEgress(context.Background(), "kodus-a", "egress"); err != nil || addr == "" {
		t.Fatalf("attach: %q %v", addr, err)
	}
	if err := p.RemoveNetwork(context.Background(), "kodus-a"); err == nil {
		t.Fatal("removed a network the egress is still on")
	}
	_ = p.DetachEgress(context.Background(), "kodus-a", "egress")
	if err := p.RemoveNetwork(context.Background(), "kodus-a"); err != nil {
		t.Fatal(err)
	}
	if labels, _ := p.NetworkLabels(context.Background(), "kodus-a"); labels != nil {
		t.Fatal("the network survived")
	}
}

func TestTheSlotIsAlwaysASlashTwentyFourAndItsUpperHalf(t *testing.T) {
	subnet, upper := ClaimSlot(netip.MustParsePrefix("10.213.0.0/16"), 5)
	if subnet.String() != "10.213.5.0/24" || upper.String() != "10.213.5.128/25" {
		t.Fatalf("%s %s", subnet, upper)
	}
}
