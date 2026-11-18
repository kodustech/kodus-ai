package main

import (
	"slices"
	"testing"
)

// A proxy named by anything but its IPv4 address stops the injector at
// startup. It used to be taken as written and compared to each
// connection's address, so a host name or an IPv6 spelling refused every
// credentialed host, logged only per connection (injector.untrusted_peer).
func TestTrustedProxiesTakeIPv4AddressesAndRefuseNamesAtStartup(t *testing.T) {
	got, err := trustedProxies(" 10.214.0.2, ::ffff:127.0.0.1,,")
	if err != nil || !slices.Equal(got, []string{"10.214.0.2", "127.0.0.1"}) {
		t.Fatalf("addresses: %v %v", got, err)
	}
	for _, bad := range []string{"kodus-cell-egress", "10.214.0.2:8443", "fd00::2"} {
		if _, err := trustedProxies(bad); err == nil {
			t.Errorf("-trusted-proxies %q accepted", bad)
		}
	}
	if got, err := trustedProxies(""); err != nil || len(got) != 0 {
		t.Fatalf("none: %v %v", got, err)
	}
}
