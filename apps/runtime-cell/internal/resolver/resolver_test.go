package resolver

import (
	"context"
	"net"
	"sync/atomic"
	"testing"
	"time"

	"github.com/miekg/dns"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/netguard"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy"
)

func start(t *testing.T, h dns.Handler) string {
	t.Helper()
	pc, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := &dns.Server{PacketConn: pc, Handler: h}
	go func() { _ = srv.ActivateAndServe() }()
	t.Cleanup(func() { _ = srv.Shutdown() })
	return pc.LocalAddr().String()
}

func TestResolver(t *testing.T) {
	var upstreamQueries atomic.Int32
	upstream := start(t, dns.HandlerFunc(func(w dns.ResponseWriter, r *dns.Msg) {
		upstreamQueries.Add(1)
		m := new(dns.Msg)
		m.SetReply(r)
		m.Answer = append(m.Answer,
			&dns.A{Hdr: dns.RR_Header{Name: r.Question[0].Name, Rrtype: dns.TypeA, Class: dns.ClassINET, Ttl: 60}, A: net.ParseIP("192.0.2.10")},
			&dns.AAAA{Hdr: dns.RR_Header{Name: r.Question[0].Name, Rrtype: dns.TypeAAAA, Class: dns.ClassINET, Ttl: 60}, AAAA: net.ParseIP("2001:db8::10")},
		)
		_ = w.WriteMsg(m)
	}))
	store := policy.NewStore(nil)
	_ = store.Put(policy.ClaimPolicy{ClaimID: "claim-1", OrgID: "o", Sources: []string{"127.0.0.1"}, Phase: policy.PhaseTest,
		Allow: []string{"mirror.cell.internal", "api.anthropic.com"}, AppAddress: "10.0.3.10", ExpiresAt: time.Now().Add(time.Hour)})
	log := NewQueryLog(100)
	addr := start(t, &Server{Policies: store, Upstream: ForwardTo(upstream), Log: log})

	ask := func(name string, qtype uint16) *dns.Msg {
		m := new(dns.Msg)
		m.SetQuestion(dns.Fqdn(name), qtype)
		r, _, err := (&dns.Client{Timeout: 2 * time.Second}).Exchange(m, addr)
		if err != nil {
			t.Fatal(err)
		}
		return r
	}

	r := ask("mirror.cell.internal", dns.TypeA)
	if r.Rcode != dns.RcodeSuccess || len(r.Answer) != 1 || r.Answer[0].(*dns.A).A.String() != "192.0.2.10" {
		t.Fatalf("allowed: %v", r)
	}
	if r := ask("app.kody.internal", dns.TypeA); len(r.Answer) != 1 || r.Answer[0].(*dns.A).A.String() != "10.0.3.10" {
		t.Fatalf("app: %v", r)
	}
	before := upstreamQueries.Load()
	// S-03: random subdomain and anything off the list: NXDOMAIN, no query out.
	for _, n := range []string{"x9k2.mirror.cell.internal", "evil.example", "api.anthropic.com", "dns.google"} {
		if r := ask(n, dns.TypeA); r.Rcode != dns.RcodeNameError {
			t.Fatalf("%s: rcode %s", n, dns.RcodeToString[r.Rcode])
		}
	}
	// TXT on an allowed name (a classic tunnel) is answered empty locally.
	if r := ask("mirror.cell.internal", dns.TypeTXT); len(r.Answer) != 0 {
		t.Fatal("TXT answered")
	}
	if r := ask("mirror.cell.internal", dns.TypeAAAA); len(r.Answer) != 0 {
		t.Fatal("AAAA answered")
	}
	if upstreamQueries.Load() != before {
		t.Fatalf("refused names reached the upstream (%d queries)", upstreamQueries.Load()-before)
	}
	entries := log.ForClaim("claim-1")
	if len(entries) != 8 || entries[2].Name != "x9k2.mirror.cell.internal" || entries[2].Rcode != "NXDOMAIN" {
		t.Fatalf("log %+v", entries)
	}
	// What the claim's allowlist refused says so (the failure bundle's
	// denied egress); an allowed answer does not, nor a name of the
	// platform deny list (api.anthropic.com, dns.google), which no approval lifts.
	approvable := map[string]bool{"x9k2.mirror.cell.internal": true, "evil.example": true}
	for i, e := range entries {
		if e.Denied != approvable[e.Name] {
			t.Fatalf("entry %d %s denied=%v", i, e.Name, e.Denied)
		}
	}

	store.Delete("claim-1")
	if r := ask("mirror.cell.internal", dns.TypeA); r.Rcode != dns.RcodeRefused {
		t.Fatal("unknown source answered")
	}

	ips, err := (&Server{Upstream: ForwardTo(upstream)}).LookupA(context.Background(), "mirror.cell.internal")
	if err != nil || len(ips) != 1 {
		t.Fatal(ips, err)
	}
}

