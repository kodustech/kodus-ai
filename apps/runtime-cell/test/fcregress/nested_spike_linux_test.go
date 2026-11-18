//go:build linux

package fcregress

// The nested-virtualization spike (the Firecracker spike,
// "Round 3"): Run-shaped density held for minutes, and an environment
// template kept on one host and restored on another. Opt-in on a KVM host
// with the demo-shop checkouts (KODY_E2E_KRSHOP_*), as root:
//
//	KODY_E2E_DENSITY_RUNS=N KODY_E2E_DENSITY_MINUTES=M  -run TestNestedSpikeRunDensity
//	KODY_E2E_TEMPLATE_ENV=<name> KODY_E2E_TEMPLATE_KEEP=1 -run TestNestedSpikeKeepTemplate
//	KODY_E2E_TEMPLATE_ENV=<name>                         -run TestNestedSpikeRestoreTemplate
//
// Every measurement is a log line starting with SPIKE.

import (
	"bufio"
	"context"
	"crypto/tls"
	"errors"
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
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/kodyexec"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/observer"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/observerclient"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/tarball"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/testing/hubstub"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/testpki"
)

// agentLogLevel is the test agent's: warnings, or every line with
// KODY_E2E_AGENT_LOG=info (probe.refused carries an unreachable probe's
// transport error there).
func agentLogLevel() slog.Level {
	if os.Getenv("KODY_E2E_AGENT_LOG") == "info" {
		return slog.LevelInfo
	}
	return slog.LevelWarn
}

func envInt(name string, def int) int {
	if v, err := strconv.Atoi(os.Getenv(name)); err == nil {
		return v
	}
	return def
}

// spikeHub routes the hub stub's events by step and claim, so many Runs can
// wait at once (hubstub.WaitFor is for one waiter and keeps at most 1,024
// unmatched events, which heartbeats fill in minutes).
type spikeHub struct {
	hub   *hubstub.Hub
	mu    sync.Mutex
	steps map[string]chan *protocol.StepResultBody
	ready map[string]chan hubstub.Event
	other map[protocol.MessageType]int
	t     *testing.T
}

func (d *spikeHub) run(ctx context.Context) {
	for {
		select {
		case e := <-d.hub.Events():
			d.route(e)
		case <-ctx.Done():
			return
		}
	}
}

func (d *spikeHub) route(e hubstub.Event) {
	d.mu.Lock()
	defer d.mu.Unlock()
	switch b := e.Body.(type) {
	case *protocol.StepResultBody:
		if c, ok := d.steps[b.StepID]; ok {
			c <- b
			delete(d.steps, b.StepID)
			return
		}
	case *protocol.ClaimReadyBody, *protocol.ClaimFailedBody:
		if c, ok := d.ready[e.ClaimID]; ok {
			c <- e
			delete(d.ready, e.ClaimID)
			return
		}
	}
	d.other[e.Type]++
	if e.Type != protocol.MessageTypeHeartbeat {
		d.t.Logf("SPIKE event %s claim=%s %+v", e.Type, e.ClaimID, e.Body)
	}
}

func (d *spikeHub) expectStep(id string) chan *protocol.StepResultBody {
	c := make(chan *protocol.StepResultBody, 1)
	d.mu.Lock()
	d.steps[id] = c
	d.mu.Unlock()
	return c
}

func (d *spikeHub) expectReady(claim string) chan hubstub.Event {
	c := make(chan hubstub.Event, 1)
	d.mu.Lock()
	d.ready[claim] = c
	d.mu.Unlock()
	return c
}

// spikeRun is the hub-protocol harness of TestFirecrackerKrShopRunThroughTheHubProtocol
// with error-returning steps, safe to call from many goroutines.
type spikeRun struct {
	s            microvm.Stack
	d            *spikeHub
	orgID, envID string
	baseSHA      string
	prSHA        string
	gitURL       string
	hardExpiry   time.Time
}

