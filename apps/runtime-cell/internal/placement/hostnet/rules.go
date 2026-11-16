package hostnet

import (
	"fmt"
	"net/netip"
	"slices"
	"strconv"
	"strings"
)

// The host side of a microVM's network, as one nftables ruleset the
// placement replaces whole on every change (nft -f, one transaction):
//
//   - inet <table>: what a machine sends to the host itself (input) may
//     reach the cell's egress address on its resolver and proxy ports, and
//     nothing else of the host; nothing a machine sends is forwarded
//     anywhere but to another machine on its own claim's bridge. The
//     egress (proxy and resolver) is the only way out.
//   - bridge <table>: each machine's tap may send only from its own MAC
//     and its own address, IPv4 and ARP, so no machine speaks as another
//     (the egress allow-list is per source address).
//
// Bridges are named BridgePrefix+hash and taps TapPrefix+hash, so the
// wildcard rules cover every claim of the placement and nothing else.

const (
	BridgePrefix = "kfb"
	TapPrefix    = "kft"
)

// Rules is everything the ruleset is made from.
type Rules struct {
	Table    string
	Egress   netip.Addr
	TCPPorts []uint16
	UDPPorts []uint16
	Networks []Network
}

func ports(ps []uint16) string {
	s := make([]string, len(ps))
	for i, p := range ps {
		s[i] = strconv.Itoa(int(p))
	}
	return "{ " + strings.Join(s, ", ") + " }"
}

// Ruleset is the nft script for r: it replaces both tables atomically.
func (r Rules) Ruleset() string {
	var b strings.Builder
	w := func(format string, a ...any) { fmt.Fprintf(&b, format+"\n", a...) }
	nets := slices.Clone(r.Networks)
	slices.SortFunc(nets, func(a, b Network) int { return strings.Compare(a.Bridge, b.Bridge) })
	w("table inet %s", r.Table)
	w("delete table inet %s", r.Table)
	w("table inet %s {", r.Table)
	w("\tchain input {")
	w("\t\ttype filter hook input priority filter - 10; policy accept;")
	w("\t\tiifname \"%s*\" jump from_machines", BridgePrefix)
	w("\t}")
	w("\tchain from_machines {")
	w("\t\tmeta nfproto ipv6 drop")
	if r.Egress.IsValid() {
		if len(r.UDPPorts) > 0 {
			w("\t\tip daddr %s udp dport %s accept", r.Egress, ports(r.UDPPorts))
		}
		if len(r.TCPPorts) > 0 {
			w("\t\tip daddr %s tcp dport %s accept", r.Egress, ports(r.TCPPorts))
		}
	}
	w("\t\tcounter drop")
	w("\t}")
	w("\tchain forward {")
	w("\t\ttype filter hook forward priority filter - 10; policy accept;")
	for _, n := range nets {
		w("\t\tiifname %q oifname %q accept", n.Bridge, n.Bridge)
	}
	w("\t\tiifname \"%s*\" counter drop", BridgePrefix)
	w("\t\toifname \"%s*\" counter drop", BridgePrefix)
	w("\t}")
	w("}")
	w("table bridge %s", r.Table)
	w("delete table bridge %s", r.Table)
	w("table bridge %s {", r.Table)
	w("\tchain prerouting {")
	w("\t\ttype filter hook prerouting priority filter; policy accept;")
	for _, n := range nets {
		taps := make([]Tap, 0, len(n.Taps))
		for _, t := range n.Taps {
			taps = append(taps, t)
		}
		slices.SortFunc(taps, func(a, b Tap) int { return strings.Compare(a.Name, b.Name) })
		for _, t := range taps {
			w("\t\tiifname %q ether saddr != %s drop", t.Name, t.MAC)
			w("\t\tiifname %q ether type arp arp saddr ip != %s drop", t.Name, t.IP)
			w("\t\tiifname %q ether type ip ip saddr != %s drop", t.Name, t.IP)
			w("\t\tiifname %q ether type != { ip, arp } drop", t.Name)
		}
	}
	w("\t\tiifname \"%s*\" ether type ip6 drop", TapPrefix)
	w("\t}")
	w("}")
	return b.String()
}
