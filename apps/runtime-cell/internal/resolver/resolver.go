// Package resolver is the only DNS the VMs and the observer have (docs §4
// "Resolver DNS"). It answers app.kody.internal and the claim's exact
// allowlist; every other name gets NXDOMAIN without any query leaving the
// cell. Every query is logged by claim, every address it hands a claim is
// recorded (netguard.Answers) so the proxy accepts exactly those, answers
// are cached for their TTL, and each source is rate limited: one claim
// cannot exhaust the upstream resolver for the others.
package resolver

import (
	"context"
	"log/slog"
	"net"
	"strings"
	"sync"
	"time"

	"github.com/miekg/dns"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/netguard"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy"
)

// QueryRecord is one logged DNS query.
type QueryRecord struct {
	ClaimID string `json:"claimId,omitempty"`
	Source  string `json:"source"`
	Name    string `json:"name"`
	Type    string `json:"type"`
	Rcode   string `json:"rcode"`
	// Denied: the claim's allowlist refused the name (an NXDOMAIN of the
	// resolver, not of the name's own zone, nor of the platform deny list,
	// which no approval lifts). The failure bundle reports it as denied
	// egress a person can approve.
	Denied bool `json:"denied,omitempty"`
	// Platform: the platform deny list refused the name (cloud storage,
	// paste sites); the bundle says so, and no approval lifts it.
	Platform bool      `json:"platform,omitempty"`
	At       time.Time `json:"at"`
}

// QueryLog keeps the last maxPerClaim queries of each claim, so a claim
// that floods the resolver evicts only its own evidence.
type QueryLog struct {
	mu          sync.Mutex
	byClaim     map[string][]QueryRecord
	maxPerClaim int
}

func NewQueryLog(maxPerClaim int) *QueryLog {
	return &QueryLog{byClaim: map[string][]QueryRecord{}, maxPerClaim: max(maxPerClaim, 1)}
}

func (l *QueryLog) add(e QueryRecord) {
	l.mu.Lock()
	defer l.mu.Unlock()
	q := append(l.byClaim[e.ClaimID], e)
	if len(q) > l.maxPerClaim {
		q = append([]QueryRecord(nil), q[len(q)-l.maxPerClaim:]...)
	}
	l.byClaim[e.ClaimID] = q
}

// ForClaim returns the claim's queries, oldest first.
func (l *QueryLog) ForClaim(claim string) []QueryRecord {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]QueryRecord(nil), l.byClaim[claim]...)
}

// Prune drops the log of every claim live does not keep whose last query is
// older than before: the agent had its time to read it.
func (l *QueryLog) Prune(live func(claim string) bool, before time.Time) {
	l.mu.Lock()
	defer l.mu.Unlock()
	for claim, q := range l.byClaim {
		if !live(claim) && (len(q) == 0 || q[len(q)-1].At.Before(before)) {
			delete(l.byClaim, claim)
		}
	}
}

// Upstream answers an allowed question (the cell's own recursive resolver).
type Upstream func(ctx context.Context, q dns.Question) ([]dns.RR, int, error)

// ForwardTo returns an Upstream that asks a DNS server over UDP (EDNS, 4 KB)
// and again over TCP when the answer comes back truncated.
func ForwardTo(addr string) Upstream {
	udp := &dns.Client{Timeout: 3 * time.Second, UDPSize: 4096}
	tcp := &dns.Client{Net: "tcp", Timeout: 3 * time.Second}
	return func(ctx context.Context, q dns.Question) ([]dns.RR, int, error) {
		m := new(dns.Msg)
		m.SetQuestion(q.Name, q.Qtype)
		m.RecursionDesired = true
		m.SetEdns0(4096, false)
		r, _, err := udp.ExchangeContext(ctx, m, addr)
		if err == nil && r.Truncated {
			r, _, err = tcp.ExchangeContext(ctx, m, addr)
		}
		if err != nil {
			return nil, dns.RcodeServerFailure, err
		}
		return r.Answer, r.Rcode, nil
	}
}

const (
	// defaultQPS and defaultBurst bound one source's queries.
	defaultQPS   = 50
	defaultBurst = 200
	maxCacheTTL  = 5 * time.Minute
	maxCached    = 10_000
)