func newSpikeRun(t *testing.T, hardExpiry time.Time) *spikeRun {
	t.Helper()
	base, pr := os.Getenv("KODY_E2E_KRSHOP_BASE"), os.Getenv("KODY_E2E_KRSHOP_PR")
	baseSHA, prSHA := os.Getenv("KODY_E2E_KRSHOP_BASE_SHA"), os.Getenv("KODY_E2E_KRSHOP_PR_SHA")
	if base == "" || pr == "" || len(baseSHA) != 40 || len(prSHA) != 40 {
		t.Skip("KODY_E2E_KRSHOP_BASE, _PR and their 40-hex _BASE_SHA, _PR_SHA name demo-shop's main and PR checkouts")
	}
	ca, err := testpki.NewCA("fc-spike-ca")
	if err != nil {
		t.Fatal(err)
	}
	tlsDir := t.TempDir()
	obsCert, _ := ca.Issue("observer", 6*time.Hour, "observer")
	if err := ca.WriteFiles(tlsDir, "", obsCert); err != nil {
		t.Fatal(err)
	}
	s := open(t, func(f *microvm.Firecracker) { f.ObserverTLSDir, f.MaxMemoryMB, f.MaxCPUs = tlsDir, 4096, 2 })
	e := startEgress(t, s.Place.Egress().String())
	stamp := time.Now().Format("150405")
	r := &spikeRun{s: s, orgID: "org-fc", envID: "env-spike-" + stamp, baseSHA: baseSHA, prSHA: prSHA, hardExpiry: hardExpiry}
	t.Cleanup(func() {
		if snap, ok, _ := s.Backend.LatestTemplate(r.orgID, microvm.TemplateKey(r.envID), isolation.ShapeEnvironment); ok {
			_ = s.Backend.Store().Remove(r.orgID, snap.ID)
		}
	})
	tarballs := map[string][]byte{baseSHA: tarGz(t, base), prSHA: tarGz(t, pr)}
	git := httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, req *http.Request) {
		switch {
		case req.Method == http.MethodGet && strings.HasPrefix(req.URL.Path, "/repos/o/demo-shop/tarball/"):
			b, ok := tarballs[strings.TrimPrefix(req.URL.Path, "/repos/o/demo-shop/tarball/")]
			if !ok || !strings.HasPrefix(req.Header.Get("Authorization"), "Bearer ghs_") {
				rw.WriteHeader(http.StatusNotFound)
				return
			}
			_, _ = rw.Write(b)
		case req.Method == http.MethodDelete && req.URL.Path == "/installation/token":
			rw.WriteHeader(http.StatusNoContent)
		default:
			rw.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(git.Close)
	r.gitURL = git.URL

	cellCert, _ := ca.Issue(cellID, 6*time.Hour)
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
	server, _ := ca.Issue("runtime-hub", 6*time.Hour, "127.0.0.1")
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
			return git.URL + "/repos/o/demo-shop/tarball/" + acq.Sha, nil
		},
		Extractor: tarball.InProcessExtractor{}, Revoker: gitsource.GitHub{APIBase: git.URL},
		OrgKey:  func(org string) (string, error) { return "microvm-" + org, nil },
		Egress:  agentEgress{e: e, base: krShopHosts},
		WorkDir: t.TempDir(), Log: slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: agentLogLevel()})),
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
	select {
	case <-hub.Hellos():
	case <-time.After(10 * time.Second):
		t.Fatal("the cell never said hello")
	}
	r.d = &spikeHub{hub: hub, steps: map[string]chan *protocol.StepResultBody{}, ready: map[string]chan hubstub.Event{}, other: map[protocol.MessageType]int{}, t: t}
	dctx, dcancel := context.WithCancel(context.Background())
	go r.d.run(dctx)
	t.Cleanup(func() { cancel(); <-done; dcancel() })
	return r
}

func (r *spikeRun) acquire(ctx context.Context, claim string, side protocol.Side, consumer protocol.Consumer, sha string) (*protocol.ClaimReadyBody, time.Duration, error) {
	body := &protocol.ClaimAcquireBody{
		Repo:  protocol.RepoRef{Provider: protocol.GitProviderGithub, FullName: "o/demo-shop", APIBase: r.gitURL},
		OrgID: r.orgID, EnvironmentID: r.envID, ImageID: "latest", Side: side, Sha: sha, Consumer: consumer, RepoToken: "ghs_e2e",
		Expose:        []protocol.Expose{{Service: "app", Port: 3000, Kind: protocol.ExposeKindHTTP}},
		HardExpiresAt: protocol.FormatTime(hardFor(consumer, r.hardExpiry)), EgressAllow: krShopHosts,
		Size: &protocol.MachineSize{MemoryMb: 4096, Cpus: 2},
	}
	start := time.Now()
	c := r.d.expectReady(claim)
	if err := r.d.hub.Send(ctx, cellID, claim, body); err != nil {
		return nil, 0, fmt.Errorf("claim.acquire %s: %w", claim, err)
	}
	select {
	case e := <-c:
		if f, ok := e.Body.(*protocol.ClaimFailedBody); ok {
			return nil, time.Since(start), fmt.Errorf("claim %s failed: %s %s: %s", claim, f.Kind, f.Signature, f.Reason)
		}
		return e.Body.(*protocol.ClaimReadyBody), time.Since(start), nil
	case <-ctx.Done():
		return nil, time.Since(start), fmt.Errorf("claim %s: %w", claim, ctx.Err())
	}
}

