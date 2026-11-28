package main

import (
	"fmt"
	"net"
	"strings"
)

// trustedProxies parses -trusted-proxies: the IPv4 addresses the egress
// proxies connect from, as the injector sees them. The injector compares
// each connection's address to them as text (Injector.TrustedProxies), so a
// name or another spelling would match nothing and refuse every
// credentialed host one connection at a time: it stops the injector at
// startup instead.
func trustedProxies(s string) ([]string, error) {
	var out []string
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p == "" {
			continue
		}
		ip := net.ParseIP(p).To4()
		if ip == nil {
			return nil, fmt.Errorf("trusted-proxies: %q is not an IPv4 address", p)
		}
		out = append(out, ip.String())
	}
	return out, nil
}
