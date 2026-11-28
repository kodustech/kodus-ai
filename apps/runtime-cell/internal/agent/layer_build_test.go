//go:build unix

package agent

import (
	"context"
	"errors"
	"io"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver/fake"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/guest"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

var (
	layerKey    = strings.Repeat("a", 64)
	layerDigest = strings.Repeat("c", 64)
	imageDigest = "sha256:" + strings.Repeat("d", 64)
)

// scriptedGuest serves each sandbox.op exec of a machine from a function:
// the install and the audit of a layer build, with no machine behind them.
func scriptedGuest(ctx context.Context, exec func(cmd string) protocol.SandboxExecResult) io.ReadWriteCloser {
	cell, machine := net.Pipe()
	go func() {
		defer machine.Close()
		for {
			frame, err := guest.ReadFrame(machine)
			if err != nil {
				return
			}
			m, err := protocol.Decode(frame)
			if err != nil {
				return
			}
			b, ok := m.Body.(*protocol.SandboxOpBody)
			if !ok {
				return
			}
			res := protocol.SandboxResult{Ok: true}
			switch b.Op.Op {
			case protocol.SandboxOpKindStat:
				typ := protocol.SandboxEntryTypeDir
				res.Type = &typ
			case protocol.SandboxOpKindExec:
				e := exec(*b.Op.Command)
				res.Exec = &e
			default: // the cell under test sends only stat and exec here
			}
			out, _ := protocol.Encode(protocol.Header{ID: guest.NewID(), Re: m.Envelope.ID, CellID: m.Envelope.CellID}, &protocol.GuestResultBody{StepID: b.StepID, Result: res})
			if err := guest.WriteFrame(machine, out); err != nil {
				return
			}
		}
	}()
	return cell
}

// layerFake is the driver's tool layers and its sandboxes for the agent's
// tests: it records what the agent asks and answers from what a test sets.
type layerFake struct {
	driver.Sandboxer
	digest string

	mu        sync.Mutex
	requests  []driver.SandboxRequest
	states    map[string][]driver.ToolLayerState // by machine
	events    []string                           // "ingest", in order with the seal
	ingested  []driver.ToolLayerIntegrity
	ingestErr error
	checkErr  error
	admit     error
	ends      []bool
	purged    []string
	purgeErr  error
	exec      func(cmd string) protocol.SandboxExecResult
	commands  []string
	// answers to the next sandbox of each kind
	wantStates []driver.ToolLayerState
}

func (l *layerFake) CreateSandbox(ctx context.Context, req driver.SandboxRequest) (driver.MachineRef, error) {
	ref, err := l.Sandboxer.CreateSandbox(ctx, req)
	if err != nil {
		return ref, err
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	l.requests = append(l.requests, req)
	if l.states == nil {
		l.states = map[string][]driver.ToolLayerState{}
	}
	l.states[ref.MachineID] = l.wantStates
	return ref, nil
}

func (l *layerFake) DialGuest(ctx context.Context, ref driver.MachineRef) (io.ReadWriteCloser, error) {
	return scriptedGuest(ctx, func(cmd string) protocol.SandboxExecResult {
		l.mu.Lock()
		l.commands = append(l.commands, cmd)
		f := l.exec
		l.mu.Unlock()
		if f == nil {
			return protocol.SandboxExecResult{}
		}
		return f(cmd)
	}), nil
}

func (l *layerFake) ImageDigest() string                    { return l.digest }
func (l *layerFake) CheckBuild(driver.ToolLayerBuild) error { return l.checkErr }
func (l *layerFake) States(ref driver.MachineRef) []driver.ToolLayerState {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.states[ref.MachineID]
}

func (l *layerFake) BeginBuild(_, _ string) (func(bool), error) {
	if l.admit != nil {
		return nil, l.admit
	}
	var once sync.Once
	return func(failed bool) {
		once.Do(func() {
			l.mu.Lock()
			l.ends = append(l.ends, failed)
			l.mu.Unlock()
		})
	}, nil
}

func (l *layerFake) Ingest(_ context.Context, _ string, _ driver.MachineRef, _ driver.ToolLayerBuild, in driver.ToolLayerIntegrity) (driver.ToolLayerBuilt, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.events = append(l.events, "ingest")
	l.ingested = append(l.ingested, in)
	if l.ingestErr != nil {
		return driver.ToolLayerBuilt{}, l.ingestErr
	}
	return driver.ToolLayerBuilt{Digest: layerDigest, Bytes: 4096, Unsigned: in.SignaturesMissing}, nil
}

func (l *layerFake) PurgeOrg(org string) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.purged = append(l.purged, org)
	return l.purgeErr
}

func (l *layerFake) endsSeen() []bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]bool(nil), l.ends...)
}

