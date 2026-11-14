package agent

import (
	"errors"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/claims"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver/fake"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/redact"
)

func TestIsolationNoneOnlyWithDevFlag(t *testing.T) {
	none := func(c *Config) { c.Driver.(*fake.Driver).Isolation = driver.IsolationNone }
	h := newHarness(t)
	cfg := h.a.cfg
	none(&cfg)
	if _, err := New(cfg); err == nil || !strings.Contains(err.Error(), `isolation "none"`) {
		t.Fatalf("isolation none without the dev flag: %v", err)
	}
	cfg.DevAllowInsecureIsolation = true
	a, err := New(cfg)
	if err != nil {
		t.Fatalf("isolation none with the dev flag: %v", err)
	}
	if !strings.Contains(h.logs.String(), "INSECURE ISOLATION") {
		t.Fatalf("no warning: %s", h.logs.String())
	}
	if a.Hello().Isolation != protocol.IsolationNone {
		t.Fatalf("hello isolation %q", a.Hello().Isolation)
	}
	// The flag never admits an unknown isolation.
	cfg.Driver.(*fake.Driver).Isolation = driver.Isolation("process")
	if _, err := New(cfg); err == nil {
		t.Fatal("unknown isolation accepted")
	}
}

// M14: the fake driver isolates nothing and says so.
func TestFakeDriverIsNotProductionIsolation(t *testing.T) {
	if iso := fake.New().Capabilities().Isolation; driver.ProductionIsolation(iso) {
		t.Fatalf("the fake driver reports %q", iso)
	}
}

func TestChosenVersion(t *testing.T) {
	v := int64(protocol.ProtocolVersion)
	if got, err := chosenVersion(&protocol.AckBody{Version: &v}); err != nil || got != v {
		t.Fatalf("supported: %d %v", got, err)
	}
	bad := v + 3
	for name, ack := range map[string]*protocol.AckBody{"nil": nil, "missing": {}, "unsupported": {Version: &bad}} {
		if _, err := chosenVersion(ack); err == nil {
			t.Errorf("%s accepted", name)
		}
	}
}

func TestFailedBodyReasonIsClippedOnARune(t *testing.T) {
	b := failedBody(errors.New(strings.Repeat("a", redact.MaxReason-1) + "é"))
	if len(b.Reason) > redact.MaxReason || !utf8.ValidString(b.Reason) {
		t.Fatalf("reason %d bytes, valid %v", len(b.Reason), utf8.ValidString(b.Reason))
	}
	mid := failedBody(errors.New(strings.Repeat("é", redact.MaxReason) + "end"))
	if len(mid.Reason) > redact.MaxReason || !utf8.ValidString(mid.Reason) {
		t.Fatalf("reason %d bytes, valid %v", len(mid.Reason), utf8.ValidString(mid.Reason))
	}
}

// A long reason keeps its start (the step) and its end (a build's error).
func TestFailedBodyKeepsTheEndOfALongReason(t *testing.T) {
	cause := "error: failed to solve: exit code: 4"
	b := failedBody(errors.New("compose_up: build app: docker run " + strings.Repeat("-v /x:/y ", 1000) + "\n" + cause))
	if len(b.Reason) > redact.MaxReason || !strings.HasPrefix(b.Reason, "compose_up: build app") || !strings.HasSuffix(b.Reason, cause) {
		t.Fatalf("reason %q", b.Reason[len(b.Reason)-80:])
	}
}

// manifestDriver is a recipe-aware Manifest source.
type manifestDriver struct {
	man protocol.Manifest
	ok  bool
}

func (m manifestDriver) Manifest(string) (protocol.Manifest, bool) { return m.man, m.ok }

type bootTimes struct{ t driver.BootTiming }

func (b bootTimes) BootTiming(string) (driver.BootTiming, bool) { return b.t, true }

func readyFor(t *testing.T, edit func(*Config)) *protocol.ClaimReadyBody {
	h := newHarness(t, edit)
	c := claims.New("claim-1", protocol.ClaimAcquireBody{ImageID: "img-acq", Expose: []protocol.Expose{{Service: "web", Port: 8080, Kind: protocol.ExposeKindHTTP}}}, h.a.log, h.clk.Now())
	return h.a.readyBody(c)
}

func TestReadyBodyTakesTheDriverManifest(t *testing.T) {
	b := readyFor(t, func(c *Config) {
		c.Manifests = manifestDriver{ok: true, man: protocol.Manifest{
			Services: []protocol.ManifestService{{Name: "app", Health: protocol.ServiceHealthOk}, {Name: "db", Health: protocol.ServiceHealthOk}},
			Expose:   []protocol.Expose{{Service: "app", Port: 3000, Kind: protocol.ExposeKindHTTP}},
			SeedSha:  "abc",
		}}
	})
	if len(b.Manifest.Expose) != 1 || b.Manifest.Expose[0].Service != "app" || b.Manifest.Expose[0].Port != 3000 {
		t.Fatalf("expose from claim.acquire, not the recipe: %+v", b.Manifest.Expose)
	}
	if len(b.Manifest.Services) != 2 || b.Manifest.SeedSha != "abc" || b.Manifest.ImageID != "img-acq" {
		t.Fatalf("manifest %+v", b.Manifest)
	}
}

