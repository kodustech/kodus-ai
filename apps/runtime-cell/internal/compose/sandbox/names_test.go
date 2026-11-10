package sandbox

import (
	"errors"
	"net/netip"
	"path/filepath"
	"strings"
	"testing"

	"go.yaml.in/yaml/v3"
)

var claimSubnet = netip.MustParsePrefix("10.213.7.0/24")

func TestServiceAddressesAreFixedByName(t *testing.T) {
	a, err := ServiceAddresses([]string{"web", "db", "api"}, claimSubnet)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{"api": "10.213.7.10", "db": "10.213.7.11", "web": "10.213.7.12"}
	for n, ip := range want {
		if a[n].String() != ip {
			t.Errorf("%s = %s, want %s", n, a[n], ip)
		}
	}
	for _, bad := range []string{"10.213.7.0/25", "fd00::/64"} {
		if _, err := ServiceAddresses([]string{"web"}, netip.MustParsePrefix(bad)); err == nil {
			t.Errorf("subnet %s accepted", bad)
		}
	}
}

func TestEveryServiceGetsItsAddressTheNamesAndTheCellResolver(t *testing.T) {
	dir := checkout(t)
	o := opts(dir)
	o.Subnet, o.Resolv = claimSubnet, "/var/lib/kodus/claim-1/resolv.conf"
	out, err := Apply([]byte(good), o)
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	_ = yaml.Unmarshal(out, &doc)
	services := doc["services"].(map[string]any)
	addrs, _ := ServiceAddresses(sortedKeys(services), claimSubnet)
	for name, s := range services {
		svc := s.(map[string]any)
		net := svc["networks"].(map[string]any)[ClaimNetworkKey].(map[string]any)
		if net["ipv4_address"] != addrs[name].String() {
			t.Errorf("%s: address %v", name, net["ipv4_address"])
		}
		// A reset recreates the container: the MAC stays with the address.
		if net["mac_address"] != ServiceMAC(addrs[name]) {
			t.Errorf("%s: MAC %v", name, net["mac_address"])
		}
		if !sameHosts(svc["extra_hosts"], addrs) {
			t.Errorf("%s: extra_hosts %v", name, svc["extra_hosts"])
		}
		if !mountsTheCellResolv(svc["volumes"], o.Resolv) {
			t.Errorf("%s: no resolv.conf mount in %v", name, svc["volumes"])
		}
	}
}

// Name resolution is the cell's: a checkout cannot mount over it.
func TestACheckoutCannotMountOverNameResolution(t *testing.T) {
	dir := checkout(t)
	for _, vol := range []string{"./src:/etc/resolv.conf:ro", "./src:/etc/hosts", "./src:/etc/../etc/resolv.conf"} {
		compose := "services:\n  api:\n    image: x\n    volumes: [\"" + vol + "\"]\n"
		var re *RefusedError
		if _, err := Apply([]byte(compose), opts(dir)); !errors.As(err, &re) {
			t.Errorf("%s accepted: %v", vol, err)
		}
	}
}

func TestVerifyCanonicalHoldsAddressesNamesAndResolver(t *testing.T) {
	dir := checkout(t)
	src, _ := filepath.EvalSymlinks(filepath.Join(dir, "src"))
	o := opts(dir)
	o.Subnet, o.Resolv = claimSubnet, "/var/lib/kodus/claim-1/resolv.conf"
	resolv := `,{"type":"bind","source":"` + o.Resolv + `","target":"/etc/resolv.conf","read_only":true}`
	ok := strings.NewReplacer(
		`"kodus-claim":null`, `"kodus-claim":{"ipv4_address":"10.213.7.10","mac_address":"02:42:0a:d5:07:0a"}`,
		`"image":"x"`, `"image":"x","extra_hosts":["api=10.213.7.10"]`,
		`"read_only":true}`, `"read_only":true}`+resolv,
	).Replace(canonical(`{"type":"bind","source":"` + src + `","target":"/app","read_only":true}`))
	if err := VerifyCanonical([]byte(ok), o); err != nil {
		t.Fatalf("the cell's own config refused: %v", err)
	}
	bad := map[string]string{
		"another address":     strings.Replace(ok, `"ipv4_address":"10.213.7.10"`, `"ipv4_address":"10.213.7.99"`, 1),
		"another MAC":         strings.Replace(ok, `"mac_address":"02:42:0a:d5:07:0a"`, `"mac_address":"02:42:0a:d5:07:63"`, 1),
		"no MAC":              strings.Replace(ok, `,"mac_address":"02:42:0a:d5:07:0a"`, ``, 1),
		"a name off the list": strings.Replace(ok, `["api=10.213.7.10"]`, `["api=10.213.7.10","evil=1.2.3.4"]`, 1),
		"no resolv.conf":      strings.Replace(ok, resolv, ``, 1),
		"another resolv.conf": strings.Replace(ok, o.Resolv, "/etc/passwd", 1),
	}
	for name, cfg := range bad {
		if err := VerifyCanonical([]byte(cfg), o); err == nil {
			t.Errorf("%s accepted", name)
		}
	}
}