func newLayerHarness(t *testing.T, digest string) (*harness, *layerFake) {
	t.Helper()
	lf := &layerFake{digest: digest}
	h := newHarness(t, func(c *Config) {
		lf.Sandboxer = fake.Sandboxes{Driver: c.Driver.(*fake.Driver), Root: t.TempDir()}
		c.Parts.Sandboxes = lf
		c.Parts.ToolLayers = lf
	})
	return h, lf
}

func layerBuildBody(h *harness) *protocol.SandboxAcquireBody {
	b := h.sandboxBody("org-a")
	b.EgressAllow = []string{"github.com", "evil.example"}
	b.LayerBuild = &protocol.SandboxAcquireBodyLayerBuild{
		Key: layerKey, ID: "some-cli", Installer: protocol.SandboxAcquireBodyLayerBuildInstallerNpm,
		Argv: []string{"npm", "install", "-g", "--ignore-scripts", "some-cli@1.2.3"}, Binary: "some-cli", Registry: "registry.npmjs.org",
	}
	return b
}

func isBuilt(f any) bool { _, ok := f.(*protocol.ToollayerBuiltBody); return ok }
func isLFail(f any) bool { _, ok := f.(*protocol.ToollayerFailedBody); return ok }
func ptr[T any](v T) *T  { return &v }

// The hello names toolLayers and the image digest only when the cell has a
// digest for its sandbox image (U6): no digest, no layers.
func TestHelloAnnouncesToolLayersOnlyWithAnImageDigest(t *testing.T) {
	for _, digest := range []string{imageDigest, ""} {
		h, _ := newLayerHarness(t, digest)
		hello := h.a.Hello()
		has := false
		for _, f := range hello.Features {
			has = has || f == protocol.FeatureToolLayers
		}
		if has != (digest != "") {
			t.Fatalf("digest %q: features %v", digest, hello.Features)
		}
		got := ""
		if hello.Capabilities != nil && hello.Capabilities.SandboxImageDigest != nil {
			got = *hello.Capabilities.SandboxImageDigest
		}
		if got != digest {
			t.Fatalf("digest %q announced as %q", digest, got)
		}
		if _, err := protocol.Encode(protocol.Header{ID: "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b", CellID: "cell-1"}, hello); err != nil {
			t.Fatalf("the cell refuses to send its own hello: %v", err)
		}
	}
}

// A review's layers reach the driver as asked, never from a blank pool
// sandbox (made before the claim asked), and claim.ready answers each one.
func TestAReviewsLayersAreAnsweredHitOrMissInClaimReady(t *testing.T) {
	h, lf := newLayerHarness(t, imageDigest)
	lf.wantStates = []driver.ToolLayerState{
		{ID: "some-cli", Hit: true, Digest: layerDigest, BinaryPath: "/opt/kcli/some-cli/.local/bin/some-cli", Interpreter: "node"},
		{ID: "other-cli", Reason: "no_key", Build: true},
	}
	body := h.sandboxBody("org-a")
	body.ToolLayers = []protocol.SandboxAcquireBodyToolLayersItem{{Key: layerKey, ID: "some-cli"}, {Key: strings.Repeat("b", 64), ID: "other-cli"}}
	if err := h.handle("sbx-l1", protocol.MessageTypeSandboxAcquire, body); err != nil {
		t.Fatal(err)
	}
	ready := h.conn.next(t, isReady).(*protocol.ClaimReadyBody)
	if len(ready.ToolLayers) != 2 {
		t.Fatalf("toolLayers %+v", ready.ToolLayers)
	}
	hit, miss := ready.ToolLayers[0], ready.ToolLayers[1]
	if hit.ID != "some-cli" || hit.State != protocol.ClaimReadyBodyToolLayersItemStateHit || *hit.Digest != layerDigest || *hit.Interpreter != "node" || *hit.BinaryPath != "/opt/kcli/some-cli/.local/bin/some-cli" || hit.Reason != nil {
		t.Fatalf("hit %+v", hit)
	}
	if miss.State != protocol.ClaimReadyBodyToolLayersItemStateMiss || *miss.Reason != "no_key" || miss.Build == nil || !*miss.Build || miss.BinaryPath != nil {
		t.Fatalf("miss %+v", miss)
	}
	lf.mu.Lock()
	defer lf.mu.Unlock()
	if len(lf.requests) != 1 || len(lf.requests[0].ToolLayers) != 2 || lf.requests[0].ToolLayers[0] != (driver.ToolLayerRef{Key: layerKey, ID: "some-cli"}) || lf.requests[0].Build != nil {
		t.Fatalf("driver request %+v", lf.requests)
	}
	if _, err := protocol.Encode(protocol.Header{ID: "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b", CellID: "cell-1", ClaimID: "sbx-l1"}, ready); err != nil {
		t.Fatalf("claim.ready does not pass the cell's own encoder: %v", err)
	}
}

