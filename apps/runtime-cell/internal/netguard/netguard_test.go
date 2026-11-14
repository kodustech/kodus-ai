package netguard

import (
	"net"
	"testing"
	"time"
)

func TestRefusedDestination(t *testing.T) {
	own, _ := ParseCIDRs("10.20.0.0/24")
	cases := map[string]string{
		"169.254.169.254": "link_local",
		"169.254.170.2":   "link_local",
		"0.0.0.0":         "special_address",
		"239.1.1.1":       "special_address",
		"127.0.0.1":       "internal_address",
		"10.0.0.5":        "internal_address",
		"172.16.3.4":      "internal_address",
		"192.168.1.1":     "internal_address",
		"100.64.0.1":      "internal_address",
		"10.20.0.7":       "",
		"93.184.216.34":   "",
		"192.0.2.10":      "",
	}
	for ip, want := range cases {
		if got := RefusedDestination(net.ParseIP(ip), own); got != want {
			t.Errorf("%s: %q, want %q", ip, got, want)
		}
	}
	// The metadata service stays refused even inside a network the cell owns.
	all, _ := ParseCIDRs("0.0.0.0/0")
	if got := RefusedDestination(net.ParseIP("169.254.169.254"), all); got != "link_local" {
		t.Errorf("metadata inside an owned network: %q", got)
	}
	if _, err := ParseCIDRs("10.0.0.0/33"); err == nil {
		t.Error("bad cidr accepted")
	}
}

func TestDenyList(t *testing.T) {
	for _, h := range []string{
		"api.anthropic.com", "x.blob.core.windows.net", "s3.us-east-1.amazonaws.com", "my.s3.amazonaws.com", "a.ngrok-free.app", "file.io",
		// Every S3 spelling, with and without a bucket in front.
		"bucket.s3.us-east-1.amazonaws.com", "s3-us-west-2.amazonaws.com", "bucket.s3-us-west-2.amazonaws.com",
		"bucket.s3-accelerate.amazonaws.com", "bucket.s3.dualstack.eu-west-1.amazonaws.com", "s3.cn-north-1.amazonaws.com.cn",
		"acct.r2.cloudflarestorage.com", "x.nyc3.digitaloceanspaces.com", "lh3.googleusercontent.com", "webhook.site",
	} {
		if !OnKodusDenyList(h, nil) {
			t.Errorf("%s not denied", h)
		}
	}
	for _, h := range []string{"registry.npmjs.org", "s3tools.example.com", "ec2.us-east-1.amazonaws.com"} {
		if OnKodusDenyList(h, nil) {
			t.Errorf("%s over-denied", h)
		}
	}
	owned := ParseOwnedHosts(" Cell-Evidence.s3.amazonaws.com. ,")
	if OnKodusDenyList("cell-evidence.s3.amazonaws.com", owned) {
		t.Fatal("the cell's own bucket is denied (owned hosts must be normalized)")
	}
}

func TestAnswersAreScopedAndExpire(t *testing.T) {
	now := time.Unix(1000, 0)
	a := NewAnswers(func() time.Time { return now })
	a.Record("c1", "cdn.example", []net.IP{net.ParseIP("192.0.2.1"), net.ParseIP("2001:db8::1")}, 0)
	a.Record("c1", "cdn.example", []net.IP{net.ParseIP("192.0.2.2")}, time.Minute)
	if !a.Handed("c1", "cdn.example", net.ParseIP("192.0.2.1")) || !a.Handed("c1", "cdn.example", net.ParseIP("192.0.2.2")) {
		t.Fatal("a rotated answer was forgotten")
	}
	if a.Handed("c2", "cdn.example", net.ParseIP("192.0.2.1")) || a.Handed("c1", "other.example", net.ParseIP("192.0.2.1")) {
		t.Fatal("answers leak across claims or names")
	}
	if a.Handed("c1", "cdn.example", net.ParseIP("2001:db8::1")) {
		t.Fatal("IPv6 recorded")
	}
	now = now.Add(minAnswerTTL + answerGrace + time.Second)
	if a.Handed("c1", "cdn.example", net.ParseIP("192.0.2.1")) {
		t.Fatal("expired answer still counts")
	}
	if !a.Handed("c1", "cdn.example", net.ParseIP("192.0.2.2")) {
		t.Fatal("the longer TTL expired early")
	}
	a.ForgetClaim("c1")
	if a.Handed("c1", "cdn.example", net.ParseIP("192.0.2.2")) {
		t.Fatal("forgotten claim still answers")
	}
}

func TestDenyListAddsTheOperatorsHosts(t *testing.T) {
	deny, err := NewDenyList([]string{"Files.Corp.Example.", ".internal.example"}, ParseOwnedHosts("evidence.s3.amazonaws.com,files.corp.example"))
	if err != nil {
		t.Fatal(err)
	}
	var zero DenyList
	cases := []struct {
		list DenyList
		host string
		want bool
	}{
		{zero, "pastebin.com", true},               // the zero value is the Kodus list
		{zero, "registry.npmjs.org", false},        // and nothing else
		{deny, "api.anthropic.com", true},          // the Kodus list stays under the operator's additions
		{deny, "files.corp.example", true},         // an operator entry beats owned: denied on purpose
		{deny, "internal.example", true},           // .domain denies the domain itself
		{deny, "git.internal.example", true},       // and every name under it
		{deny, "notinternal.example", false},       // but not a name that only ends the same
		{deny, "evidence.s3.amazonaws.com", false}, // owned passes the Kodus list
		{deny, "other.s3.amazonaws.com", true},
	}
	for _, c := range cases {
		if got := c.list.Denies(c.host); got != c.want {
			t.Errorf("Denies(%s) = %v, want %v", c.host, got, c.want)
		}
	}
}

func TestDenyListRefusesWhatItCannotSayExactly(t *testing.T) {
	for _, entry := range []string{"*.corp.example", "corp.*", "a b.example", ".", "bad/host"} {
		if _, err := NewDenyList([]string{entry}, nil); err == nil {
			t.Errorf("NewDenyList accepted %q", entry)
		}
	}
}
