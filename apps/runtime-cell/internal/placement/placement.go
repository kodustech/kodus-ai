// Package placement is the cell's Placement port
// (docs/runtime/isolation-architecture.md C3): where a cell's machines live
// and how a claim's network attaches to them, under any isolation backend
// (internal/isolation).
//
// A claim's network has no route out: the cell's egress (proxy and
// resolver) joins it and is the only way out of it. Placements: docker (the
// host's Docker, the cell's behaviour before the split); containerd,
// kubernetes and ec2 later.
package placement

import (
	"context"
	"net/netip"
)

// Docker is the docker placement's name.
const Docker = "docker"

// NetworkSpec is one claim's network.
type NetworkSpec struct {
	// Name is the network's name (kodus-<claim>).
	Name string
	// Key spreads networks over Pool: the claim id, so a claim keeps
	// trying the same subnets first.
	Key string
	// Labels are the network's tags (cell, org, claim).
	Labels map[string]string
	// Pool is where the network takes its /24; 10.213.0.0/16 when invalid.
	Pool netip.Prefix
}

// Placement is where machines live and how a claim's network attaches.
type Placement interface {
	Name() string
	// CreateNetwork makes the claim's network with no route out, in a /24
	// of spec.Pool, and returns that subnet. The placement hands dynamic
	// addresses only from its upper half: the lower half is for fixed ones.
	CreateNetwork(ctx context.Context, spec NetworkSpec) (netip.Prefix, error)
	// AttachEgress joins the cell's egress to the network and returns its
	// address there; DetachEgress undoes it.
	AttachEgress(ctx context.Context, network, egress string) (string, error)
	DetachEgress(ctx context.Context, network, egress string) error
	// RemoveNetwork removes a network nothing is attached to any more.
	RemoveNetwork(ctx context.Context, network string) error
	// NetworkLabels are the network's tags; nil when it does not exist.
	NetworkLabels(ctx context.Context, network string) (map[string]string, error)
}
