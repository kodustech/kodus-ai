//go:build unix

package agent

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver/fake"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/machinetrust"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// trustComposer keeps whether each Up was told the machines need the cell
// CA, and the secrets it was given for its image builds.
type trustComposer struct {
	mu           sync.Mutex
	trust        []bool
	buildSecrets []map[string]string
}

func (c *trustComposer) Up(_ context.Context, req driver.UpRequest) ([]string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.trust = append(c.trust, req.CellTrust)
	c.buildSecrets = append(c.buildSecrets, req.BuildSecrets)
	return []string{"172.30.0.2"}, nil
}

func (c *trustComposer) secrets() []map[string]string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]map[string]string(nil), c.buildSecrets...)
}

func (c *trustComposer) ups() []bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]bool(nil), c.trust...)
}

// trustFiles stands in for what cmd/cell writes at start: the bundle and the
// cell CA, here two plain files the fake's guest agent points the env at.
func trustFiles(t *testing.T) machinetrust.Files {
	t.Helper()
	dir := t.TempDir()
	f := machinetrust.Files{Bundle: filepath.Join(dir, "ca-bundle.pem"), CellCA: filepath.Join(dir, "cell-ca.pem")}
	for _, p := range []string{f.Bundle, f.CellCA} {
		if err := os.WriteFile(p, []byte("pem"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return f
}

func trustHarness(t *testing.T, cellTrust bool, pool int) (*harness, *trustComposer, machinetrust.Files) {
	t.Helper()
	files, cp := trustFiles(t), &trustComposer{}
	h := newHarness(t, func(c *Config) {
		c.Parts.Sandboxes = fake.Sandboxes{Driver: c.Driver.(*fake.Driver), Root: t.TempDir(), Trust: files}
		c.SandboxPool, c.Parts.Composer, c.CellTrust = pool, cp, cellTrust
	})
	return h, cp, files
}

func (h *harness) machineTrusted(claimID string) bool {
	h.t.Helper()
	id := h.a.claimMachine(claimID).MachineID
	for _, m := range h.drv.Machines() {
		if m.Ref.MachineID == id {
			return m.CellTrust
		}
	}
	h.t.Fatalf("no machine %s", id)
	return false
}

func (h *harness) sandboxWith(claimID string, secrets []protocol.ClaimAcquireBodySecretsItem) {
	h.t.Helper()
	b := h.sandboxBody("org-a")
	b.Secrets = secrets
	if err := h.handle(claimID, protocol.MessageTypeSandboxAcquire, b); err != nil {
		h.t.Fatal(err)
	}
	h.conn.next(h.t, isReady)
}

func (h *harness) composeWith(claimID string, secrets []protocol.ClaimAcquireBodySecretsItem) {
	h.t.Helper()
	b := h.acquireBody()
	b.Expose = []protocol.Expose{{Service: "api", Port: 3000, Kind: protocol.ExposeKindHTTP}}
	b.Secrets = secrets
	if err := h.handle(claimID, protocol.MessageTypeClaimAcquire, b); err != nil {
		h.t.Fatal(err)
	}
	h.conn.next(h.t, isReady)
}

// A claim with an org secret: its sandbox and its compose services are
// booted trusting the cell CA, and a sandbox command finds the variables
// pointing at the bundle (the public roots with the cell CA).
func TestAClaimWithASecretBootsItsMachinesTrustingTheCellCA(t *testing.T) {
	h, cp, files := trustHarness(t, true, 0)
	h.sandboxWith("sbx-1", orgSecretsSample[:1])
	if !h.machineTrusted("sbx-1") {
		t.Fatal("the sandbox of a claim with a secret was not booted with the cell CA")
	}
	r := h.op("sbx-1", protocol.SandboxOp{Op: protocol.SandboxOpKindExec, Command: str(`echo "$SSL_CERT_FILE|$CURL_CA_BUNDLE|$REQUESTS_CA_BUNDLE|$GIT_SSL_CAINFO|$NODE_EXTRA_CA_CERTS"`), TimeoutMs: i64(5000)})
	want := strings.Join([]string{files.Bundle, files.Bundle, files.Bundle, files.Bundle, files.CellCA}, "|")
	if r.Sandbox == nil || r.Sandbox.Exec == nil || strings.TrimSpace(r.Sandbox.Exec.Stdout) != want {
		t.Fatalf("exec %+v, want %s", r.Sandbox, want)
	}
	h.composeWith("claim-1", orgSecretsSample[:1])
	if ups := cp.ups(); len(ups) != 1 || !ups[0] {
		t.Fatalf("compose Up told %v, want the cell CA", ups)
	}
}

// G6: a claim's image builds get its org secrets as the services do, by
// name, as the placeholder only (the injector swaps it for the value on the
// secret's hosts). They used to get nothing: the placeholders reached the
// services' environment alone, which a build never sees. Without secrets a
// build gets none.
func TestAClaimsImageBuildsGetItsSecretsAsPlaceholders(t *testing.T) {
	h, cp, _ := trustHarness(t, true, 0)
	h.composeWith("claim-1", orgSecretsSample[:1])
	h.composeWith("claim-2", nil)
	got := cp.secrets()
	if len(got) != 2 {
		t.Fatalf("ups %v", got)
	}
	c, _ := h.a.claims.Get("claim-1")
	want := map[string]string{"NPM_TOKEN": c.OrgSecrets[0].Placeholder}
	if len(got[0]) != 1 || got[0]["NPM_TOKEN"] != want["NPM_TOKEN"] || !policy.ValidPlaceholder(got[0]["NPM_TOKEN"]) {
		t.Fatalf("build secrets %v, want %v", got[0], want)
	}
	if got[1] != nil {
		t.Fatalf("a claim without secrets gave its builds %v", got[1])
	}
}

// A builder the driver says trusts the cell CA is signed as an inspect
// source (BuildTrusted); one it does not say so of stays a build source only.
func TestTheBuilderIsAnInspectSourceOnlyWhenTheDriverSaysItTrusts(t *testing.T) {
	ci := ClaimInfo{ClaimID: "claim-1", Acquire: protocol.ClaimAcquireBody{HardExpiresAt: protocol.FormatTime(time.Now().Add(time.Hour))}}
	ci.Network.Sources = []string{"10.213.0.9"}
	spec, err := PolicySpec(ci, nil, time.Now())
	if err != nil || spec.BuildTrusted || !slices.Equal(spec.BuildSources, ci.Network.Sources) {
		t.Fatalf("untrusted builder: %+v %v", spec, err)
	}
	ci.Network.SourcesTrustCellCA = true
	if spec, _ := PolicySpec(ci, nil, time.Now()); !spec.BuildTrusted {
		t.Fatal("the trusted builder is not marked BuildTrusted")
	}
}

// Without a secret, or on a cell whose driver has no trust files, the
// machines keep their own trust: nothing tells the driver to mount the CA,
// and a sandbox command sees none of the variables.
func TestAMachineWithoutSecretsGetsNoCellCA(t *testing.T) {
	for _, tc := range []struct {
		name      string
		cellTrust bool
		secrets   []protocol.ClaimAcquireBodySecretsItem
	}{
		{"no secret", true, nil},
		{"a cell without trust files", false, orgSecretsSample[:1]},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h, cp, _ := trustHarness(t, tc.cellTrust, 0)
			h.sandboxWith("sbx-1", tc.secrets)
			if h.machineTrusted("sbx-1") {
				t.Fatal("the sandbox was booted with the cell CA")
			}
			r := h.op("sbx-1", protocol.SandboxOp{Op: protocol.SandboxOpKindExec, Command: str(`echo "[$SSL_CERT_FILE$NODE_EXTRA_CA_CERTS]"`), TimeoutMs: i64(5000)})
			if r.Sandbox == nil || r.Sandbox.Exec == nil || strings.TrimSpace(r.Sandbox.Exec.Stdout) != "[]" {
				t.Fatalf("exec %+v", r.Sandbox)
			}
			h.composeWith("claim-1", tc.secrets)
			if ups := cp.ups(); len(ups) != 1 || ups[0] {
				t.Fatalf("compose Up told %v, want no cell CA", ups)
			}
		})
	}
}

// A blank pool sandbox was made before any claim, without the trust files:
// a sandbox with a secret makes its own, and leaves the blank one to a
// sandbox without secrets.
func TestASandboxWithASecretNeverTakesABlankSandbox(t *testing.T) {
	h, _, _ := trustHarness(t, true, 1)
	h.runPool()
	waitPool(t, h.a, 1)
	h.sandboxWith("sbx-secret", orgSecretsSample[:1])
	if m := h.a.claimMachine("sbx-secret"); m.Tags[driver.TagRole] == string(driver.RolePool) || !h.machineTrusted("sbx-secret") {
		t.Fatalf("the sandbox with a secret is on %s (role %s)", m.MachineID, m.Tags[driver.TagRole])
	}
	if h.a.sandboxPool.Ready() != 1 {
		t.Fatalf("the blank sandbox was taken: %d ready", h.a.sandboxPool.Ready())
	}
	h.sandboxWith("sbx-plain", nil)
	if m := h.a.claimMachine("sbx-plain"); m.Tags[driver.TagRole] != string(driver.RolePool) {
		t.Fatalf("the sandbox without secrets did not take the blank one: %s", m.Tags[driver.TagRole])
	}
}

// The trust variables are the cell's: a secret named after one is never
// handed to a machine, as the API refuses it.
func TestASecretNamedAfterATrustVariableIsDropped(t *testing.T) {
	for _, n := range machinetrust.EnvNames {
		if secretNameRefused(n) != "reserved_name" {
			t.Errorf("%s is not reserved", n)
		}
	}
}

// The inspected tier (InspectEgress): every machine the claim's own boot
// makes trusts the cell CA, secrets or not, and the claim says so, so its
// policy lists them as inspect sources. A blank pool sandbox, made before
// the claim, does not: TLS from it to an inspected host stays passthrough.
func TestInspectEgressBootsTheClaimsOwnMachinesTrustingTheCellCA(t *testing.T) {
	files, cp := trustFiles(t), &trustComposer{}
	h := newHarness(t, func(c *Config) {
		c.Parts.Sandboxes = fake.Sandboxes{Driver: c.Driver.(*fake.Driver), Root: t.TempDir(), Trust: files}
		c.SandboxPool, c.Parts.Composer, c.CellTrust, c.InspectEgress = 1, cp, true, true
	})
	h.composeWith("claim-1", nil)
	if ups := cp.ups(); len(ups) != 1 || !ups[0] {
		t.Fatalf("compose Up told %v, want the cell CA", ups)
	}
	c, _ := h.a.claims.Get("claim-1")
	ci := info(c)
	if !ci.CellTrusted {
		t.Fatal("the claim does not record its machines' trust")
	}
	ci.Network.Sources = []string{"10.213.0.250"} // the builder
	spec, err := PolicySpec(ci, nil, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if slices.Contains(spec.InspectSources, "10.213.0.250") || !slices.Contains(spec.InspectSources, "172.30.0.2") {
		t.Fatalf("inspect sources %v: the compose containers, never the builder", spec.InspectSources)
	}

	h.runPool()
	waitPool(t, h.a, 1)
	h.sandboxWith("sbx-pool", nil)
	if m := h.a.claimMachine("sbx-pool"); m.Tags[driver.TagRole] != string(driver.RolePool) {
		t.Fatalf("no blank sandbox taken: %s", m.Tags[driver.TagRole])
	}
	pc, _ := h.a.claims.Get("sbx-pool")
	if pci := info(pc); pci.CellTrusted {
		t.Fatal("a blank pool sandbox is marked as trusting the cell CA")
	} else if spec, _ := PolicySpec(pci, nil, time.Now()); len(spec.InspectSources) != 0 {
		t.Fatalf("a blank pool sandbox is an inspect source: %v", spec.InspectSources)
	}
}

// A cell whose driver's sandboxes take no trust files (microvm:
// Capabilities.SandboxCellTrust false) makes the sandbox of a claim with a
// secret without asking them, and does not count the claim trusted, so its
// TLS to an inspected host stays passthrough. It used to count it trusted
// while the machine never got the cell CA.
func TestASandboxFromADriverWithoutSandboxTrustIsNotCountedTrusted(t *testing.T) {
	files := trustFiles(t)
	h := newHarness(t, func(c *Config) {
		c.Driver.(*fake.Driver).NoSandboxCellTrust = true
		c.Parts.Sandboxes = fake.Sandboxes{Driver: c.Driver.(*fake.Driver), Root: t.TempDir(), Trust: files}
		c.CellTrust, c.InspectEgress = true, true
	})
	h.sandboxWith("sbx-1", orgSecretsSample[:1])
	if h.machineTrusted("sbx-1") {
		t.Fatal("the sandbox was asked the cell CA its driver cannot give")
	}
	c, _ := h.a.claims.Get("sbx-1")
	if info(c).CellTrusted {
		t.Fatal("a sandbox without the cell CA is counted trusted")
	}
}

// policyAtUp is a composer that reads, when Up starts, the last policy the
// agent pushed for the claim: the one a build inside Up runs under.
type policyAtUp struct {
	egress *recEgress
	mu     sync.Mutex
	seen   []ClaimInfo
}

func (p *policyAtUp) Up(_ context.Context, req driver.UpRequest) ([]string, error) {
	p.egress.mu.Lock()
	last := p.egress.applied[len(p.egress.applied)-1]
	p.egress.mu.Unlock()
	p.mu.Lock()
	p.seen = append(p.seen, last)
	p.mu.Unlock()
	return []string{"172.30.0.2"}, nil
}

// A build inside Up runs under the policy pushed before it, so that policy
// must already count the claim's machines as trusting the cell CA. On a
// microVM cell the build leaves from the workload VM itself (no builder of
// its own): with the workload not yet an inspect source, the inspected
// registries were spliced, and bun's ECH was refused there (kodus-ai's
// `bun install -g`, while pnpm, which sends no ECH, got through).
func TestThePolicyABuildRunsUnderCountsTheClaimsTrust(t *testing.T) {
	var cp *policyAtUp
	h := newHarness(t, func(c *Config) {
		cp = &policyAtUp{egress: c.Egress.(*recEgress)}
		c.Parts.Composer, c.CellTrust, c.InspectEgress = cp, true, true
	})
	h.composeWith("claim-1", nil)
	cp.mu.Lock()
	defer cp.mu.Unlock()
	if len(cp.seen) != 1 {
		t.Fatalf("Up ran %d times", len(cp.seen))
	}
	before := cp.seen[0]
	if !before.CellTrusted {
		t.Fatal("the policy a build runs under does not count the claim's machines as trusting the cell CA")
	}
	spec, err := PolicySpec(before, nil, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(spec.InspectSources, before.Workload.PrivateAddress) {
		t.Fatalf("inspect sources %v lack the workload %s during its build", spec.InspectSources, before.Workload.PrivateAddress)
	}
}