// hardFor is the claim's hard expiry: the test's, within the agent's
// ceiling for the consumer (60 min for a Run's claims, 45 for a setup).
func hardFor(c protocol.Consumer, want time.Time) time.Time {
	ceiling := 59 * time.Minute
	if c == protocol.ConsumerSetup {
		ceiling = 44 * time.Minute
	}
	if limit := time.Now().Add(ceiling); want.After(limit) {
		return limit
	}
	return want
}

func (r *spikeRun) release(claim string) {
	_ = r.d.hub.Send(context.Background(), cellID, claim, &protocol.ClaimReleaseBody{})
}

func (r *spikeRun) step(ctx context.Context, claim string, body any, id string) (*protocol.StepResultBody, error) {
	c := r.d.expectStep(id)
	if err := r.d.hub.Send(ctx, cellID, claim, body); err != nil {
		return nil, fmt.Errorf("%T on %s: %w", body, claim, err)
	}
	select {
	case res := <-c:
		return res, nil
	case <-ctx.Done():
		return nil, fmt.Errorf("%T on %s: %w", body, claim, ctx.Err())
	}
}

func (r *spikeRun) probe(ctx context.Context, claim, path string) (*protocol.ProbeResult, error) {
	id := hubclient.NewID()
	res, err := r.step(ctx, claim, &protocol.ProbeRunBody{StepID: id, Probe: protocol.Probe{
		ID: "demo-shop" + strings.ReplaceAll(path, "/", "-"), Origin: protocol.ProbeOriginAgent, Purpose: "GET " + path, Expected: "200",
		Compare: []protocol.CompareField{protocol.CompareFieldStatus, protocol.CompareFieldJSON},
		Spec: protocol.ProbeSpec{HTTP: &protocol.HTTPProbe{
			Target: protocol.ProbeTarget{Service: "app", Port: 3000}, Method: protocol.HTTPMethodGet, Path: path, TimeoutMs: 5000,
		}},
	}}, id)
	if err != nil {
		return nil, err
	}
	if res.Executor != protocol.ExecutorObserver || res.Probe == nil || res.Probe.HTTP == nil {
		return nil, fmt.Errorf("probe %s on %s: %+v", path, claim, res)
	}
	return res.Probe, nil
}

// setupAndBake boots the environment's setup claim and bakes it into the
// environment's template, as the product's setup does.
func (r *spikeRun) setupAndBake(t *testing.T) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
	defer cancel()
	claim := "spk-setup-" + time.Now().Format("150405")
	_, took, err := r.acquire(ctx, claim, protocol.SideSetup, protocol.ConsumerSetup, r.baseSHA)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("SPIKE setup claim.acquire to claim.ready: %d ms", took.Milliseconds())
	if p, err := r.probe(ctx, claim, "/orders"); err != nil || p.HTTP.Status != 200 {
		t.Fatalf("the setup's /orders: %+v %v", p, err)
	}
	start := time.Now()
	if err := r.d.hub.Send(ctx, cellID, claim, &protocol.ImageBakeBody{EnvironmentID: r.envID, OrgID: r.orgID, RecipeSha: "recipe-e2e", Sha: r.baseSHA}); err != nil {
		t.Fatalf("image.bake: %v", err)
	}
	r.release(claim)
	for {
		_, ok, _ := r.s.Backend.LatestTemplate(r.orgID, microvm.TemplateKey(r.envID), isolation.ShapeEnvironment)
		left, _ := r.s.Driver.List(context.Background(), map[string]string{"kodus:claim": claim, "kodus:role": "workload"})
		if ok && len(left) == 0 {
			break
		}
		if time.Since(start) > 10*time.Minute {
			t.Fatal("the bake made no template")
		}
		time.Sleep(time.Second)
	}
	t.Logf("SPIKE image.bake to the environment's template: %d ms", time.Since(start).Milliseconds())
}

