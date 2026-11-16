//go:build linux

package fcregress

import (
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"log"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/microvm"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/gitsource"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/hubclient"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/kodyexec"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/observer"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/observerclient"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/tarball"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/testing/hubstub"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/testpki"
)

// agentEgress pushes the agent's claim policies to the cell's egress, as
// cmd/cell's policyPusher does.
type agentEgress struct {
	e    pushedEgress
	base []string
}

func (a agentEgress) Apply(ctx context.Context, c agent.ClaimInfo) error {
	spec, err := agent.PolicySpec(c, a.base, time.Now())
	if err != nil {
		return err
	}
	pol, _, err := policy.Build(spec, nil)
	if err != nil {
		return err
	}
	return a.e.push.Push(ctx, pol)
}

func (a agentEgress) Remove(ctx context.Context, claimID string) error {
	return a.e.push.Remove(ctx, claimID)
}

// tarGz is dir as the GitHub tarball endpoint serves it: one top directory.
func tarGz(t *testing.T, dir string) []byte {
	t.Helper()
	out, err := exec.Command("tar", "-czf", "-", "--transform", "s,^\\.,kr-shop,", "-C", dir, ".").Output()
	if err != nil {
		t.Fatal(err)
	}
	return out
}

// A whole kr-shop Run on microVMs through the hub protocol: the cell agent
// on the microvm driver against the hub stub, every step a frame. The setup
// claim boots kr-shop's main in an environment VM (build, compose, recipe,
// the observer VM's health probe); image.bake keeps it as the environment's
// template; the Run's base and PR claims of the latest image are restored
// from it, the PR side rebuilt from its checkout; the same probes go to both
// sides through each claim's observer VM over vsock; then a compose reset
// and a round snapshot with memory resets, each followed by the probe.
func TestFirecrackerKrShopRunThroughTheHubProtocol(t *testing.T) {
	base, pr := os.Getenv("KODY_E2E_KRSHOP_BASE"), os.Getenv("KODY_E2E_KRSHOP_PR")
	baseSHA, prSHA := os.Getenv("KODY_E2E_KRSHOP_BASE_SHA"), os.Getenv("KODY_E2E_KRSHOP_PR_SHA")
	if base == "" || pr == "" || len(baseSHA) != 40 || len(prSHA) != 40 {
		t.Skip("KODY_E2E_KRSHOP_BASE, _PR and their 40-hex _BASE_SHA, _PR_SHA name kr-shop's main and PR checkouts")
	}
	ca, err := testpki.NewCA("fc-run-ca")
	if err != nil {
		t.Fatal(err)
	}
	// The observers' server certificate (for the name "observer") and the
	// CA of the cell's client certificate, as -firecracker-observer-tls-dir.
	tlsDir := t.TempDir()
	obsCert, _ := ca.Issue("observer", time.Hour, "observer")
	if err := ca.WriteFiles(tlsDir, "", obsCert); err != nil {
		t.Fatal(err)
	}
	s := open(t, func(f *microvm.Firecracker) { f.ObserverTLSDir, f.MaxMemoryMB, f.MaxCPUs = tlsDir, 4096, 2 })
	e := startEgress(t, s.Place.Egress().String())
	stamp := time.Now().Format("150405")
	orgID, envID := "org-fc", "env-krshop-"+stamp
	t.Cleanup(func() {
		// The test's templates go with it.
		if snap, ok, _ := s.Backend.LatestTemplate(orgID, microvm.TemplateKey(envID), isolation.ShapeEnvironment); ok {
			_ = s.Backend.Store().Remove(orgID, snap.ID)
		}
	})

	tarballs := map[string][]byte{baseSHA: tarGz(t, base), prSHA: tarGz(t, pr)}
	git := httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/repos/o/kr-shop/tarball/"):
			b, ok := tarballs[strings.TrimPrefix(r.URL.Path, "/repos/o/kr-shop/tarball/")]
			if !ok || !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ghs_") {
				rw.WriteHeader(http.StatusNotFound)
				return
			}
			_, _ = rw.Write(b)
		case r.Method == http.MethodDelete && r.URL.Path == "/installation/token":
			rw.WriteHeader(http.StatusNoContent)
		default:
			rw.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(git.Close)

	cellCert, _ := ca.Issue(cellID, time.Hour)
	obsTLS := &tls.Config{Certificates: []tls.Certificate{cellCert}, RootCAs: ca.Pool(), ServerName: "observer", MinVersion: tls.VersionTLS13}
	observers := func(ctx context.Context, c agent.ClaimInfo, targets []observer.Target) (observer.Client, error) {
		targets, err := s.Driver.Targets(ctx, c.Workload.MachineID, targets)
		if err != nil {
			return nil, err
		}
		// The address only names the endpoint (the client checks it is an
		// address); every connection goes over the observer VM's vsock.
		machine := c.Observer.MachineID
		hc := &http.Client{Timeout: 11 * time.Minute, Transport: &http.Transport{
			// One vsock connection per request: an idle connection the observer
			// closed is only seen on the next write, and a POST is not retried.
			DisableKeepAlives: true,
			TLSClientConfig:   obsTLS,
			DialContext:       func(ctx context.Context, _, _ string) (net.Conn, error) { return s.Driver.DialObserver(ctx, machine) },
		}}
		return observerclient.Configure(ctx, hc, "https://"+net.JoinHostPort(c.Observer.PrivateAddress, strconv.Itoa(microvm.ObserverVsockPort)), observer.ClaimConfig{ClaimID: c.ClaimID, ImageID: c.Workload.ImageID, Targets: targets})
	}
	hub := hubstub.New()
	hub.HelloAck = func() *protocol.AckBody {
		v := int64(protocol.ProtocolVersion)
		return &protocol.AckBody{Version: &v, Accepts: []string{protocol.FeatureReadyStart, protocol.FeatureSnapshots, protocol.FeatureBootPhases}}
	}
	server, _ := ca.Issue("runtime-hub", time.Hour, "127.0.0.1")
	srv := httptest.NewUnstartedServer(hub)
	srv.Config.ErrorLog = log.New(io.Discard, "", 0)
	srv.TLS = hub.TLSConfig(server, ca.Pool())
	srv.StartTLS()
	t.Cleanup(srv.Close)
	a, err := agent.New(agent.Config{
		CellID: cellID, Regions: []string{"local"}, Driver: s.Driver, Transport: s.Driver,
		Parts: driver.Parts{
			Baker: s.Driver, Resetter: s.Driver, Composer: s.Driver, Recipes: s.Driver, BakePinner: s.Driver,
			Sandboxes: s.Driver, Snapshots: s.Driver, Sessions: s.Driver,
		}, Observers: observers,
		Repo: func(acq protocol.ClaimAcquireBody) (string, error) {
			return git.URL + "/repos/o/kr-shop/tarball/" + acq.Sha, nil
		},
		Extractor: tarball.InProcessExtractor{}, Revoker: gitsource.GitHub{APIBase: git.URL},
		OrgKey:  func(org string) (string, error) { return "microvm-" + org, nil },
		Egress:  agentEgress{e: e, base: krShopHosts},
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
			HubURL: "wss://" + strings.TrimPrefix(srv.URL, "https://") + "/v1/cell", TLS: cellTLSConfig(cellCert, ca),
			HeartbeatEvery: time.Second, DeadManEvery: time.Second, Backoff: 100 * time.Millisecond, AckTimeout: 10 * time.Second,
		})
	}()
	t.Cleanup(func() { cancel(); <-done })
	select {
	case <-hub.Hellos():
	case <-time.After(10 * time.Second):
		t.Fatal("the cell never said hello")
	}

	var times []string
	lap := func(what string, since time.Time) {
		times = append(times, what+": "+time.Since(since).Round(time.Millisecond).String())
		t.Logf("%s: %d ms", what, time.Since(since).Milliseconds())
	}
	t.Cleanup(func() { t.Logf("kr-shop Run on microVMs through the hub protocol:\n  %s", strings.Join(times, "\n  ")) })
	wait := func() context.Context {
		c, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
		t.Cleanup(cancel)
		return c
	}
	acquire := func(claim string, side protocol.Side, consumer protocol.Consumer, sha string) *protocol.ClaimReadyBody {
		t.Helper()
		body := &protocol.ClaimAcquireBody{
			Repo:  protocol.RepoRef{Provider: protocol.GitProviderGithub, FullName: "o/kr-shop", APIBase: git.URL},
			OrgID: orgID, EnvironmentID: envID, ImageID: "latest", Side: side, Sha: sha, Consumer: consumer, RepoToken: "ghs_e2e",
			Expose:        []protocol.Expose{{Service: "app", Port: 3000, Kind: protocol.ExposeKindHTTP}},
			HardExpiresAt: protocol.FormatTime(time.Now().Add(40 * time.Minute)), EgressAllow: krShopHosts,
			Size: &protocol.MachineSize{MemoryMb: 4096, Cpus: 2},
		}
		start := time.Now()
		if err := hub.Send(wait(), cellID, claim, body); err != nil {
			t.Fatalf("claim.acquire %s: %v", claim, err)
		}
		ready, err := hub.WaitReady(wait(), claim)
		if err != nil {
			t.Fatal(err)
		}
		st := ""
		if ready.Start != nil {
			st = string(*ready.Start)
		}
		lap(claim+" claim.acquire to claim.ready (start "+st+")", start)
		return ready
	}
	release := func(claim string) {
		_ = hub.Send(context.Background(), cellID, claim, &protocol.ClaimReleaseBody{})
	}
	probe := func(claim, path string) *protocol.ProbeResult {
		t.Helper()
		step := hubclient.NewID()
		body := &protocol.ProbeRunBody{StepID: step, Probe: protocol.Probe{
			ID: "kr-shop" + strings.ReplaceAll(path, "/", "-"), Origin: protocol.ProbeOriginAgent, Purpose: "GET " + path, Expected: "200",
			Compare: []protocol.CompareField{protocol.CompareFieldStatus, protocol.CompareFieldJSON},
			Spec: protocol.ProbeSpec{HTTP: &protocol.HTTPProbe{
				Target: protocol.ProbeTarget{Service: "app", Port: 3000}, Method: protocol.HTTPMethodGet, Path: path, TimeoutMs: 5000,
			}},
		}}
		if err := hub.Send(wait(), cellID, claim, body); err != nil {
			t.Fatalf("probe.run on %s: %v", claim, err)
		}
		ev, err := hub.WaitFor(wait(), func(e hubstub.Event) bool {
			r, ok := e.Body.(*protocol.StepResultBody)
			return ok && r.StepID == step
		})
		if err != nil {
			t.Fatal(err)
		}
		r := ev.Body.(*protocol.StepResultBody)
		if r.Executor != protocol.ExecutorObserver || r.Probe == nil || r.Probe.HTTP == nil {
			diag := ""
			if refs, _ := s.Driver.List(context.Background(), map[string]string{"kodus:claim": claim}); len(refs) > 0 {
				for _, m := range refs {
					if m.Tags["kodus:role"] == "observer" {
						out, err := s.Driver.Exec(context.Background(), m, kodyexec.Request{Command: "tail -c 2000 .kodus-observer/log; ps -ef | grep -c kody-guest", TimeoutMs: 10_000})
						diag = out.Stdout + out.Stderr + fmt.Sprint(err)
					}
				}
			}
			t.Fatalf("probe on %s: %+v\nobserver: %s", claim, r, diag)
		}
		return r.Probe
	}
	step := func(claim string, body any, id string) *protocol.StepResultBody {
		t.Helper()
		if err := hub.Send(wait(), cellID, claim, body); err != nil {
			t.Fatalf("%T on %s: %v", body, claim, err)
		}
		ev, err := hub.WaitFor(wait(), func(e hubstub.Event) bool {
			r, ok := e.Body.(*protocol.StepResultBody)
			return ok && r.StepID == id
		})
		if err != nil {
			t.Fatal(err)
		}
		return ev.Body.(*protocol.StepResultBody)
	}

	// The setup, then its bake: the environment's template.
	t.Cleanup(func() { release("krs-setup-" + stamp) })
	acquire("krs-setup-"+stamp, protocol.SideSetup, protocol.ConsumerSetup, baseSHA)
	if p := probe("krs-setup-"+stamp, "/orders"); p.HTTP.Status != 200 {
		t.Fatalf("the setup's /orders: %+v", p.HTTP)
	}
	start := time.Now()
	if err := hub.Send(wait(), cellID, "krs-setup-"+stamp, &protocol.ImageBakeBody{EnvironmentID: envID, OrgID: orgID, RecipeSha: "recipe-e2e", Sha: baseSHA}); err != nil {
		t.Fatalf("image.bake: %v", err)
	}
	release("krs-setup-" + stamp)
	for {
		// The bake is done when the template is published and the setup's
		// machine it pinned is gone (the agent records the image right after).
		_, ok, _ := s.Backend.LatestTemplate(orgID, microvm.TemplateKey(envID), isolation.ShapeEnvironment)
		left, _ := s.Driver.List(context.Background(), map[string]string{"kodus:claim": "krs-setup-" + stamp, "kodus:role": "workload"})
		if ok && len(left) == 0 {
			time.Sleep(time.Second)
			break
		}
		if time.Since(start) > 5*time.Minute {
			t.Fatal("the bake made no template")
		}
		time.Sleep(time.Second)
	}
	lap("image.bake to the environment's template", start)

	// The Run: both sides of the latest image, the same probes through each observer.
	readyBase := acquire("krs-base-"+stamp, protocol.SideBase, protocol.ConsumerRuntime, baseSHA)
	readyPR := acquire("krs-pr-"+stamp, protocol.SidePr, protocol.ConsumerRuntime, prSHA)
	t.Cleanup(func() { release("krs-base-" + stamp); release("krs-pr-" + stamp) })
	if readyBase.Manifest.ImageID != readyPR.Manifest.ImageID {
		t.Fatalf("the sides ran different images: %s and %s", readyBase.Manifest.ImageID, readyPR.Manifest.ImageID)
	}
	start = time.Now()
	bOrders, pOrders := probe("krs-base-"+stamp, "/orders"), probe("krs-pr-"+stamp, "/orders")
	lap("both sides' GET /orders through their observers", start)
	bPage, pPage := probe("krs-base-"+stamp, "/"), probe("krs-pr-"+stamp, "/")
	t.Logf("GET /orders base %d %s | pr %d %s", bOrders.HTTP.Status, bOrders.HTTP.Body, pOrders.HTTP.Status, pOrders.HTTP.Body)
	t.Logf("GET / base %d (%d bytes) | pr %d (%d bytes), same body: %v", bPage.HTTP.Status, len(bPage.HTTP.Body), pPage.HTTP.Status, len(pPage.HTTP.Body), bPage.HTTP.Body == pPage.HTTP.Body)
	if bOrders.HTTP.Status != 200 || pOrders.HTTP.Status != 200 || bOrders.HTTP.Body != pOrders.HTTP.Body {
		t.Fatalf("/orders differs between the sides: %+v | %+v", bOrders.HTTP, pOrders.HTTP)
	}
	if bPage.HTTP.Body == pPage.HTTP.Body {
		t.Fatal("the PR's page is the base's: the PR's checkout did not reach its side")
	}

	// A replay round's reset, each way, then the probe again.
	id := hubclient.NewID()
	start = time.Now()
	if r := step("krs-base-"+stamp, &protocol.MachineResetBody{StepID: id, Snapshot: protocol.Snapshot{Kind: protocol.SnapshotKindComposeVolumes, Ref: readyBase.Manifest.ImageID + ":seed"}}, id); r.Exec != nil {
		t.Fatalf("compose reset: %+v", r.Exec)
	}
	if p := probe("krs-base-"+stamp, "/orders"); p.HTTP.Body != bOrders.HTTP.Body {
		t.Fatalf("after the compose reset: %s", p.HTTP.Body)
	}
	lap("base compose reset (down -v, up, recipe) to the probe's answer", start)
	id = hubclient.NewID()
	start = time.Now()
	r := step("krs-base-"+stamp, &protocol.ClaimSnapshotBody{StepID: id, Purpose: protocol.ClaimSnapshotBodyPurposeRound}, id)
	if r.Snapshot == nil {
		t.Fatalf("round: %+v", r)
	}
	lap("base round snapshot at first ready", start)
	for i := range 3 {
		id := hubclient.NewID()
		start := time.Now()
		if r := step("krs-base-"+stamp, &protocol.MachineResetBody{StepID: id, Snapshot: protocol.Snapshot{Kind: protocol.SnapshotKindMemory, Ref: r.Snapshot.ID}}, id); r.Exec != nil {
			t.Fatalf("memory reset %d: %+v", i, r.Exec)
		}
		if p := probe("krs-base-"+stamp, "/orders"); p.HTTP.Body != bOrders.HTTP.Body {
			t.Fatalf("after memory reset %d: %s", i, p.HTTP.Body)
		}
		lap("base memory reset to the round, to the probe's answer through the observer", start)
	}
}