func TestReadyBodyFallsBackToTheAcquireExpose(t *testing.T) {
	for name, edit := range map[string]func(*Config){
		"no Manifests":     func(*Config) {},
		"Manifest unknown": func(c *Config) { c.Manifests = manifestDriver{} },
	} {
		b := readyFor(t, edit)
		if len(b.Manifest.Expose) != 1 || b.Manifest.Expose[0].Service != "web" || b.Manifest.SeedSha != "unknown" {
			t.Fatalf("%s: %+v", name, b.Manifest)
		}
	}
}

func TestReadyTimingCarriesPrepareAndBootPhases(t *testing.T) {
	r := readyFor(t, func(c *Config) {
		c.BootTimes = bootTimes{driver.BootTiming{Kind: "boot", TotalMs: 3500, BuildMs: 100, UpMs: 2900, SeedMs: 200, ReadyMs: 300}}
	})
	tm := r.Timing
	if tm == nil || tm.BootMs == nil || *tm.BootMs != 3500 || *tm.BuildMs != 100 || *tm.UpMs != 2900 || *tm.SeedMs != 200 || *tm.ReadyMs != 300 {
		t.Fatalf("timing %+v", tm)
	}
	if tm.SnapshotMs != nil {
		t.Fatalf("a boot that took no snapshot reports snapshotMs %d", *tm.SnapshotMs)
	}
	r.Observer.ID = "obs-1"
	if _, err := protocol.Encode(protocol.Header{ID: "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b", CellID: "c", ClaimID: "claim-1"}, r); err != nil {
		t.Fatal(err)
	}
	// A boot that took the data snapshot reports how long it took.
	snap := readyFor(t, func(c *Config) {
		c.BootTimes = bootTimes{driver.BootTiming{Kind: "boot", TotalMs: 4700, SnapshotMs: 1200}}
	})
	if snap.Timing == nil || snap.Timing.SnapshotMs == nil || *snap.Timing.SnapshotMs != 1200 {
		t.Fatalf("timing %+v", snap.Timing)
	}
	// Without phases: only the agent's prepare time.
	plain := readyFor(t, func(*Config) {})
	if plain.Timing == nil || plain.Timing.BootMs != nil || plain.Timing.PrepareMs < 0 {
		t.Fatalf("timing %+v", plain.Timing)
	}
}

// A driver that boots from the upload (local-docker) and fails in the
// checkout's own project blocks the claim as the repository's compose_up,
// so the product reads the services' logs; any other upload failure is the
// cell's.
func TestAnUploadBootFailureIsTheRepositorys(t *testing.T) {
	for _, tc := range []struct {
		err             error
		kind            protocol.BlockerKind
		signature, name string
	}{
		{driver.WorkloadBootFailed(errors.New("up: service app exited (1)")), protocol.BlockerKindToolchain, "compose_up", "workload"},
		{driver.WorkloadRecipeRefused(errors.New("recipe: services.compose.env.X has a newline")), protocol.BlockerKindRecipeOutdated, "recipe_load", "recipe"},
		{errors.New("copy: no space left"), protocol.BlockerKindPlatform, "repo_upload", "cell"},
	} {
		h := newHarness(t, func(c *Config) { c.Transport = stubTransport{upload: tc.err} })
		if err := h.handle("claim-"+tc.name, protocol.MessageTypeClaimAcquire, h.acquireBody()); err != nil {
			t.Fatal(err)
		}
		f := h.conn.next(t, isFailed).(*protocol.ClaimFailedBody)
		if f.Kind != tc.kind || f.Signature != tc.signature || !strings.Contains(f.Reason, tc.err.Error()) {
			t.Fatalf("%s: %+v", tc.name, f)
		}
	}
}