// hostSample is what the monitor reads from the host every interval.
type hostSample struct {
	vmms                        int
	memAvailMB                  int
	vmmMemMB, vmmAnonMB         int
	load1                       string
	failEntry, invalidVMCS, oom int
}

func sampleHost() hostSample {
	var h hostSample
	ents, _ := os.ReadDir("/proc")
	for _, e := range ents {
		if _, err := strconv.Atoi(e.Name()); err != nil {
			continue
		}
		if comm, _ := os.ReadFile("/proc/" + e.Name() + "/comm"); strings.TrimSpace(string(comm)) == "firecracker" {
			h.vmms++
		}
	}
	if f, err := os.Open("/proc/meminfo"); err == nil {
		sc := bufio.NewScanner(f)
		for sc.Scan() {
			if v, ok := strings.CutPrefix(sc.Text(), "MemAvailable:"); ok {
				kb, _ := strconv.Atoi(strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(v), "kB")))
				h.memAvailMB = kb / 1024
			}
		}
		_ = f.Close()
	}
	// What the VMMs' cgroups hold: memory.current (anon + the page cache
	// charged to them) and the anon part alone (the guests' touched memory).
	cgs, _ := filepath.Glob("/sys/fs/cgroup/kodus-microvm/kfc-*")
	for _, cg := range cgs {
		if b, err := os.ReadFile(filepath.Join(cg, "memory.current")); err == nil {
			v, _ := strconv.ParseInt(strings.TrimSpace(string(b)), 10, 64)
			h.vmmMemMB += int(v >> 20)
		}
		if b, err := os.ReadFile(filepath.Join(cg, "memory.stat")); err == nil {
			for _, l := range strings.Split(string(b), "\n") {
				if v, ok := strings.CutPrefix(l, "anon "); ok {
					n, _ := strconv.ParseInt(v, 10, 64)
					h.vmmAnonMB += int(n >> 20)
				}
			}
		}
	}
	if b, err := os.ReadFile("/proc/loadavg"); err == nil {
		h.load1 = strings.Fields(string(b))[0]
	}
	out, _ := exec.Command("dmesg").Output()
	for _, l := range strings.Split(string(out), "\n") {
		switch {
		case strings.Contains(l, "FAIL_ENTRY"):
			h.failEntry++
		case strings.Contains(l, "invalid VMCS"):
			h.invalidVMCS++
		case strings.Contains(l, "Killed process") && strings.Contains(l, "firecracker"):
			h.oom++
		}
	}
	return h
}

// vmmLogFailures counts the lines of the VMM logs the cell keeps
// (<state>/vm/vmlogs) that name a failed VM entry or a vCPU's exit.
func vmmLogFailures(state string) map[string]int {
	out := map[string]int{}
	files, _ := filepath.Glob(filepath.Join(state, "vm", "vmlogs", "*"))
	for _, p := range files {
		b, err := os.ReadFile(p)
		if err != nil || len(b) > 64<<20 {
			continue
		}
		for _, k := range []string{"FAIL_ENTRY", "KVM_EXIT_SHUTDOWN", "KVM_EXIT_INTERNAL_ERROR", "Vcpu exit"} {
			out[k] += strings.Count(string(b), k)
		}
	}
	for k, v := range out {
		if v == 0 {
			delete(out, k)
		}
	}
	return out
}

type opStats struct {
	mu   sync.Mutex
	ok   map[string][]time.Duration
	fail map[string][]string
}

func (o *opStats) add(op string, took time.Duration, err error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if err != nil {
		o.fail[op] = append(o.fail[op], time.Now().UTC().Format("15:04:05")+" "+err.Error())
		return
	}
	o.ok[op] = append(o.ok[op], took)
}

func spikePct(ds []time.Duration, p float64) time.Duration {
	if len(ds) == 0 {
		return 0
	}
	s := slices.Clone(ds)
	slices.Sort(s)
	return s[min(len(s)-1, int(float64(len(s))*p))]
}