// A sandbox that asks for no layer answers none, as before.
func TestASandboxWithoutLayersAnswersNone(t *testing.T) {
	h, _ := newLayerHarness(t, imageDigest)
	if ready := h.sandboxReady("sbx-l2", "org-a"); ready.ToolLayers != nil {
		t.Fatalf("toolLayers %+v", ready.ToolLayers)
	}
}

// A cell that keeps no layers refuses the fields instead of ignoring them.
func TestACellWithoutToolLayersRefusesTheFields(t *testing.T) {
	h, _ := newSandboxHarness(t, 0)
	body := h.sandboxBody("org-a")
	body.ToolLayers = []protocol.SandboxAcquireBodyToolLayersItem{{Key: layerKey, ID: "x"}}
	if got := nackCode(h.handle("sbx-l3", protocol.MessageTypeSandboxAcquire, body)); got != "not_supported" {
		t.Fatalf("toolLayers: %q", got)
	}
	if got := nackCode(h.handle("sbx-l4", protocol.MessageTypeSandboxAcquire, layerBuildBody(h))); got != "not_supported" {
		t.Fatalf("layerBuild: %q", got)
	}
}

func goodExec(cmd string) protocol.SandboxExecResult {
	if strings.Contains(cmd, "audit signatures") {
		return protocol.SandboxExecResult{Stdout: `{"invalid":[],"missing":[]}`}
	}
	return protocol.SandboxExecResult{}
}

// The builder runs the install in the clean sandbox, audits signatures,
// seals the egress, and only then reads the layer out; it reports the layer
// with no content and the claim ends. It reached its registry host and no
// other, and nothing of the frame's own allow list.
func TestALayerBuilderInstallsAuditsSealsAndIngests(t *testing.T) {
	h, lf := newLayerHarness(t, imageDigest)
	lf.exec = goodExec
	body := layerBuildBody(h)
	if err := h.handle("sbx-b1", protocol.MessageTypeSandboxAcquire, body); err != nil {
		t.Fatal(err)
	}
	h.conn.next(t, isReady)
	built := h.conn.next(t, isBuilt).(*protocol.ToollayerBuiltBody)
	if built.Key != layerKey || built.ID != "some-cli" || built.Digest != layerDigest || built.Bytes != 4096 {
		t.Fatalf("built %+v", built)
	}
	if _, err := protocol.Encode(protocol.Header{ID: "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b", CellID: "cell-1", ClaimID: "sbx-b1"}, built); err != nil {
		t.Fatalf("toollayer.built does not pass the cell's own encoder: %v", err)
	}

	lf.mu.Lock()
	cmds := append([]string(nil), lf.commands...)
	reqs := append([]driver.SandboxRequest(nil), lf.requests...)
	lf.mu.Unlock()
	if len(reqs) != 1 || reqs[0].Build == nil || reqs[0].Build.Registry != "registry.npmjs.org" || len(reqs[0].ToolLayers) != 0 || reqs[0].CellTrust {
		t.Fatalf("driver request %+v", reqs)
	}
	if len(cmds) != 2 {
		t.Fatalf("commands %q", cmds)
	}
	install, audit := cmds[0], cmds[1]
	for _, want := range []string{"'npm' 'install' '-g' '--ignore-scripts' 'some-cli@1.2.3'", "/usr/bin/env -i ", "NPM_CONFIG_PREFIX=/opt/kcli/some-cli/.local", "HOME=/workspace/.kcli/some-cli", "NPM_CONFIG_REGISTRY=https://registry.npmjs.org/", "/usr/bin/timeout -k 5 300"} {
		if !strings.Contains(install, want) {
			t.Errorf("install lacks %q:\n%s", want, install)
		}
	}
	if !strings.Contains(audit, "npm audit signatures --json --prefix '/opt/kcli/some-cli/.local/lib'") {
		t.Errorf("audit:\n%s", audit)
	}

	// The builder's whole egress is its registry host: nothing from the frame's list, then nothing at all.
	h.egress.mu.Lock()
	applied := append([]ClaimInfo(nil), h.egress.applied...)
	h.egress.mu.Unlock()
	if len(applied) < 2 {
		t.Fatalf("%d policies pushed", len(applied))
	}
	if first := applied[0]; strings.Join(first.ExtraAllow, ",") != "registry.npmjs.org" || len(first.OrgSecrets) != 0 || first.Sealed {
		t.Fatalf("first policy %+v", first)
	}
	if last := applied[len(applied)-1]; !last.Sealed {
		t.Fatal("the builder was not sealed before its layer was read out")
	}
	if ends := lf.endsSeen(); len(ends) != 1 || ends[0] {
		t.Fatalf("build admission ended %v, want one clean end", ends)
	}
	// The claim ends by itself: its machine is gone and its egress removed.
	deadline := time.Now().Add(5 * time.Second)
	for len(h.egress.removedIDs()) == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if got := h.egress.removedIDs(); len(got) != 1 || got[0] != "sbx-b1" {
		t.Fatalf("removed %v", got)
	}
}

