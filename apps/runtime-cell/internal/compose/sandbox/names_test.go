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

// A warm spare of a project runs beside it on the same claim network: the
// spare's services take addresses in the subnet's second block, which the
// first block's never use, and the cell's own check accepts them. A block
// holds half of what the lower half of the subnet does.
func TestTheSecondAddressBlockNeverMeetsTheFirst(t *testing.T) {
	names := make([]string, AddressBlockSize)
	for i := range names {
		names[i] = "svc" + strings.Repeat("x", i)
	}
	first, err := ServiceAddressesIn(names, claimSubnet, 0)
	if err != nil {
		t.Fatal(err)
	}
	second, err := ServiceAddressesIn(names, claimSubnet, 1)
	if err != nil {
		t.Fatal(err)
	}
	used := map[netip.Addr]bool{}
	for _, a := range first {
		used[a] = true
	}
	for n, a := range second {
		if used[a] || !claimSubnet.Contains(a) || a.As4()[3] >= 128 {
			t.Errorf("%s: %s in the second block", n, a)
		}
	}
	if _, err := ServiceAddressesIn(append(names, "one-more"), claimSubnet, 1); err == nil {
		t.Error("the second block took more services than it holds")
	}
	if _, err := ServiceAddressesIn(names, claimSubnet, 2); err == nil {
		t.Error("a third block accepted")
	}
	// The first block is today's addresses.
	if a, _ := ServiceAddressesIn([]string{"api"}, claimSubnet, 0); a["api"].String() != "10.213.7.10" {
		t.Errorf("first block api = %s", a["api"])
	}

	dir := checkout(t)
	o := opts(dir)
	o.Subnet, o.AddressBlock = claimSubnet, 1
	out, err := Apply([]byte(good), o)
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	_ = yaml.Unmarshal(out, &doc)
	services := doc["services"].(map[string]any)
	addrs, _ := ServiceAddressesIn(sortedKeys(services), claimSubnet, 1)
	for name, s := range services {
		net := s.(map[string]any)["networks"].(map[string]any)[ClaimNetworkKey].(map[string]any)
		if net["ipv4_address"] != addrs[name].String() || !sameHosts(s.(map[string]any)["extra_hosts"], addrs) {
			t.Errorf("%s: %v %v", name, net, s.(map[string]any)["extra_hosts"])
		}
	}
	src, _ := filepath.EvalSymlinks(filepath.Join(dir, "src"))
	api := addrs["api"].String()
	cfg := strings.NewReplacer(
		`"kodus-claim":null`, `"kodus-claim":{"ipv4_address":"`+api+`","mac_address":"`+ServiceMAC(addrs["api"])+`"}`,
		`"image":"x"`, `"image":"x","extra_hosts":["api=`+api+`"]`,
	).Replace(canonical(`{"type":"bind","source":"` + src + `","target":"/app","read_only":true}`))
	if err := VerifyCanonical([]byte(cfg), o); err != nil {
		t.Fatalf("the spare's own config refused: %v", err)
	}
	o.AddressBlock = 0
	if err := VerifyCanonical([]byte(cfg), o); err == nil {
		t.Fatal("the second block's addresses accepted for the first")
	}
}