// N demo-shop Runs at once on this host, held for M minutes: each Run is a
// base and a PR environment VM (4 GiB, 2 vCPU) restored from the
// environment's template, each with its observer VM, a round snapshot per
// side at first ready, then a loop of what a Run does while the agent tests:
// probes through the observers, 20 s of CPU and disk work in both VMs,
// memory resets to the round, and every fourth time a compose reset of the
// PR side. The host is sampled every 30 s for VMMs alive, memory, load and
// the kernel's VM-entry failures; every failed step is logged with its time.
func TestNestedSpikeRunDensity(t *testing.T) {
	n := envInt("KODY_E2E_DENSITY_RUNS", 0)
	if n == 0 {
		t.Skip("KODY_E2E_DENSITY_RUNS=N runs N demo-shop Runs at once")
	}
	minutes := envInt("KODY_E2E_DENSITY_MINUTES", 30)
	hard := time.Now().Add(time.Duration(minutes)*time.Minute + 60*time.Minute)
	r := newSpikeRun(t, hard)
	before := sampleHost()
	t.Logf("SPIKE host before: %+v", before)
	r.setupAndBake(t)

	type run struct {
		base, pr string
		roundB   string
		roundP   string
		imageID  string
		orders   string
	}
	runs := make([]*run, n)
	stats := &opStats{ok: map[string][]time.Duration{}, fail: map[string][]string{}}
	stamp := time.Now().Format("150405")
	// The hub renews a claim's lease while its Run lives; the stub does not,
	// so the test does, every minute, for every Run claim acquired so far.
	var liveMu sync.Mutex
	var live []string
	rctx, rcancel := context.WithCancel(context.Background())
	defer rcancel()
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
				if err := r.d.hub.Send(rctx, cellID, c, &protocol.ClaimRenewBody{LeaseExpiresAt: protocol.FormatTime(time.Now().Add(5 * time.Minute))}); err != nil && rctx.Err() == nil {
					t.Logf("SPIKE renew %s: %v", c, err)
				}
			}
		}
	}()
	for i := range n {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
		ru := &run{base: fmt.Sprintf("spk-base-%d-%s", i, stamp), pr: fmt.Sprintf("spk-pr-%d-%s", i, stamp)}
		t.Cleanup(func() { r.release(ru.base); r.release(ru.pr) })
		var wg sync.WaitGroup
		var errB, errP error
		wg.Go(func() {
			var took time.Duration
			_, took, errB = r.acquire(ctx, ru.base, protocol.SideBase, protocol.ConsumerRuntime, r.baseSHA)
			stats.add("acquire_base", took, errB)
			t.Logf("SPIKE run %d base claim.acquire to claim.ready: %d ms", i, took.Milliseconds())
		})
		wg.Go(func() {
			var took time.Duration
			var ready *protocol.ClaimReadyBody
			ready, took, errP = r.acquire(ctx, ru.pr, protocol.SidePr, protocol.ConsumerRuntime, r.prSHA)
			if errP == nil {
				ru.imageID = ready.Manifest.ImageID
			}
			stats.add("acquire_pr", took, errP)
			t.Logf("SPIKE run %d pr claim.acquire to claim.ready: %d ms", i, took.Milliseconds())
		})
		wg.Wait()
		if errB != nil || errP != nil {
			cancel()
			t.Fatalf("run %d: %v %v", i, errB, errP)
		}
		liveMu.Lock()
		live = append(live, ru.base, ru.pr)
		liveMu.Unlock()
		bo, err1 := r.probe(ctx, ru.base, "/orders")
		po, err2 := r.probe(ctx, ru.pr, "/orders")
		if err := errors.Join(err1, err2); err != nil || bo.HTTP.Body != po.HTTP.Body {
			cancel()
			t.Fatalf("run %d first probes: %v", i, err)
		}
		ru.orders = bo.HTTP.Body
		// The rounds, both sides at once, as the worker takes them.
		wg.Go(func() {
			id, start := hubclient.NewID(), time.Now()
			res, err := r.step(ctx, ru.base, &protocol.ClaimSnapshotBody{StepID: id, Purpose: protocol.ClaimSnapshotBodyPurposeRound}, id)
			if err == nil && res.Snapshot == nil {
				err = fmt.Errorf("round: %+v", res)
			}
			stats.add("round_snapshot", time.Since(start), err)
			if err == nil {
				ru.roundB = res.Snapshot.ID
			}
			t.Logf("SPIKE run %d base round snapshot: %d ms %v", i, time.Since(start).Milliseconds(), err)
		})
		wg.Go(func() {
			id, start := hubclient.NewID(), time.Now()
			res, err := r.step(ctx, ru.pr, &protocol.ClaimSnapshotBody{StepID: id, Purpose: protocol.ClaimSnapshotBodyPurposeRound}, id)
			if err == nil && res.Snapshot == nil {
				err = fmt.Errorf("round: %+v", res)
			}
			stats.add("round_snapshot", time.Since(start), err)
			if err == nil {
				ru.roundP = res.Snapshot.ID
			}
			t.Logf("SPIKE run %d pr round snapshot: %d ms %v", i, time.Since(start).Milliseconds(), err)
		})
		wg.Wait()
		cancel()
		if ru.roundB == "" || ru.roundP == "" {
			t.Fatalf("run %d has no rounds", i)
		}
		runs[i] = ru
	}
	afterUp := sampleHost()
	t.Logf("SPIKE host with %d Runs up: %+v", n, afterUp)

	deadline := time.Now().Add(time.Duration(minutes) * time.Minute)
	mctx, mcancel := context.WithCancel(context.Background())
	var mwg sync.WaitGroup
	minMem, maxVMMs := afterUp.memAvailMB, afterUp.vmms
	maxVMMMem, maxAnon := afterUp.vmmMemMB, afterUp.vmmAnonMB
	mwg.Go(func() {
		tick := time.NewTicker(30 * time.Second)
		defer tick.Stop()
		for {
			select {
			case <-mctx.Done():
				return
			case <-tick.C:
				h := sampleHost()
				minMem, maxVMMs = min(minMem, h.memAvailMB), max(maxVMMs, h.vmms)
				maxVMMMem, maxAnon = max(maxVMMMem, h.vmmMemMB), max(maxAnon, h.vmmAnonMB)
				t.Logf("SPIKE sample t=%s vmms=%d memAvailMB=%d vmmMemMB=%d vmmAnonMB=%d load1=%s failEntry=%d vmcs=%d oomFirecracker=%d",
					time.Now().UTC().Format("15:04:05"), h.vmms, h.memAvailMB, h.vmmMemMB, h.vmmAnonMB, h.load1, h.failEntry-before.failEntry, h.invalidVMCS-before.invalidVMCS, h.oom-before.oom)
			}
		}
	})

	workload := func(claim string) (driver.MachineRef, error) {
		refs, err := r.s.Driver.List(context.Background(), map[string]string{"kodus:claim": claim, "kodus:role": "workload"})
		if err != nil || len(refs) != 1 {
			return driver.MachineRef{}, fmt.Errorf("workload of %s: %d machines, %w", claim, len(refs), err)
		}
		return refs[0], nil
	}
	const load = `timeout 20 sh -c 'yes >/dev/null & yes >/dev/null & dd if=/dev/zero of=/var/tmp/spike bs=1M count=256 oflag=direct 2>/dev/null; wait'; rm -f /var/tmp/spike; true`
	var wg sync.WaitGroup
	iters := make([]int, n)
	for i, ru := range runs {
		wg.Go(func() {
			for k := 0; time.Now().Before(deadline); k++ {
				ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
				for _, side := range []string{ru.base, ru.pr} {
					start := time.Now()
					p, err := r.probe(ctx, side, "/orders")
					if err == nil && p.HTTP.Status != 200 {
						err = fmt.Errorf("status %d", p.HTTP.Status)
					}
					stats.add("probe", time.Since(start), err)
				}
				var lw sync.WaitGroup
				for _, side := range []string{ru.base, ru.pr} {
					lw.Go(func() {
						start := time.Now()
						ref, err := workload(side)
						if err == nil {
							var res kodyexec.Result
							res, err = r.s.Driver.Exec(ctx, ref, kodyexec.Request{Command: load, TimeoutMs: 60_000})
							if err == nil && res.ExitCode != 0 {
								err = fmt.Errorf("load exit %d: %s", res.ExitCode, res.Stderr)
							}
						}
						stats.add("cpu_disk_load_20s", time.Since(start), err)
					})
				}
				lw.Wait()
				for _, sd := range []struct{ claim, round string }{{ru.base, ru.roundB}, {ru.pr, ru.roundP}} {
					id, start := hubclient.NewID(), time.Now()
					res, err := r.step(ctx, sd.claim, &protocol.MachineResetBody{StepID: id, Snapshot: protocol.Snapshot{Kind: protocol.SnapshotKindMemory, Ref: sd.round}}, id)
					if err == nil && res.Exec != nil {
						err = fmt.Errorf("memory reset: %+v", res.Exec)
					}
					if err == nil {
						var p *protocol.ProbeResult
						if p, err = r.probe(ctx, sd.claim, "/orders"); err == nil && p.HTTP.Body != ru.orders {
							err = fmt.Errorf("after memory reset: %s", p.HTTP.Body)
						}
					}
					stats.add("memory_reset_to_probe", time.Since(start), err)
				}
				if k%4 == 3 {
					id, start := hubclient.NewID(), time.Now()
					res, err := r.step(ctx, ru.pr, &protocol.MachineResetBody{StepID: id, Snapshot: protocol.Snapshot{Kind: protocol.SnapshotKindComposeVolumes, Ref: ru.imageID + ":seed"}}, id)
					if err == nil && res.Exec != nil {
						err = fmt.Errorf("compose reset: %+v", res.Exec)
					}
					if err == nil {
						_, err = r.probe(ctx, ru.pr, "/orders")
					}
					stats.add("compose_reset_to_probe", time.Since(start), err)
				}
				cancel()
				iters[i] = k + 1
			}
		})
	}
	wg.Wait()
	mcancel()
	mwg.Wait()
	end := sampleHost()
	vmmLog := vmmLogFailures(os.Getenv("KODY_E2E_FIRECRACKER_STATE"))
	t.Logf("SPIKE density runs=%d minutes=%d iterations=%v", n, minutes, iters)
	t.Logf("SPIKE VMM cgroups at most %d MB (anon %d MB)", maxVMMMem, maxAnon)
	t.Logf("SPIKE host end: %+v; max VMMs %d; min MemAvailable %d MB; failEntry %d, vmcs %d, oom %d since start; VMM log hits %v",
		end, maxVMMs, minMem, end.failEntry-before.failEntry, end.invalidVMCS-before.invalidVMCS, end.oom-before.oom, vmmLog)
	ops := make([]string, 0, len(stats.ok)+len(stats.fail))
	for op := range stats.ok {
		ops = append(ops, op)
	}
	for op := range stats.fail {
		if _, ok := stats.ok[op]; !ok {
			ops = append(ops, op)
		}
	}
	slices.Sort(ops)
	failed := 0
	for _, op := range ops {
		ds := stats.ok[op]
		t.Logf("SPIKE op %-24s ok=%d fail=%d p50=%s p95=%s max=%s", op, len(ds), len(stats.fail[op]), spikePct(ds, 0.5).Round(time.Millisecond), spikePct(ds, 0.95).Round(time.Millisecond), spikePct(ds, 1).Round(time.Millisecond))
		for _, f := range stats.fail[op] {
			t.Logf("SPIKE fail %s: %s", op, f)
		}
		failed += len(stats.fail[op])
	}
	t.Logf("SPIKE other events: %v", r.d.other)
	if failed > 0 || end.failEntry > before.failEntry || end.oom > before.oom {
		t.Errorf("SPIKE density: %d failed steps, %d new FAIL_ENTRY, %d VMMs OOM-killed", failed, end.failEntry-before.failEntry, end.oom-before.oom)
	}
}