// An allowed name whose upstream answer points at the metadata service or
// inside the cell's network gets no address, from the VM's resolver and from
// the proxy's lookup alike.
func TestResolverDropsInternalAnswers(t *testing.T) {
	upstream := start(t, dns.HandlerFunc(func(w dns.ResponseWriter, r *dns.Msg) {
		m := new(dns.Msg)
		m.SetReply(r)
		ip := map[string]string{"meta.attacker.example.": "169.254.169.254", "lan.attacker.example.": "10.0.0.5", "mirror.cell.internal.": "10.20.0.7"}[r.Question[0].Name]
		m.Answer = append(m.Answer, &dns.A{Hdr: dns.RR_Header{Name: r.Question[0].Name, Rrtype: dns.TypeA, Class: dns.ClassINET, Ttl: 60}, A: net.ParseIP(ip)})
		_ = w.WriteMsg(m)
	}))
	own, _ := netguard.ParseCIDRs("10.20.0.0/24")
	store := policy.NewStore(nil)
	_ = store.Put(policy.ClaimPolicy{ClaimID: "claim-1", OrgID: "o", Sources: []string{"127.0.0.1"}, Phase: policy.PhaseTest,
		Allow: []string{"meta.attacker.example", "lan.attacker.example", "mirror.cell.internal"}, ExpiresAt: time.Now().Add(time.Hour)})
	srv := &Server{Policies: store, Upstream: ForwardTo(upstream), Log: NewQueryLog(10), InternalCIDRs: own}
	addr := start(t, srv)
	ask := func(name string) []dns.RR {
		m := new(dns.Msg)
		m.SetQuestion(dns.Fqdn(name), dns.TypeA)
		r, _, err := (&dns.Client{Timeout: 2 * time.Second}).Exchange(m, addr)
		if err != nil {
			t.Fatal(err)
		}
		return r.Answer
	}
	for _, name := range []string{"meta.attacker.example", "lan.attacker.example"} {
		if a := ask(name); len(a) != 0 {
			t.Errorf("%s answered %v", name, a)
		}
		if ips, _ := srv.LookupA(context.Background(), name); len(ips) != 0 {
			t.Errorf("%s looked up %v", name, ips)
		}
	}
	if a := ask("mirror.cell.internal"); len(a) != 1 {
		t.Errorf("the cell's own mirror lost its address: %v", a)
	}
}

// docker-gvisor: the mirror is on the egress, answered with the claim's steer address.
func TestResolverAnswersTheMirrorWithTheSteerAddress(t *testing.T) {
	store := policy.NewStore(nil)
	_ = store.Put(policy.ClaimPolicy{ClaimID: "claim-1", OrgID: "o", Sources: []string{"127.0.0.1"}, Phase: policy.PhaseBuild,
		SteerTo: "10.213.5.2", ExpiresAt: time.Now().Add(time.Hour)})
	addr := start(t, &Server{Policies: store, Upstream: ForwardTo("127.0.0.1:1"), Log: NewQueryLog(10)})
	m := new(dns.Msg)
	m.SetQuestion("mirror.cell.internal.", dns.TypeA)
	r, _, err := (&dns.Client{Timeout: 2 * time.Second}).Exchange(m, addr)
	if err != nil || len(r.Answer) != 1 || r.Answer[0].(*dns.A).A.String() != "10.213.5.2" {
		t.Fatalf("%v %v", r, err)
	}
}