// A builder is never handed a secret, whatever the frame says.
func TestALayerBuilderTakesNoSecrets(t *testing.T) {
	h, lf := newLayerHarness(t, imageDigest)
	lf.exec = goodExec
	body := layerBuildBody(h)
	body.Secrets = []protocol.ClaimAcquireBodySecretsItem{{ID: "npm_token", Name: "NPM_TOKEN", Hosts: []string{"npm.corp.example"}}}
	if err := h.handle("sbx-b2", protocol.MessageTypeSandboxAcquire, body); err != nil {
		t.Fatal(err)
	}
	h.conn.next(t, isBuilt)
	h.egress.mu.Lock()
	defer h.egress.mu.Unlock()
	for _, p := range h.egress.applied {
		if len(p.OrgSecrets) != 0 || p.CellTrusted {
			t.Fatalf("a builder policy carries secrets: %+v", p)
		}
	}
	lf.mu.Lock()
	defer lf.mu.Unlock()
	if lf.requests[0].CellTrust {
		t.Fatal("a builder asked for the cell's trust files")
	}
}

// No caller gets a shell or a frame on a builder: sandbox.op and egress.policy are refused.
func TestNoCallerGetsSandboxOpOrAnEgressPolicyOnABuilder(t *testing.T) {
	h, lf := newLayerHarness(t, imageDigest)
	block := make(chan struct{})
	lf.exec = func(cmd string) protocol.SandboxExecResult { <-block; return goodExec(cmd) }
	t.Cleanup(func() { close(block) })
	if err := h.handle("sbx-b3", protocol.MessageTypeSandboxAcquire, layerBuildBody(h)); err != nil {
		t.Fatal(err)
	}
	h.conn.next(t, isReady)
	op := &protocol.SandboxOpBody{StepID: "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b", Op: protocol.SandboxOp{Op: protocol.SandboxOpKindExec, Command: ptr("id"), TimeoutMs: ptr(int64(1000))}}
	if got := nackCode(h.handle("sbx-b3", protocol.MessageTypeSandboxOp, op)); got != "not_supported" {
		t.Fatalf("sandbox.op: %q", got)
	}
	pol := &protocol.EgressPolicyBody{Allow: []string{"evil.example"}, IssuedAt: protocol.FormatTime(h.clk.Now())}
	if got := nackCode(h.handle("sbx-b3", protocol.MessageTypeEgressPolicy, pol)); got != "not_supported" {
		t.Fatalf("egress.policy: %q", got)
	}
	sealed := true
	if got := nackCode(h.handle("sbx-b3", protocol.MessageTypeEgressPolicy, &protocol.EgressPolicyBody{Allow: []string{}, IssuedAt: protocol.FormatTime(h.clk.Now()), Sealed: &sealed})); got != "not_supported" {
		t.Fatalf("a seal from the hub: %q", got)
	}
}

