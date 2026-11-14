package dockergvisor

// The claim's network: one bridge per claim out of the cell's pool, its
// resolver file, and its release.

import (
	"context"
	"errors"
	"fmt"
	"hash/fnv"
	"net/netip"
	"os"
	"path/filepath"
	"strings"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockercli"
)

func (d *Driver) PrepareClaim(ctx context.Context, spec driver.ClaimNetworkSpec) (driver.ClaimNetwork, error) {
	if err := driver.ValidateClaimID(spec.ClaimID); err != nil {
		return driver.ClaimNetwork{}, err
	}
	name := networkName(spec.ClaimID)
	labels := toLabels(map[string]string{driver.TagCell: d.cfg.CellID, driver.TagOrg: spec.OrgID, driver.TagClaim: spec.ClaimID})
	// internal: no route out except through the cell's proxy and resolver,
	// which join it here.
	subnet, err := d.createClaimNetwork(ctx, spec.ClaimID, name, labels)
	if err != nil {
		return driver.ClaimNetwork{}, err
	}
	n := driver.ClaimNetwork{WorkloadGroupID: name, ObserverGroupID: name}
	if d.cfg.BuilderImage != "" {
		n.Sources = []string{builderAddress(subnet).String()}
	}
	if d.cfg.EgressContainer == "" {
		return n, nil
	}
	addr, err := d.d.NetworkConnect(ctx, name, d.cfg.EgressContainer)
	if err == nil {
		err = d.writeResolv(name, addr)
	}
	if err != nil {
		// A claim the egress cannot join would run with no way out but
		// also with no resolver: refuse it rather than boot half wired.
		_ = d.d.NetworkDisconnect(ctx, name, d.cfg.EgressContainer)
		return driver.ClaimNetwork{}, errors.Join(fmt.Errorf("dockergvisor: attach egress to %s: %w", name, err), d.d.NetworkRemove(ctx, name))
	}
	n.EgressAddress = addr
	return n, nil
}

// createClaimNetwork makes the claim's network in a /24 of ClaimSubnets,
// starting where the claim id points and moving on while Docker says the
// subnet is taken. Docker hands dynamic addresses (the holder, the egress)
// only from the upper half; services take fixed ones in the lower half.
func (d *Driver) createClaimNetwork(ctx context.Context, claimID, name string, labels map[string]string) (netip.Prefix, error) {
	pool := d.cfg.ClaimSubnets
	if !pool.IsValid() {
		pool = netip.MustParsePrefix("10.213.0.0/16")
	}
	slots := 1 << (24 - pool.Bits())
	h := fnv.New32a()
	_, _ = h.Write([]byte(claimID))
	start := int(h.Sum32() % uint32(slots))
	var last error
	for i := range min(slots, 32) {
		subnet, upper := claimSlot(pool, (start+i)%slots)
		last = d.d.NetworkCreate(ctx, dockercli.NetworkSpec{Name: name, Internal: true, Labels: labels, Subnet: subnet.String(), IPRange: upper.String()})
		if last == nil {
			return subnet, nil
		}
		if !strings.Contains(last.Error(), "overlap") {
			return netip.Prefix{}, last
		}
	}
	return netip.Prefix{}, fmt.Errorf("dockergvisor: no free /24 for %s in %s: %w", name, pool, last)
}

// claimSlot is the slot-th /24 of pool and its upper half.
func claimSlot(pool netip.Prefix, slot int) (netip.Prefix, netip.Prefix) {
	b := pool.Masked().Addr().As4()
	n := (uint32(b[0])<<24 | uint32(b[1])<<16 | uint32(b[2])<<8) + uint32(slot)<<8
	base := netip.AddrFrom4([4]byte{byte(n >> 24), byte(n >> 16), byte(n >> 8), 0})
	upper := netip.AddrFrom4([4]byte{byte(n >> 24), byte(n >> 16), byte(n >> 8), 128})
	return netip.PrefixFrom(base, 24), netip.PrefixFrom(upper, 25)
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
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	// Read by the machines' users: world-readable, written by the cell only.
	return os.WriteFile(p, []byte("nameserver "+egress+"\noptions ndots:0 timeout:2 attempts:2\n"), 0o644)
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
	labels, err := d.d.NetworkLabels(ctx, n.WorkloadGroupID)
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
		if err := d.d.NetworkDisconnect(ctx, n.WorkloadGroupID, d.cfg.EgressContainer); err != nil {
			return err
		}
		if err := os.Remove(d.resolvPath(n.WorkloadGroupID)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	if err := d.d.NetworkRemove(ctx, n.WorkloadGroupID); err != nil {
		return err
	}
	d.forgetAdoptions(n.WorkloadGroupID)
	d.mu.Lock()
	g := d.limitGroups[n.WorkloadGroupID]
	d.mu.Unlock()
	return d.removeLimitGroup(ctx, g)
}
