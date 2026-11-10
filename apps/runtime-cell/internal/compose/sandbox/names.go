package sandbox

import (
	"fmt"
	"net/netip"
	"slices"
	"strings"
)

// The claim's machines resolve through the cell resolver alone: Docker's
// embedded resolver forwards nothing on an internal network. So service
// names do not come from Docker either: each service gets a fixed address
// in the claim's subnet and every name goes in extra_hosts.

// ResolvTarget is where the cell's resolv.conf is mounted.
const ResolvTarget = "/etc/resolv.conf"

// DecoyTarget is where a Run's decoy credentials file is mounted (ADR-043):
// where a container's secrets usually are, and nothing legitimate reads.
const DecoyTarget = "/run/secrets/npmrc"

// firstServiceHost is the first address handed to a service; the ones
// below it (the gateway) stay free, and the subnet's upper half is left to
// Docker for the holder and the egress (PrepareClaim's --ip-range).
const firstServiceHost = 10

// ServiceAddresses gives each service, in name order, a fixed address in
// subnet: the same names and subnet always give the same addresses.
func ServiceAddresses(services []string, subnet netip.Prefix) (map[string]netip.Addr, error) {
	if !subnet.IsValid() || !subnet.Addr().Is4() || subnet.Bits() > 24 {
		return nil, fmt.Errorf("sandbox: claim subnet %v is not an IPv4 /24 or wider", subnet)
	}
	if len(services) > 128-firstServiceHost {
		return nil, fmt.Errorf("sandbox: %d services do not fit the lower half of the claim subnet", len(services))
	}
	names := slices.Sorted(slices.Values(services))
	out := make(map[string]netip.Addr, len(names))
	a := subnet.Masked().Addr()
	for range firstServiceHost {
		a = a.Next()
	}
	for _, n := range names {
		out[n] = a
		a = a.Next()
	}
	return out, nil
}

// extraHosts is every service name with its address, sorted.
func extraHosts(addrs map[string]netip.Addr) []any {
	out := make([]any, 0, len(addrs))
	for _, n := range sortedKeys(addrs) {
		out = append(out, n+":"+addrs[n].String())
	}
	return out
}

// sameHosts reports whether compose's extra_hosts (a list of "name:ip" or
// "name=ip", or a map) is exactly want.
func sameHosts(v any, want map[string]netip.Addr) bool {
	got := map[string]string{}
	switch x := v.(type) {
	case []any:
		for _, item := range x {
			s, _ := item.(string)
			i := strings.IndexAny(s, ":=")
			if i < 0 {
				return false
			}
			got[s[:i]] = s[i+1:]
		}
	case map[string]any:
		for k, ip := range x {
			got[k] = fmt.Sprint(ip)
		}
	case nil:
	default:
		return false
	}
	if len(got) != len(want) {
		return false
	}
	for n, a := range want {
		if got[n] != a.String() {
			return false
		}
	}
	return true
}

// ServiceMAC is the fixed MAC of a service's address: a reset recreates the
// service's container with the same address, and a gVisor peer (the
// observer) keeps the MAC it learned for it, so the MAC must not change
// either. Locally administered (02:), then the four bytes of the address.
func ServiceMAC(a netip.Addr) string {
	b := a.As4()
	return fmt.Sprintf("02:42:%02x:%02x:%02x:%02x", b[0], b[1], b[2], b[3])
}