// The cell re-validates the plan: what the driver's check refuses never
// becomes a claim, and the admission is not taken.
func TestABuilderWithARefusedPlanIsNackedBeforeAnything(t *testing.T) {
	h, lf := newLayerHarness(t, imageDigest)
	lf.checkErr = errors.New("every package must pin an exact version")
	if got := nackCode(h.handle("sbx-b4", protocol.MessageTypeSandboxAcquire, layerBuildBody(h))); got != "invalid_body" {
		t.Fatalf("nack %q", got)
	}
	if _, ok := h.a.claims.Get("sbx-b4"); ok || len(h.drv.Machines()) != 0 {
		t.Fatal("a claim or a machine was made for a refused plan")
	}
	lf.checkErr = nil
	lf.admit = &driver.ErrBuildRefused{Reason: "recent_failure"}
	if got := nackCode(h.handle("sbx-b5", protocol.MessageTypeSandboxAcquire, layerBuildBody(h))); got != "layer_build_refused" {
		t.Fatalf("nack %q", got)
	}
	if len(h.drv.Machines()) != 0 {
		t.Fatal("a machine was made for a refused admission")
	}
}

// A cell with no egress control cannot hold a builder to its registry.
func TestABuilderNeedsEgressControl(t *testing.T) {
	lf := &layerFake{digest: imageDigest}
	h := newHarness(t, func(c *Config) {
		lf.Sandboxer = fake.Sandboxes{Driver: c.Driver.(*fake.Driver), Root: t.TempDir()}
		c.Parts.Sandboxes, c.Parts.ToolLayers, c.Egress = lf, lf, nil
	})
	if got := nackCode(h.handle("sbx-b6", protocol.MessageTypeSandboxAcquire, layerBuildBody(h))); got != "egress_unavailable" {
		t.Fatalf("nack %q", got)
	}
}

// Each way a build fails is reported as a short code and never loops: the
// layer is not read out when the install or the audit refused it.
func TestAFailedBuildIsReportedAsACodeAndReadsNothingOut(t *testing.T) {
	for name, c := range map[string]struct {
		exec   func(cmd string) protocol.SandboxExecResult
		ingest error
		reason string
		read   bool
	}{
		"install exits": {exec: func(string) protocol.SandboxExecResult {
			return protocol.SandboxExecResult{ExitCode: 1, Stderr: "npm ERR! secret-looking /home/x"}
		}, reason: "install_exit"},
		"install times out": {exec: func(string) protocol.SandboxExecResult { return protocol.SandboxExecResult{TimedOut: true} }, reason: "install_timeout"},
		"invalid signature": {exec: func(cmd string) protocol.SandboxExecResult {
			if strings.Contains(cmd, "audit signatures") {
				return protocol.SandboxExecResult{ExitCode: 1, Stdout: `{"invalid":[{"name":"x","version":"1.0.0"}],"missing":[]}`}
			}
			return protocol.SandboxExecResult{}
		}, reason: "invalid_signature"},
		"audit unreadable": {exec: func(cmd string) protocol.SandboxExecResult {
			if strings.Contains(cmd, "audit signatures") {
				return protocol.SandboxExecResult{ExitCode: 1, Stdout: "npm ERR! crashed"}
			}
			return protocol.SandboxExecResult{}
		}, reason: "signature_audit_failed"},
		"the store refuses": {exec: goodExec, ingest: &driver.ToolLayerError{Reason: "symlink_absolute", Err: errors.New("x")}, reason: "symlink_absolute", read: true},
		"the store errs":    {exec: goodExec, ingest: errors.New("disk full at /var/lib/x"), reason: "ingest_failed", read: true},
	} {
		t.Run(name, func(t *testing.T) {
			h, lf := newLayerHarness(t, imageDigest)
			lf.exec, lf.ingestErr = c.exec, c.ingest
			if err := h.handle("sbx-f1", protocol.MessageTypeSandboxAcquire, layerBuildBody(h)); err != nil {
				t.Fatal(err)
			}
			h.conn.next(t, isReady)
			f := h.conn.next(t, isLFail).(*protocol.ToollayerFailedBody)
			if f.Reason != c.reason || f.Key != layerKey || f.ID != "some-cli" {
				t.Fatalf("failed %+v, want %s", f, c.reason)
			}
			if _, err := protocol.Encode(protocol.Header{ID: "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b", CellID: "cell-1", ClaimID: "sbx-f1"}, f); err != nil {
				t.Fatalf("toollayer.failed does not pass the cell's own encoder: %v", err)
			}
			lf.mu.Lock()
			read := len(lf.events) > 0
			lf.mu.Unlock()
			if read != c.read {
				t.Fatalf("layer read out: %v, want %v", read, c.read)
			}
			if ends := lf.endsSeen(); len(ends) != 1 || !ends[0] {
				t.Fatalf("admission ended %v, want one failure (the 10 minute memory)", ends)
			}
		})
	}
}

