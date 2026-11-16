//go:build linux

package fcregress

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/microvm"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/gitsource"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/hubclient"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/injector"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/machinetrust"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/netguard"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/observer"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/observerclient"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/tarball"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/testing/hubstub"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/testpki"
)

// recommendedHosts is the cell's recommended egress list (what a product
// claim is allowed by default), read from the list the cell embeds.
func recommendedHosts(t *testing.T) []string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "internal", "netguard", "egress-lists.json"))
	if err != nil {
		t.Fatal(err)
	}
	var lists struct {
		Recommended struct {
			Entries []struct {
				Host string `json:"host"`
			} `json:"entries"`
		} `json:"recommended"`
	}
	if err := json.Unmarshal(raw, &lists); err != nil {
		t.Fatal(err)
	}
	hosts := make([]string, 0, len(lists.Recommended.Entries))
	for _, e := range lists.Recommended.Entries {
		hosts = append(hosts, e.Host)
	}
	return hosts
}

// kodus-ai's PR #1 Run on microVMs through the hub protocol, every phase
// timed: the measurement of the heavy case (a monorepo whose backend build
// takes 5 min under gVisor) next to kr-shop's. The same frames as the
// product: setup (cold build), bake to the environment's template, base and
// PR claims of the latest image (the PR rebuilt on the template's build
// state), the signup probes through each observer, a compose reset, the PR
// side's round snapshot and memory resets that undo a signup.
//
// Opt-in: KODY_E2E_KODUSAI_BASE and _PR are the checkouts of kr-kodus-ai's
// main and PR, _BASE_SHA and _PR_SHA their commits. KODY_E2E_KODUSAI_MEMORY_MB
// and _CPUS size each claim (10240 and 2: the dev cell's gVisor claims are
// 12288 and 2). KODY_E2E_KODUSAI_INSPECT=1 runs the cell as a product cell
// does with the recommended list and its trust files (cmd/cell: InspectEgress
// and CellTrust): every claim's machines trust the cell CA, the inspected
// tier's registries go through the injector, and builds use the VM's own
// builder (microvm/build.go). Without it the claims get no trust and their
// TLS is spliced.
func TestFirecrackerKodusAIRunThroughTheHubProtocol(t *testing.T) {
	base, pr := os.Getenv("KODY_E2E_KODUSAI_BASE"), os.Getenv("KODY_E2E_KODUSAI_PR")
	baseSHA, prSHA := os.Getenv("KODY_E2E_KODUSAI_BASE_SHA"), os.Getenv("KODY_E2E_KODUSAI_PR_SHA")
	if base == "" || pr == "" || len(baseSHA) != 40 || len(prSHA) != 40 {
		t.Skip("KODY_E2E_KODUSAI_BASE, _PR and their 40-hex _BASE_SHA, _PR_SHA name kr-kodus-ai's main and PR checkouts")
	}
	memMB, cpus := envInt("KODY_E2E_KODUSAI_MEMORY_MB", 10240), envInt("KODY_E2E_KODUSAI_CPUS", 2)
	recipeYAML, err := os.ReadFile(filepath.Join(base, ".kodus", "workspace.runtime.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	recipeContent, _ := json.Marshal(string(recipeYAML))
	hosts := recommendedHosts(t)

	ca, err := testpki.NewCA("fc-kodusai-ca")
	if err != nil {
		t.Fatal(err)
	}
	tlsDir := t.TempDir()
	obsCert, _ := ca.Issue("observer", time.Hour, "observer")
	if err := ca.WriteFiles(tlsDir, "", obsCert); err != nil {
		t.Fatal(err)
	}
	inspect := os.Getenv("KODY_E2E_KODUSAI_INSPECT") == "1"
	var trust machinetrust.Files
	var injectorPolicies *policy.Store
	var injectorAddr string
	if inspect {
		cellCA, err := testpki.NewCA("fc-kodusai-cell-ca")
		if err != nil {
			t.Fatal(err)
		}
		roots, err := os.ReadFile("/etc/ssl/certs/ca-certificates.crt")
		if err != nil {
			t.Fatal(err)
		}
		dir := t.TempDir()
		trust = machinetrust.Files{Bundle: filepath.Join(dir, "bundle.pem"), CellCA: filepath.Join(dir, "cell-ca.pem")}
		if err := os.WriteFile(trust.Bundle, append(append(roots, '\n'), cellCA.PEM...), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(trust.CellCA, cellCA.PEM, 0o644); err != nil {
			t.Fatal(err)
		}
		injectorPolicies = policy.NewStore(time.Now)
		inj := &injector.Injector{Policies: injectorPolicies, CA: cellCA.Cert, CAKey: cellCA.Key, TrustedProxies: []string{"127.0.0.1"},
			Log: slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo})).With("component", "injector")}
		l, err := net.Listen("tcp4", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		ictx, stop := context.WithCancel(context.Background())
		t.Cleanup(stop)
		go func() { _ = inj.Serve(ictx, l) }()
		injectorAddr = l.Addr().String()
	}
	s := open(t, func(f *microvm.Firecracker) {
		f.ObserverTLSDir, f.MaxMemoryMB, f.MaxCPUs, f.DataGB = tlsDir, memMB, cpus, envInt("KODY_E2E_KODUSAI_DATA_GB", 40)
		f.Trust = trust
	})
	var egressFlags []string
	if inspect {
		egressFlags = []string{"-injector-addr", injectorAddr}
	}
	e := startEgress(t, s.Place.Egress().String(), egressFlags...)
	// Without inspection the claims get the recommended hosts as the hub's
	// allowlist. With it the cell adds them itself (agent.RecommendedOn), as
	// a product cell does: a host the hub names is a full-access approval,
	// which the cell never inspects.
	acquireAllow := hosts
	egress := agentEgress{e: e, base: hosts}
	if inspect {
		egress, acquireAllow = agentEgress{e: e, rules: &agent.EgressRules{Inspect: netguard.RecommendedInspectRules(), Build: agent.BuildPassthroughHosts(true, "")}, injector: injectorPolicies}, nil
	}
	stamp := time.Now().Format("150405")
	orgID, envID := "org-fc", "env-kodusai-"+stamp
	t.Cleanup(func() {
		if snap, ok, _ := s.Backend.LatestTemplate(orgID, microvm.TemplateKey(envID), isolation.ShapeEnvironment); ok {
			_ = s.Backend.Store().Remove(orgID, snap.ID)
		}
	})

	tarballOf := func(dir string) []byte {
		out, err := exec.Command("tar", "-czf", "-", "--exclude=./.git", "--transform", "s,^\\.,kr-kodus-ai,", "-C", dir, ".").Output()
		if err != nil {
			t.Fatal(err)
		}
		return out
	}
	tarballs := map[string][]byte{baseSHA: tarballOf(base), prSHA: tarballOf(pr)}
	git := httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/repos/o/kr-kodus-ai/tarball/"):
			b, ok := tarballs[strings.TrimPrefix(r.URL.Path, "/repos/o/kr-kodus-ai/tarball/")]
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
		machine := c.Observer.MachineID
		hc := &http.Client{Timeout: 11 * time.Minute, Transport: &http.Transport{
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
			return git.URL + "/repos/o/kr-kodus-ai/tarball/" + acq.Sha, nil
		},
		Extractor: tarball.InProcessExtractor{}, Revoker: gitsource.GitHub{APIBase: git.URL},
		OrgKey: func(org string) (string, error) { return "microvm-" + org, nil },
		Egress: egress, CellTrust: inspect, InspectEgress: inspect,
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
	t.Cleanup(func() {
		t.Logf("kodus-ai Run on microVMs through the hub protocol (%d MB, %d CPUs per claim):\n  %s", memMB, cpus, strings.Join(times, "\n  "))
	})
	// The hub renews a claim's lease while it lives (InitialLease is 5 min);
	// the stub does not, so the test does, every minute, for every claim.
	var liveMu sync.Mutex
	var live []string
	rctx, rcancel := context.WithCancel(context.Background())
	t.Cleanup(rcancel)
	go func() {
		tick := time.NewTicker(time.Minute)
		defer tick.Stop()
		for {
			select {
			case <-rctx.Done():
				return
			case <-tick.C:
			}
			liveMu.Lock()
			claims := slices.Clone(live)
			liveMu.Unlock()
			for _, c := range claims {
				if err := hub.Send(rctx, cellID, c, &protocol.ClaimRenewBody{LeaseExpiresAt: protocol.FormatTime(time.Now().Add(5 * time.Minute))}); err != nil && rctx.Err() == nil {
					t.Logf("renew %s: %v", c, err)
				}
			}
		}
	}()
	wait := func() context.Context {
		c, cancel := context.WithTimeout(context.Background(), 45*time.Minute)
		t.Cleanup(cancel)
		return c
	}
	acquire := func(claim string, side protocol.Side, consumer protocol.Consumer, sha string) *protocol.ClaimReadyBody {
		t.Helper()
		body := &protocol.ClaimAcquireBody{
			Repo:  protocol.RepoRef{Provider: protocol.GitProviderGithub, FullName: "o/kr-kodus-ai", APIBase: git.URL},
			OrgID: orgID, EnvironmentID: envID, ImageID: "latest", Side: side, Sha: sha, Consumer: consumer, RepoToken: "ghs_e2e",
			Expose: []protocol.Expose{
				{Service: "api", Port: 3001, Kind: protocol.ExposeKindHTTP},
				{Service: "webhooks", Port: 3332, Kind: protocol.ExposeKindHTTP},
			},
			Recipe:        &protocol.ClaimAcquireBodyRecipe{Path: ".kodus/workspace.runtime.yaml", Content: recipeContent},
			HardExpiresAt: protocol.FormatTime(time.Now().Add(44 * time.Minute)), EgressAllow: acquireAllow,
			Size: &protocol.MachineSize{MemoryMb: int64(memMB), Cpus: int64(cpus)},
		}
		start := time.Now()
		liveMu.Lock()
		live = append(live, claim)
		liveMu.Unlock()
		if err := hub.Send(wait(), cellID, claim, body); err != nil {
			t.Fatalf("claim.acquire %s: %v", claim, err)
		}
		ready, err := hub.WaitReady(wait(), claim)
		if err != nil {
			t.Fatal(err)
		}
		lap(claim+" claim.acquire to claim.ready", start)
		if ready.Timing != nil {
			raw, _ := json.Marshal(ready.Timing)
			t.Logf("%s timing: %s", claim, raw)
		}
		return ready
	}
	release := func(claim string) {
		_ = hub.Send(context.Background(), cellID, claim, &protocol.ClaimReleaseBody{})
	}
	// tryCall is call that answers nil while the service does not answer
	// (a VM still paging its memory in after a restore).
	var tryCall func(claim, method, path, body string) *protocol.ProbeResultHTTP
	probeOnce := func(claim, method, path, body string, timeoutMs int64) *protocol.StepResultBody {
		t.Helper()
		step := hubclient.NewID()
		spec := &protocol.HTTPProbe{
			Target: protocol.ProbeTarget{Service: "api", Port: 3001}, Method: protocol.HTTPMethod(method), Path: path, TimeoutMs: timeoutMs,
		}
		if body != "" {
			spec.Body = &body
			spec.Headers = map[string]string{"content-type": "application/json"}
		}
		probe := &protocol.ProbeRunBody{StepID: step, Probe: protocol.Probe{
			ID: "kodusai" + strings.ReplaceAll(path, "/", "-"), Origin: protocol.ProbeOriginAgent, Purpose: method + " " + path, Expected: "status",
			Compare: []protocol.CompareField{protocol.CompareFieldStatus}, Spec: protocol.ProbeSpec{HTTP: spec},
		}}
		if err := hub.Send(wait(), cellID, claim, probe); err != nil {
			t.Fatalf("probe.run on %s: %v", claim, err)
		}
		ev, err := hub.WaitFor(wait(), func(e hubstub.Event) bool {
			r, ok := e.Body.(*protocol.StepResultBody)
			return ok && r.StepID == step
		})
		if err != nil {
			t.Fatal(err)
		}
		return ev.Body.(*protocol.StepResultBody)
	}
	call := func(claim, method, path, body string) *protocol.ProbeResultHTTP {
		t.Helper()
		r := probeOnce(claim, method, path, body, 30_000)
		if r.Executor != protocol.ExecutorObserver || r.Probe == nil || r.Probe.HTTP == nil {
			t.Fatalf("probe %s %s on %s: %+v", method, path, claim, r)
		}
		return r.Probe.HTTP
	}
	tryCall = func(claim, method, path, body string) *protocol.ProbeResultHTTP {
		t.Helper()
		if r := probeOnce(claim, method, path, body, 5_000); r.Probe != nil && r.Probe.HTTP != nil {
			return r.Probe.HTTP
		}
		return nil
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
	invalidEmail := `{"name":"Jane Doe","email":"not-an-email","password":"Str0ngPassw0rd"}`
	validSignup := `{"name":"Jane Doe","email":"jane.doe@example.com","password":"Str0ngPassw0rd"}`

	// The setup (a cold build of the backend), then its bake.
	setup := "kai-setup-" + stamp
	t.Cleanup(func() { release(setup) })
	acquire(setup, protocol.SideSetup, protocol.ConsumerSetup, baseSHA)
	if h := call(setup, "GET", "/health/simple", ""); h.Status != 200 {
		t.Fatalf("the setup's /health/simple: %+v", h)
	}
	start := time.Now()
	if err := hub.Send(wait(), cellID, setup, &protocol.ImageBakeBody{EnvironmentID: envID, OrgID: orgID, RecipeSha: "recipe-e2e", Sha: baseSHA}); err != nil {
		t.Fatalf("image.bake: %v", err)
	}
	release(setup)
	for {
		_, ok, _ := s.Backend.LatestTemplate(orgID, microvm.TemplateKey(envID), isolation.ShapeEnvironment)
		left, _ := s.Driver.List(context.Background(), map[string]string{"kodus:claim": setup, "kodus:role": "workload"})
		if ok && len(left) == 0 {
			time.Sleep(time.Second)
			break
		}
		if time.Since(start) > 15*time.Minute {
			t.Fatal("the bake made no template")
		}
		time.Sleep(time.Second)
	}
	lap("image.bake to the environment's template", start)

	// The Run: the base restored from the template, the PR rebuilt on its build state.
	baseClaim, prClaim := "kai-base-"+stamp, "kai-pr-"+stamp
	t.Cleanup(func() { release(baseClaim); release(prClaim) })
	readyBase := acquire(baseClaim, protocol.SideBase, protocol.ConsumerRuntime, baseSHA)
	readyPR := acquire(prClaim, protocol.SidePr, protocol.ConsumerRuntime, prSHA)
	if readyBase.Manifest.ImageID != readyPR.Manifest.ImageID {
		t.Fatalf("the sides ran different images: %s and %s", readyBase.Manifest.ImageID, readyPR.Manifest.ImageID)
	}
	start = time.Now()
	b, p := call(baseClaim, "POST", "/auth/signUp", invalidEmail), call(prClaim, "POST", "/auth/signUp", invalidEmail)
	lap("both sides' POST /auth/signUp (invalid email) through their observers", start)
	t.Logf("signup with an invalid email: main %d, PR %d", b.Status, p.Status)
	if b.Status != 400 || p.Status != 201 {
		t.Fatalf("the hidden regression is not what main and the PR answer: main %d, PR %d", b.Status, p.Status)
	}

	// A compose reset of the PR side (what every round pays under gVisor), then the probe.
	id := hubclient.NewID()
	start = time.Now()
	if r := step(prClaim, &protocol.MachineResetBody{StepID: id, Snapshot: protocol.Snapshot{Kind: protocol.SnapshotKindComposeVolumes, Ref: readyPR.Manifest.ImageID + ":seed"}}, id); r.Exec != nil {
		t.Fatalf("compose reset: %+v", r.Exec)
	}
	for i := 0; ; i++ {
		if h := call(prClaim, "GET", "/health/simple", ""); h.Status == 200 {
			break
		}
		if i > 300 {
			t.Fatal("the api never answered after the compose reset")
		}
		time.Sleep(time.Second)
	}
	lap("PR compose reset (down -v, up, recipe) to /health/simple 200", start)

	// The base side is done: release it so the state disk holds the PR's
	// round snapshot (kodus-ai's is ~29 GB) next to the template.
	release(baseClaim)
	for i := 0; ; i++ {
		left, _ := s.Driver.List(context.Background(), map[string]string{"kodus:claim": baseClaim})
		if len(left) == 0 {
			break
		}
		if i > 120 {
			t.Fatal("the base claim's machines are still there")
		}
		time.Sleep(time.Second)
	}

	// The PR side's round at first ready, then memory resets that undo a signup.
	id = hubclient.NewID()
	start = time.Now()
	round := step(prClaim, &protocol.ClaimSnapshotBody{StepID: id, Purpose: protocol.ClaimSnapshotBodyPurposeRound}, id)
	if round.Snapshot == nil {
		t.Fatalf("round: %+v", round)
	}
	lap("PR round snapshot", start)
	// A VM restored from its round pages its memory in lazily: the first
	// request after a restore waits for the pages it touches. answered waits
	// for the API's health, timed apart from the probe that follows.
	answered := func(what string, since time.Time) {
		t.Helper()
		for i := 0; ; i++ {
			if h := tryCall(prClaim, "GET", "/health/simple", ""); h != nil && h.Status == 200 {
				lap(what, since)
				return
			}
			if i > 60 {
				t.Fatalf("%s: the api never answered", what)
			}
			time.Sleep(time.Second)
		}
	}
	answered("PR round snapshot to the api's first answer", start)
	if first := call(prClaim, "POST", "/auth/signUp", validSignup); first.Status != 201 {
		t.Fatalf("the first signup: %d", first.Status)
	}
	if again := call(prClaim, "POST", "/auth/signUp", validSignup); again.Status == 201 {
		t.Fatal("a second signup with the same email was accepted: the probe cannot tell a reset from none")
	}
	for i := range 3 {
		id := hubclient.NewID()
		start := time.Now()
		if r := step(prClaim, &protocol.MachineResetBody{StepID: id, Snapshot: protocol.Snapshot{Kind: protocol.SnapshotKindMemory, Ref: round.Snapshot.ID}}, id); r.Exec != nil {
			t.Fatalf("memory reset %d: %+v", i, r.Exec)
		}
		lap(fmt.Sprintf("PR memory reset %d, the step", i), start)
		answered(fmt.Sprintf("PR memory reset %d to the api's first answer", i), start)
		if got := call(prClaim, "POST", "/auth/signUp", validSignup); got.Status != 201 {
			t.Fatalf("after memory reset %d the signup answered %d: the user from before the reset is still there", i, got.Status)
		}
		lap("PR memory reset to the round, to a signup's 201 through the observer", start)
	}
}
