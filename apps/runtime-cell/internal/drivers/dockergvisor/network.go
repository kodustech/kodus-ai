package dockergvisor

// The claim's network: one network per claim out of the cell's pool, made
// and attached by the placement (placement/docker), its resolver file, and
// its release.

import (
	"context"
	"errors"
	"fmt"
	"net/netip"
	"os"
	"path/filepath"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/placement"
)

func (d *Driver) PrepareClaim(ctx context.Context, spec driver.ClaimNetworkSpec) (driver.ClaimNetwork, error) {
	if err := driver.ValidateClaimID(spec.ClaimID); err != nil {
		return driver.ClaimNetwork{}, err
	}
	name := networkName(spec.ClaimID)
	labels := toLabels(map[string]string{driver.TagCell: d.cfg.CellID, driver.TagOrg: spec.OrgID, driver.TagClaim: spec.ClaimID})
	// internal: no route out except through the cell's proxy and resolver,
	// which join it here.
	subnet, err := d.place.CreateNetwork(ctx, placement.NetworkSpec{Name: name, Key: spec.ClaimID, Labels: labels, Pool: d.cfg.ClaimSubnets})
	if err != nil {
		return driver.ClaimNetwork{}, err
	}
	d.rememberSubnet(name, subnet)
	n := driver.ClaimNetwork{WorkloadGroupID: name, ObserverGroupID: name}
	if d.cfg.BuilderImage != "" {
		n.Sources = []string{builderAddress(subnet).String()}
		n.SourcesTrustCellCA = d.builderTrusted()
	}
	if d.cfg.EgressContainer == "" {
		return n, nil
	}
	addr, err := d.place.AttachEgress(ctx, name, d.cfg.EgressContainer)
	if err == nil {
		err = d.writeResolv(name, addr)
	}
	if err != nil {
		// A claim the egress cannot join would run with no way out but
		// also with no resolver: refuse it rather than boot half wired.
		_ = d.place.DetachEgress(ctx, name, d.cfg.EgressContainer)
		return driver.ClaimNetwork{}, errors.Join(fmt.Errorf("dockergvisor: attach egress to %s: %w", name, err), d.place.RemoveNetwork(ctx, name))
	}
	n.EgressAddress = addr
	return n, nil
}

// resolvPath is the cell's resolv.conf for a claim network: in the cell's
// own directory, never the checkout.
func (d *Driver) resolvPath(network string) string {
	dir := d.cfg.WorkDir
	if dir == "" {
		dir = os.TempDir()
	}
	return filepath.Join(dir, "resolv", network+".conf")
}

func (d *Driver) writeResolv(network, egress string) error {
	p := d.resolvPath(network)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil { //nolint:gosec // G301: the machines' users read resolv.conf through it; only the cell writes it
		return err
	}
	// Read by the machines' users: world-readable, written by the cell only.
	return os.WriteFile(p, []byte("nameserver "+egress+"\noptions ndots:0 timeout:2 attempts:2\n"), 0o644) //nolint:gosec // G306: the machines' users must read it; it holds no secret
}

// claimResolv is the resolv.conf a claim's machines mount ("" with no egress).
func (d *Driver) claimResolv(network string) (string, error) {
	if d.cfg.EgressContainer == "" {
		return "", nil
	}
	p := d.resolvPath(network)
	if _, err := os.Stat(p); err != nil {
		return "", fmt.Errorf("dockergvisor: no resolver for %s: %w", network, err)
	}
	return p, nil
}

// ReleaseClaim removes the claim's network, only when it carries this
// cell's label.
func (d *Driver) ReleaseClaim(ctx context.Context, n driver.ClaimNetwork) error {
	if n.WorkloadGroupID == "" {
		return nil
	}
	d.mu.Lock()
	delete(d.subnets, n.WorkloadGroupID)
	d.mu.Unlock()
	labels, err := d.place.NetworkLabels(ctx, n.WorkloadGroupID)
	if err != nil {
		return err
	}
	if labels == nil {
		d.mu.Lock()
		g := d.limitGroups[n.WorkloadGroupID]
		d.mu.Unlock()
		return d.removeLimitGroup(ctx, g)
	}
	if labels[dockercli.LabelFromTag(driver.TagCell)] != d.cfg.CellID {
		return fmt.Errorf("%w: network %s", driver.ErrNotOwned, n.WorkloadGroupID)
	}
	if d.cfg.ClaimLimits != nil {
		org := labels["kodus.org"]
		if org == "" {
			return ErrResourceEnforcement
		}
		d.mu.Lock()
		if d.limitGroups == nil {
			d.limitGroups = map[string]limitGroup{}
		}
		if d.limitGroups[n.WorkloadGroupID].key == "" {
			d.limitGroups[n.WorkloadGroupID] = limitGroup{key: resourceKey(d.cfg.CellID, org, n.WorkloadGroupID), network: n.WorkloadGroupID}
		}
		d.mu.Unlock()
	}
	// Docker removes no network a container is still attached to.
	if d.cfg.EgressContainer != "" {
		if err := d.place.DetachEgress(ctx, n.WorkloadGroupID, d.cfg.EgressContainer); err != nil {
			return err
		}
		if err := os.Remove(d.resolvPath(n.WorkloadGroupID)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	if err := d.place.RemoveNetwork(ctx, n.WorkloadGroupID); err != nil {
		return err
	}
	d.forgetAdoptions(n.WorkloadGroupID)
	d.mu.Lock()
	g := d.limitGroups[n.WorkloadGroupID]
	d.mu.Unlock()
	return d.removeLimitGroup(ctx, g)
}

// rememberSubnet keeps a claim network's subnet until ReleaseClaim.
func (d *Driver) rememberSubnet(network string, subnet netip.Prefix) {
	if !subnet.IsValid() {
		return
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.subnets == nil {
		d.subnets = map[string]netip.Prefix{}
	}
	d.subnets[network] = subnet
}

// subnetOf is the claim network's subnet: remembered, or read once.
func (d *Driver) subnetOf(ctx context.Context, network string) (netip.Prefix, error) {
	d.mu.Lock()
	subnet, ok := d.subnets[network]
	d.mu.Unlock()
	if ok {
		return subnet, nil
	}
	raw, err := d.d.NetworkSubnet(ctx, network)
	if err != nil {
		return netip.Prefix{}, err
	}
	if subnet, err = netip.ParsePrefix(raw); err != nil {
		return netip.Prefix{}, fmt.Errorf("dockergvisor: subnet of %s: %w", network, err)
	}
	d.rememberSubnet(network, subnet)
	return subnet, nil
}
