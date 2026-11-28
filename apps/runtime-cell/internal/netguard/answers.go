package netguard

import (
	"net"
	"sync"
	"time"
)

// Answers is what the cell resolver told each claim: name -> addresses, each
// with the time it stops counting. The proxy accepts a connection to an
// address the claim was handed for that name, so a CDN that rotates its
// answers between the VM's lookup and the proxy's does not turn a legitimate
// connection into ip_mismatch, and a rebinding between the two cannot point
// the proxy somewhere the VM was never sent.
type Answers struct {
	mu      sync.Mutex
	now     func() time.Time
	byClaim map[string]map[string]map[string]time.Time // claim -> name -> ip -> until
}

const (
	// minAnswerTTL and maxAnswerTTL clamp the upstream TTL: a zero TTL must
	// still cover the connect that follows the lookup, and a week-long one
	// must not pin an address after the CDN moved.
	minAnswerTTL = 30 * time.Second
	maxAnswerTTL = time.Hour
	// answerGrace covers clients that keep an address a little past its TTL
	// (JVM and Go resolvers, connection pools).
	answerGrace = 2 * time.Minute
	// maxNamesPerClaim and maxIPsPerName bound what one claim can store.
	maxNamesPerClaim = 4096
	maxIPsPerName    = 64
)

func NewAnswers(now func() time.Time) *Answers {
	if now == nil {
		now = time.Now
	}
	return &Answers{now: now, byClaim: map[string]map[string]map[string]time.Time{}}
}

// Record keeps the IPv4 addresses handed to claim for name.
func (a *Answers) Record(claim, name string, ips []net.IP, ttl time.Duration) {
	if a == nil || claim == "" || len(ips) == 0 {
		return
	}
	ttl = min(max(ttl, minAnswerTTL), maxAnswerTTL)
	now := a.now()
	until := now.Add(ttl + answerGrace)
	a.mu.Lock()
	defer a.mu.Unlock()
	names := a.byClaim[claim]
	if names == nil {
		names = map[string]map[string]time.Time{}
		a.byClaim[claim] = names
	}
	set := names[name]
	if set == nil {
		if len(names) >= maxNamesPerClaim {
			a.pruneLocked(names, now)
			if len(names) >= maxNamesPerClaim {
				return
			}
		}
		set = map[string]time.Time{}
		names[name] = set
	}
	for _, ip := range ips {
		v4 := ip.To4()
		if v4 == nil {
			continue
		}
		if _, ok := set[v4.String()]; !ok && len(set) >= maxIPsPerName {
			continue
		}
		set[v4.String()] = until
	}
}

func (a *Answers) pruneLocked(names map[string]map[string]time.Time, now time.Time) {
	for name, set := range names {
		for ip, until := range set {
			if !now.Before(until) {
				delete(set, ip)
			}
		}
		if len(set) == 0 {
			delete(names, name)
		}
	}
}

// Handed reports whether the resolver gave ip to claim for name and that
// answer still counts.
func (a *Answers) Handed(claim, name string, ip net.IP) bool {
	if a == nil || ip == nil {
		return false
	}
	v4 := ip.To4()
	if v4 == nil {
		return false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	until, ok := a.byClaim[claim][name][v4.String()]
	return ok && a.now().Before(until)
}

// ForgetClaim drops everything recorded for claim (its policy is gone).
func (a *Answers) ForgetClaim(claim string) {
	if a == nil {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	delete(a.byClaim, claim)
}
