//go:build linux

package fcregress

import (
	"context"
	"crypto/tls"
	"encoding/base64"
	"errors"
	"io"
	"log"
	"log/slog"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/microvm"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/gitsource"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/hubclient"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/observer"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/tarball"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/testing/hubstub"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/testpki"
)

// protoCell is the cell agent on the microvm driver, connected to the hub
// stub over a real mTLS WebSocket: every step below is a protocol frame,
// as the hub sends it.
type protoCell struct {
	hub *hubstub.Hub
	t   *testing.T
}

func startProtoCell(t *testing.T, s microvm.Stack) *protoCell {
	t.Helper()
	hub := hubstub.New()
	hub.HelloAck = func() *protocol.AckBody {
		v := int64(protocol.ProtocolVersion)
		return &protocol.AckBody{Version: &v, Accepts: []string{protocol.FeatureReadyStart, protocol.FeatureSnapshots}}
	}
	ca, err := testpki.NewCA("fc-proto-ca")
	if err != nil {
		t.Fatal(err)
	}
	server, _ := ca.Issue("runtime-hub", time.Hour, "127.0.0.1")
	srv := httptest.NewUnstartedServer(hub)
	srv.Config.ErrorLog = log.New(io.Discard, "", 0)
	srv.TLS = hub.TLSConfig(server, ca.Pool())
	srv.StartTLS()
	t.Cleanup(srv.Close)
	cert, _ := ca.Issue(cellID, time.Hour)
	a, err := agent.New(agent.Config{
		CellID: cellID, Regions: []string{"local"}, Driver: s.Driver, Transport: s.Driver,
		Parts: driver.Parts{Baker: s.Driver, Resetter: s.Driver, Sandboxes: s.Driver, Snapshots: s.Driver, Sessions: s.Driver},
		Observers: func(context.Context, agent.ClaimInfo, []observer.Target) (observer.Client, error) {
			return nil, errors.New("a sandbox claim has no observer")
		},
		Repo:      func(protocol.ClaimAcquireBody) (string, error) { return "", errors.New("no repository in this test") },
		Extractor: tarball.InProcessExtractor{}, Revoker: gitsource.GitHub{},
		OrgKey:  func(org string) (string, error) { return "microvm-" + org, nil },
		WorkDir: t.TempDir(), Log: slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn})),
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = a.Run(ctx, agent.RunConfig{
			HubURL: "wss://" + strings.TrimPrefix(srv.URL, "https://") + "/v1/cell",
			TLS:    cellTLSConfig(cert, ca), HeartbeatEvery: time.Second, DeadManEvery: time.Second, Backoff: 100 * time.Millisecond, AckTimeout: 5 * time.Second,
		})
	}()
	t.Cleanup(func() { cancel(); <-done })
	select {
	case <-hub.Hellos():
	case <-time.After(10 * time.Second):
		t.Fatal("the cell never said hello")
	}
	return &protoCell{hub: hub, t: t}
}

func (p *protoCell) ctx() context.Context {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	p.t.Cleanup(cancel)
	return ctx
}

// sandbox sends sandbox.acquire and waits for claim.ready; it returns the
// ready body and the time from the frame to claim.ready.
func (p *protoCell) sandbox(claim string, edit func(*protocol.SandboxAcquireBody)) (*protocol.ClaimReadyBody, time.Duration) {
	p.t.Helper()
	b := &protocol.SandboxAcquireBody{OrgID: "org-fc", HardExpiresAt: protocol.FormatTime(time.Now().Add(40 * time.Minute))}
	if edit != nil {
		edit(b)
	}
	ctx := p.ctx()
	start := time.Now()
	if err := p.hub.Send(ctx, cellID, claim, b); err != nil {
		p.t.Fatalf("sandbox.acquire %s: %v", claim, err)
	}
	ready, err := p.hub.WaitReady(ctx, claim)
	if err != nil {
		p.t.Fatal(err)
	}
	p.t.Cleanup(func() { _ = p.hub.Send(context.Background(), cellID, claim, &protocol.ClaimReleaseBody{}) })
	return ready, time.Since(start)
}

// step sends a step frame and waits for its step.result.
func (p *protoCell) step(claim, stepID string, body any) *protocol.StepResultBody {
	p.t.Helper()
	ctx := p.ctx()
	if err := p.hub.Send(ctx, cellID, claim, body); err != nil {
		p.t.Fatalf("%T on %s: %v", body, claim, err)
	}
	e, err := p.hub.WaitFor(ctx, func(e hubstub.Event) bool {
		r, ok := e.Body.(*protocol.StepResultBody)
		return ok && r.StepID == stepID
	})
	if err != nil {
		p.t.Fatal(err)
	}
	return e.Body.(*protocol.StepResultBody)
}

func (p *protoCell) sh(claim, command string) string {
	p.t.Helper()
	step := hubclient.NewID()
	timeout := int64(60_000)
	r := p.step(claim, step, &protocol.SandboxOpBody{StepID: step, Op: protocol.SandboxOp{Op: protocol.SandboxOpKindExec, Command: &command, TimeoutMs: &timeout}})
	if r.Sandbox == nil || r.Sandbox.Exec == nil || r.Sandbox.Exec.ExitCode != 0 {
		p.t.Fatalf("%q on %s: %+v", command, claim, r.Sandbox)
	}
	return strings.TrimSpace(r.Sandbox.Exec.Stdout)
}