// The diagnostic hold keeps the machines until hardExpiresAt and no longer.
func TestDiagnosticHoldEndsAtTheCeiling(t *testing.T) {
	h := newHarness(t, func(c *Config) {
		c.Repo = func(protocol.ClaimAcquireBody) (string, error) { return "", errors.New("recipe failed to boot") }
	})
	hard := h.clk.Now().Add(45 * time.Minute).Truncate(time.Second)
	yes := true
	body := h.acquireBody()
	body.Consumer, body.HardExpiresAt, body.DiagnosticHold = protocol.ConsumerSetup, protocol.FormatTime(hard), &yes
	if err := h.handle("claim-h", protocol.MessageTypeClaimAcquire, body); err != nil {
		t.Fatal(err)
	}
	f := h.conn.next(t, isFailed).(*protocol.ClaimFailedBody)
	if f.Held == nil || !*f.Held {
		t.Fatalf("claim.failed not held: %+v", f)
	}
	c, ok := h.a.claims.Get("claim-h")
	if !ok || c.State() != claims.Held || len(h.drv.Machines()) != 2 {
		t.Fatalf("held %v machines %d\n%s", ok, len(h.drv.Machines()), h.logs.String())
	}
	for _, m := range h.drv.Machines() {
		if !driver.ParseExpiry(m.Ref.Tags, driver.TagExpires).Equal(hard) {
			t.Fatalf("kodus:expires %s, want the ceiling %s", m.Ref.Tags[driver.TagExpires], hard)
		}
	}
	if code := nackCode(h.handle("claim-h", protocol.MessageTypeMachineReset, &protocol.MachineResetBody{StepID: "5f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b", Snapshot: protocol.Snapshot{Kind: protocol.SnapshotKindDisk, Ref: "s"}})); code != "diagnostic_hold" {
		t.Fatalf("reset of a held claim: %q", code)
	}
	h.clk.Set(hard.Add(-time.Second))
	h.a.ReapDeadClaims(t.Context())
	if len(h.drv.Machines()) != 2 {
		t.Fatal("hold ended before the ceiling")
	}
	h.clk.Set(hard)
	h.a.ReapDeadClaims(t.Context())
	if _, ok := h.a.claims.Get("claim-h"); ok || len(h.drv.Machines()) != 0 {
		t.Fatalf("hold outlived the ceiling: %d machines", len(h.drv.Machines()))
	}
}

// The build steps go only to a hub whose hello ack accepts them: an older
// hub's strict decoder would refuse claim.ready with the field, and the
// claim would never be ready.
func TestReadyTimingCarriesBuildStepsOnlyToAHubThatAcceptsThem(t *testing.T) {
	steps := &driver.BuildSteps{Steps: 14, Done: 9, Cached: 5, Slowest: []driver.BuildStep{{Service: "grafana", Name: "[build 5/6] RUN go build ./pkg/cmd/grafana", Ms: 380_200}}}
	boot := func(c *Config) {
		c.BootTimes = bootTimes{driver.BootTiming{Kind: "boot", TotalMs: 455_000, BuildMs: 450_000, BuildSteps: steps}}
	}
	ready := func(accepts *AckAccepts) *protocol.ClaimReadyBody {
		h := newHarness(t, boot)
		if accepts != nil {
			h.a.accepts = protocol.Accepted(&protocol.AckBody{Accepts: accepts.names})
		}
		c := claims.New("claim-1", protocol.ClaimAcquireBody{ImageID: "img-acq", Expose: []protocol.Expose{}}, h.a.log, h.clk.Now())
		return h.a.readyBody(c)
	}
	for name, a := range map[string]*AckAccepts{"no session": nil, "an older hub": {}, "a hub that accepts something else": {names: []string{"someFutureField"}}} {
		if r := ready(a); r.Timing == nil || r.Timing.BuildSteps != nil || r.Timing.BuildMs == nil {
			t.Fatalf("%s: timing %+v", name, r.Timing)
		}
	}
	r := ready(&AckAccepts{names: []string{protocol.FeatureReadyBuildSteps}})
	got := r.Timing.BuildSteps
	if got == nil || got.Steps != 14 || got.Cached != 5 || len(got.Slowest) != 1 || got.Slowest[0].Service != "grafana" || got.Slowest[0].Ms != 380_200 {
		t.Fatalf("buildSteps %+v", got)
	}
	r.Observer.ID = "obs-1"
	frame, err := protocol.Encode(protocol.Header{ID: "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b", CellID: "c", ClaimID: "claim-1"}, r)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(frame), `"buildSteps":{"steps":14`) {
		t.Fatalf("frame %s", frame)
	}
}

// AckAccepts is what a test hub's hello ack names in accepts.
type AckAccepts struct{ names []string }

// Within the schema's bounds whatever the driver measured: at most 8 steps,
// none without a service or a name, no negative count.
func TestReadyBuildStepsStayInsideTheSchema(t *testing.T) {
	s := driver.BuildSteps{Steps: 200_000, Done: -1}
	s.Slowest = append(s.Slowest, driver.BuildStep{Service: "", Name: "x", Ms: 1}, driver.BuildStep{Service: "api", Name: "", Ms: 1})
	for i := 0; i < 12; i++ {
		s.Slowest = append(s.Slowest, driver.BuildStep{Service: "api", Name: "step", Ms: int64(100 - i)})
	}
	got := readyBuildSteps(s)
	if got.Steps != 100_000 || got.Done != 0 || len(got.Slowest) != 8 || got.Slowest[0].Ms != 100 {
		t.Fatalf("%+v", got)
	}
	r := &protocol.ClaimReadyBody{Manifest: protocol.Manifest{Services: []protocol.ManifestService{}, Expose: []protocol.Expose{}, ImageID: "i", SeedSha: "s"}, Observer: protocol.ObserverState{ID: "o", State: protocol.ObserverPhaseReady}, Timing: &protocol.ReadyTiming{PrepareMs: 1, BuildSteps: got}}
	if _, err := protocol.Encode(protocol.Header{ID: "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b", CellID: "c", ClaimID: "claim-1"}, r); err != nil {
		t.Fatal(err)
	}
}
