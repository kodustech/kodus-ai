// Package netguard holds the network rules every piece of the cell's data
// plane applies the same way: which addresses an allowed name may lead to,
// the Kodus deny list, and the answers the cell resolver handed out (so the
// proxy checks a connection against what the VM was actually told).
package netguard

import (
	"fmt"
	"net"
	"strings"
)

// Addresses an allowed name must never lead to. An allowlisted host whose
// DNS the PR author controls could otherwise point at the instance metadata
// service or at anything inside the cell's network.

var (
	cgnat     = mustCIDR("100.64.0.0/10")
	thisNet   = mustCIDR("0.0.0.0/8")
	benchmark = mustCIDR("198.18.0.0/15")
	ietf      = mustCIDR("192.0.0.0/24")
	reserved  = mustCIDR("240.0.0.0/4")
)

func mustCIDR(s string) *net.IPNet {
	_, n, err := net.ParseCIDR(s)
	if err != nil {
		panic(err)
	}
	return n
}

// ParseCIDRs reads a comma-separated list ("10.20.0.0/24,127.0.0.0/8").
func ParseCIDRs(s string) ([]*net.IPNet, error) {
	var out []*net.IPNet
	for _, part := range strings.Split(s, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		_, n, err := net.ParseCIDR(part)
		if err != nil {
			return nil, fmt.Errorf("cidr %q: %w", part, err)
		}
		out = append(out, n)
	}
	return out, nil
}

// RefusedDestination says why an egress connection may not go to ip, or "".
// Link-local (the metadata service), multicast and unspecified addresses are
// always refused. Loopback, private, CGNAT and other special ranges are
// refused unless they fall in one of the networks the cell owns (its mirror,
// its evidence endpoint), passed as internal.
func RefusedDestination(ip net.IP, internal []*net.IPNet) string {
	if ip == nil {
		return "no_address"
	}
	if ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() {
		return "link_local"
	}
	if ip.IsUnspecified() || ip.IsMulticast() || ip.IsInterfaceLocalMulticast() {
		return "special_address"
	}
	v4 := ip.To4()
	special := ip.IsLoopback() || ip.IsPrivate() ||
		(v4 != nil && (cgnat.Contains(v4) || thisNet.Contains(v4) || benchmark.Contains(v4) || ietf.Contains(v4) || reserved.Contains(v4)))
	if !special {
		return ""
	}
	for _, n := range internal {
		if n.Contains(ip) {
			return ""
		}
	}
	return "internal_address"
}