func (p *protoCell) snapshot(claim string, purpose protocol.ClaimSnapshotBodyPurpose) *protocol.StepResultBodySnapshot {
	p.t.Helper()
	step := hubclient.NewID()
	r := p.step(claim, step, &protocol.ClaimSnapshotBody{StepID: step, Purpose: purpose})
	if r.Snapshot == nil {
		p.t.Fatalf("claim.snapshot %s on %s: %+v", purpose, claim, r)
	}
	return r.Snapshot
}

// Through the hub protocol, end to end on real microVMs: a sandbox that
// prepares a template (the setup's step: a file in /workspace), the
// template under its key, the claim released; two sandboxes of the key
// start from it (claim.ready start template) with the file and their own
// boot ids; another org's sandbox of the key boots cold. Then one claim's
// round snapshot, and memory resets that bring the machine back to it
// (what was written after it is gone) with a new boot id every time.
func TestFirecrackerSandboxesResumeFromATemplateThroughTheHubProtocol(t *testing.T) {
	s := open(t)
	p := startProtoCell(t, s)
	key := "repo:fc-" + time.Now().Format("150405")
	_, cold := p.sandbox("tpl-setup", func(b *protocol.SandboxAcquireBody) { b.Prepares, b.TemplateKey = boolPtr(true), &key })
	content := base64.StdEncoding.EncodeToString([]byte("prepared by the setup\n"))
	step := hubclient.NewID()
	if r := p.step("tpl-setup", step, &protocol.SandboxOpBody{StepID: step, Op: protocol.SandboxOp{Op: protocol.SandboxOpKindWrite, Path: strPtr("repo/README"), Content: &content, Mkdirs: boolPtr(true)}}); r.Sandbox == nil || !r.Sandbox.Ok {
		t.Fatalf("write: %+v", r)
	}
	tplBoot := p.sh("tpl-setup", "cat /proc/sys/kernel/random/boot_id")
	tpl := p.snapshot("tpl-setup", protocol.ClaimSnapshotBodyPurposeTemplate)
	t.Logf("cold sandbox to claim.ready: %d ms; template %s: %d ms", cold.Milliseconds(), tpl.ID, tpl.Ms)
	t.Cleanup(func() { _ = s.Backend.Store().Remove("org-fc", tpl.ID) })
	if err := p.hub.Send(p.ctx(), cellID, "tpl-setup", &protocol.ClaimReleaseBody{}); err != nil {
		t.Fatal(err)
	}

	boots := map[string]bool{tplBoot: true}
	for _, claim := range []string{"tpl-use-1", "tpl-use-2"} {
		ready, took := p.sandbox(claim, func(b *protocol.SandboxAcquireBody) { b.TemplateKey = &key })
		if ready.Start == nil || *ready.Start != protocol.ClaimReadyBodyStartTemplate {
			t.Fatalf("%s started %v, not from the template", claim, ready.Start)
		}
		if got := p.sh(claim, "cat repo/README"); got != "prepared by the setup" {
			t.Fatalf("%s holds %q, not the template's file", claim, got)
		}
		boot := p.sh(claim, "cat /proc/sys/kernel/random/boot_id")
		if boots[boot] {
			t.Fatalf("%s shares the boot id %s", claim, boot)
		}
		boots[boot] = true
		t.Logf("%s from the template to claim.ready through the protocol: %d ms", claim, took.Milliseconds())
	}
	other, _ := p.sandbox("tpl-other-org", func(b *protocol.SandboxAcquireBody) { b.OrgID, b.TemplateKey = "org-fc-b", &key })
	if other.Start == nil || *other.Start != protocol.ClaimReadyBodyStartCold {
		t.Fatalf("another org's sandbox of the key started %v", other.Start)
	}

	round := p.snapshot("tpl-use-1", protocol.ClaimSnapshotBodyPurposeRound)
	t.Logf("round snapshot %s of tpl-use-1: %d ms (snapshot and restore in place)", round.ID, round.Ms)
	mac := p.sh("tpl-use-1", "cat /sys/class/net/eth0/address")
	for i := range 5 {
		p.sh("tpl-use-1", "echo dirty > repo/after-the-round")
		step := hubclient.NewID()
		start := time.Now()
		r := p.step("tpl-use-1", step, &protocol.MachineResetBody{StepID: step, Snapshot: protocol.Snapshot{Kind: protocol.SnapshotKindMemory, Ref: round.ID}})
		took := time.Since(start)
		if r.Exec != nil || r.VMHealth != protocol.VMHealthOk {
			t.Fatalf("reset %d: %+v", i, r)
		}
		if got := p.sh("tpl-use-1", "test -e repo/after-the-round && echo kept || echo gone; cat /sys/class/net/eth0/address"); got != "gone\n"+mac {
			t.Fatalf("reset %d: %q (want the round's state at MAC %s)", i, got, mac)
		}
		boot := p.sh("tpl-use-1", "cat /proc/sys/kernel/random/boot_id")
		if boots[boot] {
			t.Fatalf("reset %d shares the boot id %s", i, boot)
		}
		boots[boot] = true
		d := int64(0)
		if r.DurationMs != nil {
			d = *r.DurationMs
		}
		t.Logf("memory reset %d: %d ms on the cell, %d ms through the protocol to the step.result", i, d, took.Milliseconds())
	}
}

func cellTLSConfig(cert tls.Certificate, ca *testpki.CA) *tls.Config {
	return &tls.Config{Certificates: []tls.Certificate{cert}, RootCAs: ca.Pool(), MinVersion: tls.VersionTLS13}
}

func boolPtr(b bool) *bool    { return &b }
func strPtr(s string) *string { return &s }
