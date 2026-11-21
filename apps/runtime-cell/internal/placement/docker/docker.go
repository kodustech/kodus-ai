// Package docker is the docker Placement: machines are containers in the
// host's Docker and a claim's network is an internal bridge in a /24 of the
// cell's pool. Moved unchanged from drivers/dockergvisor (network.go).
package docker

import (
	"context"
	"encoding/binary"
	"fmt"
	"hash/fnv"
	"net/netip"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/placement"
)

// Networks is the part of the host's Docker the placement uses;
// dockercli.CLI implements it.
type Networks interface {
	NetworkCreate(ctx context.Context, n dockercli.NetworkSpec) error
	NetworkConnect(ctx context.Context, network, container string) (string, error)
	NetworkDisconnect(ctx context.Context, network, container string) error
	NetworkRemove(ctx context.Context, name string) error
	NetworkLabels(ctx context.Context, name string) (map[string]string, error)
}

var _ Networks = dockercli.CLI{}

// DefaultPool is where claim networks take their /24 when the cell names none.
var DefaultPool = netip.MustParsePrefix("10.213.0.0/16")

// Placement is the host's Docker.
type Placement struct{ N Networks }

var _ placement.Placement = Placement{}

func (Placement) Name() string { return placement.Docker }

// CreateNetwork makes the claim's internal network in a /24 of the pool,
// starting where the key points and moving on while Docker says the subnet
// is taken. Docker hands dynamic addresses (the holder, the egress) only
// from the upper half; services take fixed ones in the lower half.
func (p Placement) CreateNetwork(ctx context.Context, spec placement.NetworkSpec) (netip.Prefix, error) {
	pool := spec.Pool
	if !pool.IsValid() {
		pool = DefaultPool
	}
	if !pool.Addr().Is4() || pool.Bits() > 24 {
		return netip.Prefix{}, fmt.Errorf("placement: claim subnets %s is not an IPv4 pool of a /24 or wider", pool)
	}
	slots := uint32(1) << (24 - pool.Bits())
	h := fnv.New32a()
	_, _ = h.Write([]byte(spec.Key))
	start := h.Sum32() % slots
	var last error
	for i := range min(slots, 32) {
		subnet, upper := ClaimSlot(pool, (start+i)%slots)
		last = p.N.NetworkCreate(ctx, dockercli.NetworkSpec{Name: spec.Name, Internal: true, Labels: spec.Labels, Subnet: subnet.String(), IPRange: upper.String()})
		if last == nil {
			return subnet, nil
		}
		if !dockercli.PoolOverlap(last) {
			return netip.Prefix{}, last
		}
	}
	return netip.Prefix{}, fmt.Errorf("placement: no free /24 for %s in %s: %w", spec.Name, pool, last)
}

// ClaimSlot is the slot-th /24 of pool and its upper half.
func ClaimSlot(pool netip.Prefix, slot uint32) (netip.Prefix, netip.Prefix) {
	b := pool.Masked().Addr().As4()
	var base [4]byte
	binary.BigEndian.PutUint32(base[:], binary.BigEndian.Uint32(b[:])&^0xff+slot<<8)
	upper := base
	upper[3] = 128
	return netip.PrefixFrom(netip.AddrFrom4(base), 24), netip.PrefixFrom(netip.AddrFrom4(upper), 25)
}

func (p Placement) AttachEgress(ctx context.Context, network, egress string) (string, error) {
	return p.N.NetworkConnect(ctx, network, egress)
}

func (p Placement) DetachEgress(ctx context.Context, network, egress string) error {
	return p.N.NetworkDisconnect(ctx, network, egress)
}

func (p Placement) RemoveNetwork(ctx context.Context, network string) error {
	return p.N.NetworkRemove(ctx, network)
}

func (p Placement) NetworkLabels(ctx context.Context, network string) (map[string]string, error) {
	return p.N.NetworkLabels(ctx, network)
}