type Server struct {
	Policies *policy.Store
	Upstream Upstream
	Log      *QueryLog
	// Answers records what each claim was handed; the proxy reads it.
	Answers *netguard.Answers
	// Deny is the hosts no policy reaches (netguard.DenyList); its zero
	// value is the Kodus list.
	Deny netguard.DenyList
	// InternalCIDRs: the cell's own networks, the only private addresses an
	// upstream answer may carry (netguard.RefusedDestination).
	InternalCIDRs []*net.IPNet
	// QPS and Burst bound each source; 0 takes the defaults.
	QPS, Burst float64
	Logger     *slog.Logger
	Now        func() time.Time

	once    sync.Once
	mu      sync.Mutex
	cache   map[cacheKey]cached
	buckets map[string]*bucket
}

type cacheKey struct {
	name  string
	qtype uint16
}

type cached struct {
	answers []dns.RR
	rcode   int
	until   time.Time
}

type bucket struct {
	tokens float64
	at     time.Time
}

func (s *Server) defaults() {
	s.once.Do(func() {
		if s.Now == nil {
			s.Now = time.Now
		}
		if s.Logger == nil {
			s.Logger = slog.Default()
		}
		if s.QPS == 0 {
			s.QPS = defaultQPS
		}
		if s.Burst == 0 {
			s.Burst = defaultBurst
		}
		s.cache = map[cacheKey]cached{}
		s.buckets = map[string]*bucket{}
	})
}

