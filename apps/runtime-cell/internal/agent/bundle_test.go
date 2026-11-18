package agent

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

type deniedStub map[string][]DeniedEgress

func (d deniedStub) Denied(claimID string) []DeniedEgress { return d[claimID] }

// A setup that did not boot carries why: the boot's own output (a build's
// log, where "DNS lookup error" is) and the hosts the egress refused this
// claim, which the product's catalog offers to approve.
func TestASetupBundleCarriesTheBootOutputAndTheDeniedEgress(t *testing.T) {
	at := time.Date(2026, 11, 4, 16, 44, 0, 0, time.UTC)
	build := "compose_up: build app: docker run --rm ...: exit status 1\n#13 [stage-9 2/9] RUN apk add bash\n" +
		"0.492 WARNING: fetching https://dl-cdn.alpinelinux.org/alpine/v3.21/community: DNS lookup error\n" +
		"error: failed to solve: exit code: 4"
	h := newHarness(t, func(c *Config) {
		c.Transport = stubTransport{upload: errors.New(build)}
		c.DeniedEgress = deniedStub{"claim-b": {{Host: "dl-cdn.alpinelinux.org", Port: 53, At: at}, {Host: "bad", Port: 0, At: at}}}
	})
	body := h.acquireBody()
	body.Consumer, body.HardExpiresAt = protocol.ConsumerSetup, protocol.FormatTime(h.clk.Now().Add(40*time.Minute))
	if err := h.handle("claim-b", protocol.MessageTypeClaimAcquire, body); err != nil {
		t.Fatal(err)
	}
	f := h.conn.next(t, isFailed).(*protocol.ClaimFailedBody)
	if f.Bundle == nil {
		t.Fatalf("no bundle: %+v", f)
	}
	var out *protocol.ClaimFailedBodyBundleServicesItem
	for i := range f.Bundle.Services {
		if f.Bundle.Services[i].Name == bootOutputService {
			out = &f.Bundle.Services[i]
		}
	}
	if out == nil || len(out.LogTail) != 4 || !strings.Contains(out.LogTail[2], "DNS lookup error") {
		t.Fatalf("boot output %+v", f.Bundle.Services)
	}
	if d := f.Bundle.DeniedEgress; len(d) != 1 || d[0].Host != "dl-cdn.alpinelinux.org" || d[0].Port != 53 {
		t.Fatalf("denied egress %+v", d)
	}
}

// A Run's boot that failed carries the hosts the egress refused its claim,
// structured, so the product reads a boot stopped by a denied host as the
// "approve this host" blocker, never as the PR's regression. Nothing else
// of the PR's workload (its logs, its services) goes in the bundle.
func TestARunsFailedBootCarriesOnlyItsDeniedEgress(t *testing.T) {
	at := time.Date(2026, 11, 18, 9, 0, 0, 0, time.UTC)
	h := newHarness(t, func(c *Config) {
		c.Transport = stubTransport{upload: errors.New("compose_up: npm ERR! getaddrinfo ENOTFOUND registry.example.test")}
		c.DeniedEgress = deniedStub{"claim-r": {{Host: "registry.example.test", Port: 443, At: at}}}
	})
	body := h.acquireBody()
	if body.Consumer == protocol.ConsumerSetup {
		t.Fatal("the harness acquires a setup claim")
	}
	if err := h.handle("claim-r", protocol.MessageTypeClaimAcquire, body); err != nil {
		t.Fatal(err)
	}
	f := h.conn.next(t, isFailed).(*protocol.ClaimFailedBody)
	if f.Bundle == nil {
		t.Fatalf("no bundle: %+v", f)
	}
	if d := f.Bundle.DeniedEgress; len(d) != 1 || d[0].Host != "registry.example.test" || d[0].Port != 443 {
		t.Fatalf("denied egress %+v", d)
	}
	if len(f.Bundle.Services) != 0 || len(f.Bundle.Ports) != 0 || len(f.Bundle.Disk) != 0 {
		t.Fatalf("a Run's bundle carries its workload: %+v", f.Bundle)
	}

	// With nothing denied, a Run's failure carries no bundle, as before.
	h2 := newHarness(t, func(c *Config) {
		c.Transport = stubTransport{upload: errors.New("compose_up: exit status 1")}
		c.DeniedEgress = deniedStub{}
	})
	if err := h2.handle("claim-q", protocol.MessageTypeClaimAcquire, h2.acquireBody()); err != nil {
		t.Fatal(err)
	}
	if f := h2.conn.next(t, isFailed).(*protocol.ClaimFailedBody); f.Bundle != nil {
		t.Fatalf("a bundle with nothing denied: %+v", f.Bundle)
	}
}
