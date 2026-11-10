package resolver

import (
	"fmt"
	"net"
	"sync/atomic"
	"testing"
	"time"

	"github.com/miekg/dns"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/netguard"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy"
)

type rig struct {
	addr     string
	srv      *Server
	upstream *atomic.Int32
}

func newRig(t *testing.T, answers int, configure func(*Server)) *rig {
	t.Helper()
	var n atomic.Int32
	upstream := start(t, dns.HandlerFunc(func(w dns.ResponseWriter, r *dns.Msg) {
		n.Add(1)
		m := new(dns.Msg)
		m.SetReply(r)
		for i := 0; i < answers; i++ {
			m.Answer = append(m.Answer, &dns.A{Hdr: dns.RR_Header{Name: r.Question[0].Name, Rrtype: dns.TypeA, Class: dns.ClassINET, Ttl: 60}, A: net.IPv4(192, 0, 2, byte(i+1))})
		}
		_ = w.WriteMsg(m)
	}))
	store := policy.NewStore(nil)
	_ = store.Put(policy.ClaimPolicy{ClaimID: "claim-1", OrgID: "o", Sources: []string{"127.0.0.1"}, Phase: policy.PhaseTest,
		Allow: []string{"cdn.example", "evidence.s3.amazonaws.com"}, ExpiresAt: time.Now().Add(time.Hour)})
	srv := &Server{Policies: store, Upstream: ForwardTo(upstream), Log: NewQueryLog(10), Answers: netguard.NewAnswers(nil)}
	if configure != nil {
		configure(srv)
	}
	return &rig{addr: start(t, srv), srv: srv, upstream: &n}
}

func (r *rig) ask(t *testing.T, name string) *dns.Msg {
	t.Helper()
	m := new(dns.Msg)
	m.SetQuestion(dns.Fqdn(name), dns.TypeA)
	resp, _, err := (&dns.Client{Timeout: 2 * time.Second}).Exchange(m, r.addr)
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

// The proxy accepts what the resolver handed: every answer is recorded for
// the claim and the name.
func TestAnswersAreRecordedForTheProxy(t *testing.T) {
	r := newRig(t, 2, nil)
	if resp := r.ask(t, "cdn.example"); len(resp.Answer) != 2 {
		t.Fatalf("%v", resp)
	}
	if !r.srv.Answers.Handed("claim-1", "cdn.example", net.ParseIP("192.0.2.2")) {
		t.Fatal("the handed address was not recorded")
	}
	r.srv.ForgetClaim("claim-1")
	if r.srv.Answers.Handed("claim-1", "cdn.example", net.ParseIP("192.0.2.2")) {
		t.Fatal("forgotten claim still recorded")
	}
}

// One upstream query per name and TTL, not one per VM query.
func TestAnswersAreCached(t *testing.T) {
	r := newRig(t, 1, nil)
	for i := 0; i < 5; i++ {
		if resp := r.ask(t, "cdn.example"); len(resp.Answer) != 1 {
			t.Fatalf("%v", resp)
		}
	}
	if got := r.upstream.Load(); got != 1 {
		t.Fatalf("%d upstream queries for one cached name", got)
	}
}

func TestEachSourceIsRateLimited(t *testing.T) {
	r := newRig(t, 1, func(s *Server) { s.QPS, s.Burst = 0.001, 3 })
	refused := 0
	for i := 0; i < 6; i++ {
		if r.ask(t, "cdn.example").Rcode == dns.RcodeRefused {
			refused++
		}
	}
	if refused != 3 {
		t.Fatalf("%d refused, want 3 past the burst", refused)
	}
}

// A UDP answer bigger than the client's buffer is cut with TC set, not sent
// oversized.
func TestLargeUDPAnswerIsTruncated(t *testing.T) {
	r := newRig(t, 60, nil)
	resp := r.ask(t, "cdn.example")
	if !resp.Truncated || len(resp.Answer) >= 60 {
		t.Fatalf("truncated=%v answers=%d", resp.Truncated, len(resp.Answer))
	}
}

// The cell's own bucket is on the deny list's S3 pattern; the owned hosts
// the resolver is given let it through (before, the resolver had no flag for
// them and answered NXDOMAIN while the proxy allowed the host).
func TestOwnedHostsPassTheDenyList(t *testing.T) {
	r := newRig(t, 1, nil)
	if resp := r.ask(t, "evidence.s3.amazonaws.com"); resp.Rcode != dns.RcodeNameError {
		t.Fatalf("denied host answered: %v", resp)
	}
	r = newRig(t, 1, func(s *Server) {
		s.Deny, _ = netguard.NewDenyList(nil, netguard.ParseOwnedHosts("evidence.s3.amazonaws.com"))
	})
	if resp := r.ask(t, "evidence.s3.amazonaws.com"); len(resp.Answer) != 1 {
		t.Fatalf("owned host refused: %v", resp)
	}
}

// One claim flooding its log keeps the other claims' evidence.
func TestQueryLogIsPerClaim(t *testing.T) {
	l := NewQueryLog(3)
	l.add(QueryRecord{ClaimID: "quiet", Name: "a"})
	for i := 0; i < 50; i++ {
		l.add(QueryRecord{ClaimID: "loud", Name: fmt.Sprint(i)})
	}
	if q := l.ForClaim("quiet"); len(q) != 1 {
		t.Fatalf("quiet claim lost its log: %v", q)
	}
	if q := l.ForClaim("loud"); len(q) != 3 || q[2].Name != "49" {
		t.Fatalf("loud %v", q)
	}
	l.Prune(func(c string) bool { return c == "loud" }, time.Now().Add(time.Hour))
	if len(l.ForClaim("quiet")) != 0 || len(l.ForClaim("loud")) != 3 {
		t.Fatal("prune")
	}
}

// An operator's own deny entry beats a policy that allows the name.
func TestOperatorDenyBeatsThePolicy(t *testing.T) {
	r := newRig(t, 1, func(s *Server) { s.Deny, _ = netguard.NewDenyList([]string{"cdn.example"}, nil) })
	if resp := r.ask(t, "cdn.example"); resp.Rcode != dns.RcodeNameError {
		t.Fatalf("operator-denied name answered: %v", resp)
	}
}

// On a claim network with no route out, an allowed name answers the proxy's
// address and nothing is looked up; denied and unknown names still fail.
func TestSteeredClaimGetsTheProxyForEveryAllowedName(t *testing.T) {
	r := newRig(t, 1, nil)
	if err := r.srv.Policies.Put(policy.ClaimPolicy{ClaimID: "claim-1", OrgID: "o", Sources: []string{"127.0.0.1"}, Phase: policy.PhaseTest,
		Allow: []string{"cdn.example", "pastebin.com"}, SteerTo: "172.30.0.2", ExpiresAt: time.Now().Add(time.Hour), IssuedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	resp := r.ask(t, "cdn.example")
	if len(resp.Answer) != 1 || resp.Answer[0].(*dns.A).A.String() != "172.30.0.2" {
		t.Fatalf("allowed name answered %v, want the proxy", resp.Answer)
	}
	if r.upstream.Load() != 0 {
		t.Fatal("a steered name was looked up upstream")
	}
	if r.srv.Answers.Handed("claim-1", "cdn.example", net.ParseIP("172.30.0.2")) {
		t.Fatal("the proxy's address was recorded as an answer for the name")
	}
	for _, name := range []string{"pastebin.com", "other.example"} {
		if resp := r.ask(t, name); resp.Rcode != dns.RcodeNameError {
			t.Errorf("%s answered %v, want NXDOMAIN", name, resp)
		}
	}
}