// allow takes a token from src's bucket.
func (s *Server) allow(src string) bool {
	now := s.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	b := s.buckets[src]
	if b == nil {
		if len(s.buckets) > 10_000 {
			s.buckets = map[string]*bucket{}
		}
		b = &bucket{tokens: s.Burst, at: now}
		s.buckets[src] = b
	}
	b.tokens = min(s.Burst, b.tokens+now.Sub(b.at).Seconds()*s.QPS)
	b.at = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// lookup asks the upstream through the cache. Records other than A and
// CNAME, and A records that lead inside the cell, are dropped before the
// answer is cached.
func (s *Server) lookup(ctx context.Context, q dns.Question) ([]dns.RR, int, error) {
	key := cacheKey{strings.ToLower(q.Name), q.Qtype}
	now := s.Now()
	s.mu.Lock()
	if c, ok := s.cache[key]; ok && now.Before(c.until) {
		s.mu.Unlock()
		return copyRRs(c.answers, c.until.Sub(now)), c.rcode, nil
	}
	s.mu.Unlock()
	answers, rcode, err := s.Upstream(ctx, q)
	if err != nil {
		return nil, rcode, err
	}
	var kept []dns.RR
	ttl := maxCacheTTL
	for _, rr := range answers {
		switch a := rr.(type) {
		case *dns.A:
			// An allowed name the PR author's DNS points inside (the
			// metadata service, the cell's network) gets no address.
			if netguard.RefusedDestination(a.A, s.InternalCIDRs) != "" {
				continue
			}
		case *dns.CNAME:
		default:
			continue
		}
		kept = append(kept, rr)
		ttl = min(ttl, time.Duration(rr.Header().Ttl)*time.Second)
	}
	if ttl > 0 && (rcode == dns.RcodeSuccess || rcode == dns.RcodeNameError) {
		s.mu.Lock()
		if len(s.cache) >= maxCached {
			s.cache = map[cacheKey]cached{}
		}
		s.cache[key] = cached{answers: kept, rcode: rcode, until: now.Add(ttl)}
		s.mu.Unlock()
	}
	return kept, rcode, nil
}

// copyRRs returns copies whose TTL is what is left in the cache.
func copyRRs(rrs []dns.RR, left time.Duration) []dns.RR {
	out := make([]dns.RR, len(rrs))
	for i, rr := range rrs {
		c := dns.Copy(rr)
		c.Header().Ttl = uint32(max(left/time.Second, 1))
		out[i] = c
	}
	return out
}

func (s *Server) ServeDNS(w dns.ResponseWriter, req *dns.Msg) {
	s.defaults()
	resp := new(dns.Msg)
	resp.SetReply(req)
	resp.RecursionAvailable = true
	var src net.IP
	_, udp := w.RemoteAddr().(*net.UDPAddr)
	switch a := w.RemoteAddr().(type) {
	case *net.UDPAddr:
		src = a.IP
	case *net.TCPAddr:
		src = a.IP
	}
	if len(req.Question) != 1 {
		resp.Rcode = dns.RcodeFormatError
		_ = w.WriteMsg(resp)
		return
	}
	pol, known := s.Policies.ForSource(src)
	q := req.Question[0]
	name := strings.TrimSuffix(strings.ToLower(q.Name), ".")
	entry := QueryRecord{ClaimID: pol.ClaimID, Source: src.String(), Name: name, Type: dns.TypeToString[q.Qtype], At: s.Now().UTC()}
	defer func() {
		entry.Rcode = dns.RcodeToString[resp.Rcode]
		if s.Log != nil {
			s.Log.add(entry)
		}
		// A UDP answer that does not fit is cut with TC set; the client
		// asks again over TCP.
		if udp {
			size := dns.MinMsgSize
			if opt := req.IsEdns0(); opt != nil {
				size = int(opt.UDPSize())
			}
			resp.Truncate(size)
		}
		_ = w.WriteMsg(resp)
	}()

	if !known || q.Qclass != dns.ClassINET {
		resp.Rcode = dns.RcodeRefused
		return
	}
	if !s.allow(src.String()) {
		resp.Rcode = dns.RcodeRefused
		s.Logger.Warn("resolver.rate_limited", "claim", pol.ClaimID, "source", src.String())
		return
	}
	if name == policy.AppHost {
		if q.Qtype == dns.TypeA && pol.AppAddress != "" {
			if ip := net.ParseIP(pol.AppAddress).To4(); ip != nil {
				resp.Answer = append(resp.Answer, &dns.A{Hdr: dns.RR_Header{Name: q.Name, Rrtype: dns.TypeA, Class: dns.ClassINET, Ttl: 30}, A: ip})
			}
		}
		return // AAAA and others: NOERROR, empty (no IPv6)
	}
	if name == policy.MirrorHost && pol.SteerTo != "" {
		// docker-gvisor: the registry mirror sits on the egress, at the
		// proxy's address on the claim's network. Elsewhere it is a name of
		// the cell's own subnet, resolved like any allowed name.
		if ip := net.ParseIP(pol.SteerTo).To4(); ip != nil && q.Qtype == dns.TypeA {
			resp.Answer = append(resp.Answer, &dns.A{Hdr: dns.RR_Header{Name: q.Name, Rrtype: dns.TypeA, Class: dns.ClassINET, Ttl: 30}, A: ip})
		}
		return
	}
	norm, err := policy.NormalizeHost(name)
	if err != nil || !pol.Allows(norm) || s.Deny.Denies(norm) {
		resp.Rcode = dns.RcodeNameError
		entry.Denied = err == nil && !pol.Allows(norm) && !s.Deny.Denies(norm)
		entry.Platform = err == nil && s.Deny.Denies(norm)
		return
	}
	if q.Qtype != dns.TypeA && q.Qtype != dns.TypeCNAME {
		return // only IPv4 addresses leave this resolver
	}
	if pol.SteerTo != "" {
		// No route out: the allowed name leads to the proxy, which dials it
		// itself. Nothing is looked up or recorded for the claim here.
		if ip := net.ParseIP(pol.SteerTo).To4(); ip != nil && q.Qtype == dns.TypeA {
			resp.Answer = append(resp.Answer, &dns.A{Hdr: dns.RR_Header{Name: q.Name, Rrtype: dns.TypeA, Class: dns.ClassINET, Ttl: 30}, A: ip})
		}
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	answers, rcode, err := s.lookup(ctx, q)
	if err != nil {
		resp.Rcode = dns.RcodeServerFailure
		return
	}
	resp.Rcode = rcode
	resp.Answer = answers
	var handed []net.IP
	ttl := maxCacheTTL
	for _, rr := range answers {
		if a, ok := rr.(*dns.A); ok {
			handed = append(handed, a.A)
			ttl = min(ttl, time.Duration(a.Hdr.Ttl)*time.Second)
		}
	}
	s.Answers.Record(pol.ClaimID, norm, handed, ttl)
}

// LookupA is the proxy's own lookup of a name it already allowed: the
// upstream through the same cache, without the addresses that lead inside
// the cell. It applies no allowlist (the proxy did).
func (s *Server) LookupA(ctx context.Context, host string) ([]net.IP, error) {
	s.defaults()
	answers, _, err := s.lookup(ctx, dns.Question{Name: dns.Fqdn(host), Qtype: dns.TypeA, Qclass: dns.ClassINET})
	if err != nil {
		return nil, err
	}
	var out []net.IP
	for _, rr := range answers {
		if a, ok := rr.(*dns.A); ok {
			out = append(out, a.A)
		}
	}
	return out, nil
}

// ForgetClaim drops a removed claim's answers; its query log stays until
// Prune, so the agent can still read it.
func (s *Server) ForgetClaim(claimID string) { s.Answers.ForgetClaim(claimID) }
