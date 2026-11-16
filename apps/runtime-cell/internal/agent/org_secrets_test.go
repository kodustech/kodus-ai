//go:build unix

package agent

import (
	"context"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver/fake"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

var orgSecretsSample = []protocol.ClaimAcquireBodySecretsItem{
	{ID: "npm_token", Name: "NPM_TOKEN", Hosts: []string{"npm.corp.example"}},
	{ID: "payments_key", Name: "PAYMENTS_KEY", Hosts: []string{"api.payments.example"}},
}

func (r *recEgress) last(claimID string) ClaimInfo {
	r.mu.Lock()
	defer r.mu.Unlock()
	for i := len(r.applied) - 1; i >= 0; i-- {
		if r.applied[i].ClaimID == claimID {
			return r.applied[i]
		}
	}
	return ClaimInfo{}
}

// Each claim's policy carries the org's secrets with a placeholder of its
// own: the same secret on two claims never has the same placeholder.
func TestEachClaimSignsTheOrgSecretsWithItsOwnPlaceholders(t *testing.T) {
	h, _ := newSandboxHarness(t, 0)
	for _, id := range []string{"sbx-1", "sbx-2"} {
		b := h.sandboxBody("org-a")
		b.Secrets = orgSecretsSample
		if err := h.handle(id, protocol.MessageTypeSandboxAcquire, b); err != nil {
			t.Fatal(err)
		}
		h.conn.next(t, isReady)
	}
	one, two := h.egress.last("sbx-1").OrgSecrets, h.egress.last("sbx-2").OrgSecrets
	if len(one) != 2 || len(two) != 2 {
		t.Fatalf("policy secrets %+v / %+v", one, two)
	}
	for i := range one {
		if !policy.ValidPlaceholder(one[i].Placeholder) || one[i].Placeholder == two[i].Placeholder {
			t.Fatalf("placeholders %q and %q", one[i].Placeholder, two[i].Placeholder)
		}
		if one[i].ID != orgSecretsSample[i].ID || strings.Join(one[i].Hosts, ",") != orgSecretsSample[i].Hosts[0] {
			t.Fatalf("secret %+v", one[i])
		}
	}
}

// A sandbox command finds each secret's placeholder under the secret's name,
// the same one the policy signed; a name the caller sets itself is the
// caller's.
func TestASandboxCommandSeesTheSecretsPlaceholderUnderItsName(t *testing.T) {
	h, _ := newSandboxHarness(t, 0)
	b := h.sandboxBody("org-a")
	b.Secrets = orgSecretsSample
	if err := h.handle("sbx-1", protocol.MessageTypeSandboxAcquire, b); err != nil {
		t.Fatal(err)
	}
	h.conn.next(t, isReady)
	signed := h.egress.last("sbx-1").OrgSecrets[0].Placeholder
	// The guest agent masks every env value in what a command prints, so
	// the command compares instead of printing.
	cmd := `test "$NPM_TOKEN" = "` + signed + `" && echo same; echo "$PAYMENTS_KEY" | cut -c1-4`
	r := h.op("sbx-1", protocol.SandboxOp{Op: protocol.SandboxOpKindExec, Command: str(cmd), TimeoutMs: i64(5000)})
	if r.Sandbox == nil || r.Sandbox.Exec == nil || r.Sandbox.Exec.Stdout != "same\nkph_\n" {
		t.Fatalf("exec %+v", r.Sandbox)
	}
	own := h.op("sbx-1", protocol.SandboxOp{Op: protocol.SandboxOpKindExec, Command: str(`echo "$NPM_TOKEN"`), Env: map[string]string{"NPM_TOKEN": "mine"}, TimeoutMs: i64(5000)})
	if own.Sandbox == nil || own.Sandbox.Exec == nil || own.Sandbox.Exec.Stdout != "mine\n" {
		t.Fatalf("caller env %+v", own.Sandbox)
	}
}

// A secret the machine's tooling owns the name of, or whose every host the
// platform denies, is never handed to the claim: not in its env, not in its
// policy. The others are.
func TestASecretWithAReservedNameOrOnlyDeniedHostsIsDropped(t *testing.T) {
	h := newHarness(t, func(c *Config) {
		c.Parts.Sandboxes = fake.Sandboxes{Driver: c.Driver.(*fake.Driver), Root: t.TempDir()}
		c.SecretHostDenied = func(host string) bool { return host == "metadata.internal.example" }
	})
	b := h.sandboxBody("org-a")
	b.Secrets = []protocol.ClaimAcquireBodySecretsItem{
		orgSecretsSample[0],
		{ID: "path", Name: "PATH", Hosts: []string{"npm.corp.example"}},
		{ID: "kodus_deploy_key", Name: "KODUS_DEPLOY_KEY", Hosts: []string{"npm.corp.example"}},
		{ID: "cloud_key", Name: "CLOUD_KEY", Hosts: []string{"metadata.internal.example"}},
	}
	if err := h.handle("sbx-1", protocol.MessageTypeSandboxAcquire, b); err != nil {
		t.Fatal(err)
	}
	h.conn.next(t, isReady)
	got := h.egress.last("sbx-1").OrgSecrets
	if len(got) != 1 || got[0].ID != "npm_token" {
		t.Fatalf("policy secrets %+v", got)
	}
	r := h.op("sbx-1", protocol.SandboxOp{Op: protocol.SandboxOpKindExec, Command: str(`echo "${CLOUD_KEY:-unset} ${KODUS_DEPLOY_KEY:-unset}"; command -v sh >/dev/null && echo path-intact`), TimeoutMs: i64(5000)})
	if r.Sandbox == nil || r.Sandbox.Exec == nil || r.Sandbox.Exec.Stdout != "unset unset\npath-intact\n" {
		t.Fatalf("exec %+v", r.Sandbox)
	}
	if !strings.Contains(h.logs.String(), "claim.secrets.dropped") {
		t.Fatal("the dropped secrets were not reported")
	}
}

// Every compose service gets each secret's placeholder under its name, over
// what the compose file set for that name.
func TestComposeServicesGetTheSecretsPlaceholders(t *testing.T) {
	cp := &composer{ips: [][]string{{"172.30.0.2"}}}
	h := newHarness(t, func(c *Config) { c.Parts.Composer = cp })
	b := h.acquireBody()
	b.Expose = []protocol.Expose{{Service: "api", Port: 3000, Kind: protocol.ExposeKindHTTP}}
	b.Secrets = orgSecretsSample[:1]
	if err := h.handle("claim-1", protocol.MessageTypeClaimAcquire, b); err != nil {
		t.Fatal(err)
	}
	h.conn.next(t, isReady)
	signed := h.egress.last("claim-1").OrgSecrets[0].Placeholder
	if len(cp.files) != 1 || !regexp.MustCompile(`NPM_TOKEN: "?`+signed).Match(cp.files[0]) {
		t.Fatalf("compose file %s", cp.files)
	}
}

// A cell that pushes no egress policy has no injector to swap a
// placeholder: it does not ask for secrets.
func TestACellWithoutEgressControlTakesNoSecrets(t *testing.T) {
	h := newHarness(t, func(c *Config) { c.Egress = nil })
	for _, f := range h.a.Hello().Features {
		if f == protocol.FeatureSecrets {
			t.Fatal("secrets advertised without an egress policy")
		}
	}
}

// A placeholder the proxy refused over plain HTTP stops the claim and
// reports a security_violation blocker, as an injector alert does; until the
// proxy's feed answers, the cell takes no work.
func TestAPlaceholderLeakFromTheProxyCompromisesTheClaim(t *testing.T) {
	injectorFeed, proxyFeed := alertFeed{ch: make(chan []Alert, 1)}, alertFeed{ch: make(chan []Alert, 1)}
	h := newHarness(t, func(c *Config) { c.Alerts, c.EgressAlerts = injectorFeed, proxyFeed })
	h.a.alertSourceReadyAt(0)
	if err := h.handle("claim-0", protocol.MessageTypeClaimAcquire, h.acquireBody()); nackCode(err) != "not_accepting" {
		t.Fatalf("acquire with the proxy's feed unproven: %v", err)
	}
	h.a.alertSourceReadyAt(1)
	h.ready("claim-1")
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); h.a.watchAlerts(ctx, 1) }()
	proxyFeed.ch <- []Alert{{Seq: 1, ClaimID: "claim-1", Host: "plain.example", Kind: "placeholder_leak", At: time.Now()}}
	bl := h.conn.next(t, func(f any) bool { _, ok := f.(*protocol.BlockedBody); return ok }).(*protocol.BlockedBody)
	cancel()
	<-done
	if bl.Kind != protocol.BlockerKindSecurityViolation || bl.Signature != "placeholder_leak" || !strings.Contains(bl.Message, "plain.example") {
		t.Fatalf("blocked %+v", bl)
	}
	if code := nackCode(h.handle("claim-1", protocol.MessageTypeExec, &protocol.ExecBody{StepID: step1, Command: "id", TimeoutMs: 1000})); code != "claim_compromised" {
		t.Fatalf("a step after the leak: %q", code)
	}
}