// Unsigned packages are allowed and counted (U5): the layer is kept and the count goes with it.
func TestUnsignedPackagesAreAllowedAndCounted(t *testing.T) {
	h, lf := newLayerHarness(t, imageDigest)
	lf.exec = func(cmd string) protocol.SandboxExecResult {
		if strings.Contains(cmd, "audit signatures") {
			return protocol.SandboxExecResult{ExitCode: 1, Stdout: `{"invalid":[],"missing":[{"name":"a"},{"name":"b"}]}`}
		}
		return protocol.SandboxExecResult{}
	}
	if err := h.handle("sbx-u1", protocol.MessageTypeSandboxAcquire, layerBuildBody(h)); err != nil {
		t.Fatal(err)
	}
	built := h.conn.next(t, isBuilt).(*protocol.ToollayerBuiltBody)
	if built.Unsigned == nil || *built.Unsigned != 2 {
		t.Fatalf("built %+v", built)
	}
	lf.mu.Lock()
	defer lf.mu.Unlock()
	if len(lf.ingested) != 1 || lf.ingested[0].SignaturesMissing != 2 || lf.ingested[0].SignaturesInvalid != 0 || !lf.ingested[0].LockfileIntegrity {
		t.Fatalf("integrity %+v", lf.ingested)
	}
}

// "No installed dependencies" is nothing to audit, not a failed audit; pnpm
// has no signature audit and runs none.
func TestAuditOfNothingIsNotAFailureAndPnpmRunsNone(t *testing.T) {
	in, err := parseAudit("npm error found no installed dependencies to audit", driver.ToolLayerIntegrity{})
	if err != nil || in.SignaturesInvalid != 0 {
		t.Fatalf("%+v, %v", in, err)
	}
	h, lf := newLayerHarness(t, imageDigest)
	lf.exec = goodExec
	b := layerBuildBody(h)
	b.LayerBuild.Installer = protocol.SandboxAcquireBodyLayerBuildInstallerPnpm
	b.LayerBuild.Argv = []string{"pnpm", "add", "-g", "some-cli@1.2.3"}
	if err := h.handle("sbx-p1", protocol.MessageTypeSandboxAcquire, b); err != nil {
		t.Fatal(err)
	}
	h.conn.next(t, isBuilt)
	lf.mu.Lock()
	defer lf.mu.Unlock()
	if len(lf.commands) != 1 || strings.Contains(lf.commands[0], "audit") {
		t.Fatalf("commands %q", lf.commands)
	}
}

// A builder released before its result went out did not build: the
// admission remembers the failure.
func TestABuilderReleasedBeforeItsResultCountsAsFailed(t *testing.T) {
	h, lf := newLayerHarness(t, imageDigest)
	block := make(chan struct{})
	lf.exec = func(cmd string) protocol.SandboxExecResult { <-block; return protocol.SandboxExecResult{ExitCode: 1} }
	if err := h.handle("sbx-r1", protocol.MessageTypeSandboxAcquire, layerBuildBody(h)); err != nil {
		t.Fatal(err)
	}
	h.conn.next(t, isReady)
	if err := h.handle("sbx-r1", protocol.MessageTypeClaimRelease, &protocol.ClaimReleaseBody{}); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for len(lf.endsSeen()) == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	close(block)
	if ends := lf.endsSeen(); len(ends) != 1 || !ends[0] {
		t.Fatalf("admission ended %v", ends)
	}
}

// scripts built for the guest quote every word and run inside the layer's prefix only.
func TestTheBuildScriptsQuoteEveryWord(t *testing.T) {
	spec := driver.ToolLayerBuild{ID: "some-cli", Installer: "npm", Argv: []string{"npm", "install", "x@1.0.0"}, Registry: "registry.npmjs.org"}
	if got := installScript(spec); !strings.Contains(got, "cd '/opt/kcli/some-cli'") || strings.Contains(got, "$") {
		t.Fatalf("script:\n%s", got)
	}
	if got := sq("it's"); got != `'it'\''s'` {
		t.Fatalf("sq %q", got)
	}
	local := auditScript(spec)
	if !strings.Contains(local, "--prefix '/opt/kcli/some-cli'") {
		t.Fatalf("a local install audits the prefix: %s", local)
	}
}