// templateEnv is the environment whose template the two tests below keep
// and restore: the org and key are the product's (TemplateKey).
func templateEnv(t *testing.T) string {
	t.Helper()
	env := os.Getenv("KODY_E2E_TEMPLATE_ENV")
	if env == "" {
		t.Skip("KODY_E2E_TEMPLATE_ENV names the environment whose template is kept and restored")
	}
	return env
}

const spikeProbe = `P=$(docker compose ls -aq | head -n1); port=$(docker compose -p "$P" -f .kodus-compose.yml port app 3000 | sed 's/.*://'); curl -fsS "http://127.0.0.1:$port/orders"`

// The setup of demo-shop's main in an environment VM, kept as the
// environment's template under the product's key, and left in the store
// for another host to restore (S3, an EBS snapshot).
func TestNestedSpikeKeepTemplate(t *testing.T) {
	env := templateEnv(t)
	if os.Getenv("KODY_E2E_TEMPLATE_KEEP") != "1" {
		t.Skip("KODY_E2E_TEMPLATE_KEEP=1 makes the template and leaves it")
	}
	base := os.Getenv("KODY_E2E_KRSHOP_BASE")
	if base == "" {
		t.Skip("KODY_E2E_KRSHOP_BASE is demo-shop's main checkout")
	}
	s := open(t)
	e := startEgress(t, s.Place.Egress().String())
	ctx := context.Background()
	claim := "spk-keep-" + time.Now().Format("150405")
	n := claimNet(t, s.Driver, claim)
	start := time.Now()
	src, err := s.Driver.Create(ctx, machineSpec(claim, n, driver.RoleWorkload, func(m *driver.MachineSpec) {
		m.Setup, m.ImageID, m.ImageRef, m.ClaimSize = true, "environment", "environment", driver.ClaimSize{MemoryMB: 4096, CPUs: 2}
		m.HardExpiresAt = time.Now().Add(time.Hour)
	}))
	if err != nil {
		t.Fatal(err)
	}
	if err := e.Allow(ctx, claim, "org-fc", n, []string{src.PrivateAddress}, krShopHosts); err != nil {
		t.Fatal(err)
	}
	if r, err := s.Driver.Exec(ctx, src, kodyexec.Request{Command: "for i in $(seq 120); do docker info >/dev/null 2>&1 && exit 0; sleep 0.5; done; exit 1", TimeoutMs: 90_000}); err != nil || r.ExitCode != 0 {
		t.Fatalf("dockerd: %+v %v", r, err)
	}
	t.Logf("SPIKE keep: VM boot to dockerd: %d ms", time.Since(start).Milliseconds())
	compose, err := os.ReadFile(filepath.Join(base, "docker-compose.yml"))
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Driver.Upload(ctx, src, base, "workspace/repo", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Driver.Up(ctx, driver.UpRequest{Ref: src, Compose: compose, ProjectDir: base}); err != nil {
		t.Fatal(err)
	}
	t.Logf("SPIKE keep: cold setup (boot + upload + build + up to healthy): %d ms", time.Since(start).Milliseconds())
	r, err := s.Driver.Exec(ctx, src, kodyexec.Request{Command: spikeProbe, Cwd: "workspace/repo", TimeoutMs: 30_000})
	if err != nil || r.ExitCode != 0 {
		t.Fatalf("probe: %+v %v", r, err)
	}
	start = time.Now()
	snap, _, err := s.Driver.SnapshotMachine(ctx, src, string(isolation.PurposeTemplate), microvm.TemplateKey(env))
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("SPIKE keep: template org=%s key=%s id=%s store=%s/%s/%s in %d ms; /orders %s", snap.OrgID, microvm.TemplateKey(env), snap.ID,
		s.Backend.Store().Dir(), "<OrgKey>", snap.ID, time.Since(start).Milliseconds(), strings.TrimSpace(r.Stdout))
}

// The environment's latest template on this host, restored three times:
// to the guest agent's first answer (CreateFrom) and to demo-shop's first
// answer inside the VM. The first restore reads the template from wherever
// it lies (a lazily loaded EBS volume, the files just downloaded), the next
// two from the page cache.
func TestNestedSpikeRestoreTemplate(t *testing.T) {
	env := templateEnv(t)
	if os.Getenv("KODY_E2E_TEMPLATE_KEEP") == "1" {
		t.Skip("KODY_E2E_TEMPLATE_KEEP=1 is the keeping run")
	}
	start := time.Now()
	s := open(t)
	t.Logf("SPIKE restore: backend open (kit verified, host probed): %d ms", time.Since(start).Milliseconds())
	tpl, ok, err := s.Backend.LatestTemplate("org-fc", microvm.TemplateKey(env), isolation.ShapeEnvironment)
	if err != nil || !ok {
		t.Fatalf("no restorable template of %s here (key %s): %v", env, microvm.TemplateKey(env), err)
	}
	ctx := context.Background()
	for i := range 3 {
		claim := fmt.Sprintf("spk-rst-%d-%s", i, time.Now().Format("150405"))
		n := claimNet(t, s.Driver, claim)
		start := time.Now()
		ref, err := s.Driver.CreateFrom(ctx, machineSpec(claim, n, driver.RoleWorkload, func(m *driver.MachineSpec) {
			m.ImageID, m.ImageRef, m.ClaimSize = "environment", "environment", driver.ClaimSize{MemoryMB: 4096, CPUs: 2}
		}), tpl)
		if err != nil {
			t.Fatal(err)
		}
		restored := time.Since(start)
		r, err := s.Driver.Exec(ctx, ref, kodyexec.Request{Command: spikeProbe, Cwd: "workspace/repo", TimeoutMs: 120_000})
		if err != nil || r.ExitCode != 0 {
			t.Fatalf("probe after restore %d: %+v %v", i, r, err)
		}
		t.Logf("SPIKE restore %d: CreateFrom %d ms, demo-shop's /orders answered at %d ms: %s", i, restored.Milliseconds(), time.Since(start).Milliseconds(), strings.TrimSpace(r.Stdout))
		_ = s.Driver.Destroy(ctx, ref)
	}
}
