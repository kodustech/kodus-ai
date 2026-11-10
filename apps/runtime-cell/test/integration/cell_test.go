// Package integration runs the cell agent with the fake driver against the
// hub stub over a real mTLS WebSocket, and completes
// claim.acquire -> probe.run -> step.result.
package integration

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/tls"
	"errors"
	"io"
	"log"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver/fake"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/gitsource"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/hubclient"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/observer"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/tarball"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/testing/hubstub"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/testpki"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/transport"
)

const sha = "0123456789abcdef0123456789abcdef01234567"

// recEgress records every policy the agent pushes.
type recEgress struct {
	applied chan agent.ClaimInfo
	removed chan string
}

func (r *recEgress) Apply(_ context.Context, c agent.ClaimInfo) error {
	select {
	case r.applied <- c:
	default:
	}
	return nil
}

// Denied is what the proxy refused for the claim (the failure bundle).
func (r *recEgress) Denied(claimID string) []agent.DeniedEgress {
	return []agent.DeniedEgress{{Host: "registry.npmjs.org", Port: 443, At: time.Unix(1_800_000_000, 0)}}
}

func (r *recEgress) Remove(_ context.Context, claimID string) error {
	select {
	case r.removed <- claimID:
	default:
	}
	return nil
}

// syncBuf is a log sink the test can read while the agent writes.
type syncBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuf) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuf) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

type world struct {
	egress   *recEgress
	logs     *syncBuf
	hub      *hubstub.Hub
	hubURL   string
	ca       *testpki.CA
	drv      *fake.Driver
	agent    *agent.Agent
	appPort  int
	revoked  atomic.Int32
	machines string
	cancel   context.CancelFunc
	done     chan struct{}
}

func repoTarball(t *testing.T) []byte {
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for name, body := range map[string]string{"o-r-0123/README.md": "hello", "o-r-0123/src/app.js": "console.log(1)"} {
		_ = tw.WriteHeader(&tar.Header{Name: name, Typeflag: tar.TypeReg, Mode: 0o644, Size: int64(len(body))})
		_, _ = tw.Write([]byte(body))
	}
	_ = tw.Close()
	_ = gz.Close()
	return buf.Bytes()
}

func cellTLS(t *testing.T, ca *testpki.CA, cn string) *tls.Config {
	t.Helper()
	cert, err := ca.Issue(cn, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	return &tls.Config{Certificates: []tls.Certificate{cert}, RootCAs: ca.Pool()}
}

func newWorld(t *testing.T, setup ...func(*hubstub.Hub)) *world {
	t.Helper()
	w := &world{hub: hubstub.New(), drv: fake.New(), machines: t.TempDir(), done: make(chan struct{}),
		egress: &recEgress{applied: make(chan agent.ClaimInfo, 64), removed: make(chan string, 64)}, logs: &syncBuf{}}
	// The world stands for a production cell: VM isolation.
	w.drv.Isolation = driver.IsolationVM
	for _, f := range setup {
		f(w.hub)
	}
	var err error
	if w.ca, err = testpki.NewCA("kodus-test-ca"); err != nil {
		t.Fatal(err)
	}
	serverCert, _ := w.ca.Issue("runtime-hub", time.Hour, "127.0.0.1")
	hub := httptest.NewUnstartedServer(w.hub)
	hub.Config.ErrorLog = log.New(io.Discard, "", 0)
	hub.TLS = w.hub.TLSConfig(serverCert, w.ca.Pool())
	hub.StartTLS()
	t.Cleanup(hub.Close)
	w.hubURL = "wss://" + strings.TrimPrefix(hub.URL, "https://") + "/v1/cell"

	app := httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/users":
			rw.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(rw, `[{"id":1,"name":"ana"}]`)
		default:
			rw.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(app.Close)
	w.appPort, _ = strconv.Atoi(app.URL[strings.LastIndex(app.URL, ":")+1:])

	tarballBytes := repoTarball(t)
	git := httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/repos/o/r/tarball/"+sha:
			if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ghs_") {
				rw.WriteHeader(http.StatusUnauthorized)
				return
			}
			_, _ = rw.Write(tarballBytes)
		case r.Method == http.MethodDelete && r.URL.Path == "/installation/token":
			w.revoked.Add(1)
			rw.WriteHeader(http.StatusNoContent)
		default:
			rw.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(git.Close)

	w.agent, err = agent.New(agent.Config{
		CellID:    "cell-1",
		Regions:   []string{"local"},
		Driver:    w.drv,
		Transport: transport.Local{Root: w.machines},
		Observers: func(_ context.Context, c agent.ClaimInfo, targets []observer.Target) (observer.Client, error) {
			return observer.InProcess{Runner: observer.New(observer.Config{ImageID: c.Workload.ImageID, Targets: targets})}, nil
		},
		Repo: func(acq protocol.ClaimAcquireBody) (string, error) {
			return git.URL + "/repos/o/r/tarball/" + acq.Sha, nil
		},
		Extractor:    tarball.InProcessExtractor{},
		Revoker:      gitsource.GitHub{APIBase: git.URL},
		OrgKey:       func(org string) (string, error) { return "kms-" + org, nil },
		Egress:       w.egress,
		DeniedEgress: w.egress,
		Diagnoser:    w.drv,
		WorkDir:      t.TempDir(),
		Log:          slog.New(slog.NewTextHandler(w.logs, nil)),
		// Resends of claim.ready / claim.failed, fast for the tests.
		SettleBackoff: 20 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	w.cancel = cancel
	go func() {
		defer close(w.done)
		_ = w.agent.Run(ctx, agent.RunConfig{HubURL: w.hubURL, TLS: cellTLS(t, w.ca, "cell-1"), HeartbeatEvery: 100 * time.Millisecond, DeadManEvery: 50 * time.Millisecond, Backoff: 50 * time.Millisecond, AckTimeout: time.Second})
	}()
	t.Cleanup(func() { cancel(); <-w.done })
	select {
	case cell := <-w.hub.Hellos():
		if cell != "cell-1" {
			t.Fatalf("hello from %s", cell)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("cell never said hello")
	}
	return w
}

func (w *world) acquireBody(org string) *protocol.ClaimAcquireBody {
	return &protocol.ClaimAcquireBody{Repo: protocol.RepoRef{Provider: protocol.GitProviderGithub, FullName: "o/r", APIBase: "https://api.github.com"},
		OrgID: org, EnvironmentID: "env-1", ImageID: "img-1", Side: protocol.SideBase, Sha: sha,
		Consumer: protocol.ConsumerRuntime, RepoToken: "ghs_download",
		Expose:        []protocol.Expose{{Service: "api", Port: int64(w.appPort), Kind: protocol.ExposeKindHTTP}},
		HardExpiresAt: time.Now().Add(55 * time.Minute).UTC().Format(time.RFC3339),
	}
}

func (w *world) acquire(t *testing.T, ctx context.Context, claim, org string, edit ...func(*protocol.ClaimAcquireBody)) *protocol.ClaimReadyBody {
	t.Helper()
	body := w.acquireBody(org)
	for _, f := range edit {
		f(body)
	}
	err := w.hub.Send(ctx, "cell-1", claim, body)
	if err != nil {
		t.Fatalf("claim.acquire: %v", err)
	}
	// The claim is bound on the hub only by claim.ready.
	ready, err := w.hub.WaitReady(ctx, claim)
	if err != nil {
		t.Fatalf("claim never ready: %v", err)
	}
	if st := w.hub.ClaimState(claim); st != hubstub.ClaimReady {
		t.Fatalf("hub claim state %q", st)
	}
	return ready
}

func probeRun(step string, port int, path string) *protocol.ProbeRunBody {
	return &protocol.ProbeRunBody{StepID: step, Probe: protocol.Probe{
		ID: "list-users", Origin: protocol.ProbeOriginAgent, Purpose: "list users", Expected: "200 with ana",
		Compare: []protocol.CompareField{protocol.CompareFieldStatus, protocol.CompareFieldJSON},
		Spec: protocol.ProbeSpec{HTTP: &protocol.HTTPProbe{
			Target: protocol.ProbeTarget{Service: "api", Port: int64(port)}, Method: protocol.HTTPMethodGet, Path: path, TimeoutMs: 3000,
		}},
	}}
}

func stepResult(step string) func(hubstub.Event) bool {
	return func(e hubstub.Event) bool {
		r, ok := e.Body.(*protocol.StepResultBody)
		return ok && r.StepID == step
	}
}

func TestClaimAcquireProbeRunStepResult(t *testing.T) {
	w := newWorld(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	ready := w.acquire(t, ctx, "claim-1", "org-a")
	if w.agent.Version() != protocol.ProtocolVersion {
		t.Fatalf("negotiated version %d", w.agent.Version())
	}
	if w.revoked.Load() != 1 {
		t.Fatalf("download token revoked %d times", w.revoked.Load())
	}
	var workload driver.MachineRef
	for _, m := range w.drv.Machines() {
		if m.Spec.Role == driver.RoleWorkload {
			workload = m.Ref
		}
		if m.Spec.KMSKeyRef != "kms-org-a" || m.Ref.Tags[driver.TagHardExpires] == "" {
			t.Fatalf("machine %+v", m.Spec)
		}
	}
	if b, err := os.ReadFile(filepath.Join(w.machines, workload.MachineID, "workspace", "README.md")); err != nil || string(b) != "hello" {
		t.Fatalf("code not uploaded: %v", err)
	}
	m := ready.Manifest
	if len(m.Services) != 1 || m.Services[0] != (protocol.ManifestService{Name: "api", Health: protocol.ServiceHealthOk}) ||
		len(m.Expose) != 1 || m.Expose[0].Port != int64(w.appPort) || m.ImageID != workload.ImageID || m.SeedSha != "unknown" {
		t.Fatalf("manifest %+v", m)
	}
	if ready.Observer.State != protocol.ObserverPhaseReady || ready.Observer.ID == "" || ready.Observer.ID == workload.MachineID {
		t.Fatalf("observer %+v", ready.Observer)
	}

	step := hubclient.NewID()
	if err := w.hub.Send(ctx, "cell-1", "claim-1", probeRun(step, w.appPort, "/users")); err != nil {
		t.Fatalf("probe.run: %v", err)
	}
	ev, err := w.hub.WaitFor(ctx, stepResult(step))
	if err != nil {
		t.Fatal(err)
	}
	res := ev.Body.(*protocol.StepResultBody)
	if res.Executor != protocol.ExecutorObserver || res.VMHealth != protocol.VMHealthOk || res.ImageID != "img-1" {
		t.Fatalf("result %+v", res)
	}
	if res.Probe == nil || res.Probe.HTTP.Status != 200 || !strings.Contains(res.Probe.HTTP.Body, "ana") {
		t.Fatalf("probe %+v", res.Probe)
	}
	if len(res.Probe.Requests) != 1 || res.Probe.Requests[0].Route != "/users" || res.Probe.Requests[0].Method != "GET" {
		t.Fatalf("request log %+v", res.Probe.Requests)
	}

	// exec on the VM: evidence, not a verdict; runs in the uploaded code.
	execStep := hubclient.NewID()
	if err := w.hub.Send(ctx, "cell-1", "claim-1", &protocol.ExecBody{StepID: execStep, Command: "cat README.md", TimeoutMs: 5000}); err != nil {
		t.Fatal(err)
	}
	ev, err = w.hub.WaitFor(ctx, stepResult(execStep))
	if err != nil {
		t.Fatal(err)
	}
	if r := ev.Body.(*protocol.StepResultBody); r.Executor != protocol.ExecutorVM || r.Exec == nil || r.Exec.Stdout != "hello" {
		t.Fatalf("exec %+v", r)
	}

	// claim.renew is capped at the ceiling; claim.release destroys it all.
	if err := w.hub.Send(ctx, "cell-1", "claim-1", &protocol.ClaimRenewBody{LeaseExpiresAt: time.Now().Add(10 * time.Minute).UTC().Format(time.RFC3339)}); err != nil {
		t.Fatal(err)
	}
	if err := w.hub.Send(ctx, "cell-1", "claim-1", &protocol.ClaimReleaseBody{}); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for len(w.drv.Machines()) != 0 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if len(w.drv.Machines()) != 0 {
		t.Fatal("machines left after claim.release")
	}
}

// S-30 on the live connection: ambiguous frames get a nack and never a step.
func TestS30ProtocolFuzzOnTheWire(t *testing.T) {
	w := newWorld(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	w.acquire(t, ctx, "claim-1", "org-a")

	expectNack := func(name string, err error, code string) {
		t.Helper()
		var n *hubclient.NackError
		if !errors.As(err, &n) || n.Code != code {
			t.Fatalf("%s: want nack %s, got %v", name, code, err)
		}
	}

	// Duplicate key and case variant: the cell cannot even read the id, so
	// the nack has no re; send and check no step ran.
	id := hubclient.NewID()
	dup := `{"v":1,"id":"` + id + `","cellId":"cell-1","cellId":"cell-1","claimId":"claim-1","type":"exec","body":{"stepId":"` + hubclient.NewID() + `","command":"touch pwned","timeoutMs":1000}}`
	_ = w.hub.SendRaw(ctx, "cell-1", "", []byte(dup))
	caseVar := `{"v":1,"id":"` + id + `","cellid":"cell-1","claimId":"claim-1","type":"exec","body":{"stepId":"` + hubclient.NewID() + `","command":"touch pwned","timeoutMs":1000}}`
	_ = w.hub.SendRaw(ctx, "cell-1", "", []byte(caseVar))

	// Same stepId with another command: nack step_conflict.
	step := hubclient.NewID()
	if err := w.hub.Send(ctx, "cell-1", "claim-1", &protocol.ExecBody{StepID: step, Command: "echo one", TimeoutMs: 2000}); err != nil {
		t.Fatal(err)
	}
	expectNack("same step, other command", w.hub.Send(ctx, "cell-1", "claim-1", &protocol.ExecBody{StepID: step, Command: "touch pwned", TimeoutMs: 2000}), "step_conflict")
	// Same stepId, same command: ack, never run twice.
	if err := w.hub.Send(ctx, "cell-1", "claim-1", &protocol.ExecBody{StepID: step, Command: "echo one", TimeoutMs: 2000}); err != nil {
		t.Fatal(err)
	}
	// Unknown claim and a message type the hub never sends.
	expectNack("unknown claim", w.hub.Send(ctx, "cell-1", "claim-x", &protocol.ExecBody{StepID: hubclient.NewID(), Command: "id", TimeoutMs: 1000}), "unknown_claim")
	expectNack("unexpected type", w.hub.Send(ctx, "cell-1", "claim-1", &protocol.HeartbeatBody{Claims: []protocol.HeartbeatClaim{}}), "unexpected_type")

	results := 0
	waitCtx, waitCancel := context.WithTimeout(ctx, 2*time.Second)
	defer waitCancel()
	for {
		if _, err := w.hub.WaitFor(waitCtx, stepResult(step)); err != nil {
			break
		}
		results++
	}
	if results != 1 {
		t.Fatalf("step ran %d times", results)
	}
	if _, err := os.Stat(filepath.Join(w.machines, "m-1", "workspace", "pwned")); err == nil {
		t.Fatal("a refused frame ran")
	}
	// A 2 MiB frame: the cell closes the connection (read limit 1 MiB),
	// runs nothing, and reconnects with a new hello.
	big := `{"v":1,"id":"` + id + `","cellId":"cell-1","claimId":"claim-1","type":"exec","body":{"stepId":"` + hubclient.NewID() + `","command":"touch pwned","cwd":"` + strings.Repeat("a", 2<<20) + `","timeoutMs":1000}}`
	_ = w.hub.SendRaw(ctx, "cell-1", "", []byte(big))
	select {
	case <-w.hub.Hellos():
	case <-time.After(5 * time.Second):
		t.Fatal("cell did not reconnect after the oversized frame")
	}
	if _, err := os.Stat(filepath.Join(w.machines, "m-1", "workspace", "pwned")); err == nil {
		t.Fatal("the oversized frame ran")
	}
}

// S-15 (hub side, as the stub enforces it): a cell answering a step of
// another cell, or speaking with another cell's id, is a violation; a
// revoked or foreign certificate never connects.
func TestS15CellIdentity(t *testing.T) {
	w := newWorld(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	w.acquire(t, ctx, "claim-1", "org-a")
	step := hubclient.NewID()
	if err := w.hub.Send(ctx, "cell-1", "claim-1", probeRun(step, w.appPort, "/users")); err != nil {
		t.Fatal(err)
	}

	// cell-2 connects with its own certificate and answers cell-1's step.
	c2, err := hubclient.Dial(ctx, hubclient.Config{URL: w.hubURL, TLS: cellTLS(t, w.ca, "cell-2"), CellID: "cell-2"})
	if err != nil {
		t.Fatal(err)
	}
	go func() { _ = c2.Serve(ctx, func(context.Context, *protocol.Message) error { return nil }) }()
	if err := c2.Request(ctx, protocol.Header{}, &protocol.HelloBody{Versions: []int64{1}, Driver: "fake", Isolation: protocol.IsolationVM, Regions: []string{}, Owner: protocol.CellOwnerKodus}); err != nil {
		t.Fatal(err)
	}
	forged := &protocol.StepResultBody{StepID: step, Executor: protocol.ExecutorObserver, ImageID: "img-1", VMHealth: protocol.VMHealthOk}
	err = c2.Request(ctx, protocol.Header{ClaimID: "claim-1"}, forged)
	var n *hubclient.NackError
	if !errors.As(err, &n) || n.Code != "protocol.violation" {
		t.Fatalf("forged step.result: %v", err)
	}

	// A certificate for cell-3 speaking as cell-1.
	c3, err := hubclient.Dial(ctx, hubclient.Config{URL: w.hubURL, TLS: cellTLS(t, w.ca, "cell-3"), CellID: "cell-1"})
	if err != nil {
		t.Fatal(err)
	}
	go func() { _ = c3.Serve(ctx, func(context.Context, *protocol.Message) error { return nil }) }()
	err = c3.Request(ctx, protocol.Header{}, &protocol.HelloBody{Versions: []int64{1}, Driver: "fake", Isolation: protocol.IsolationVM, Regions: []string{}, Owner: protocol.CellOwnerKodus})
	if err == nil {
		t.Fatal("hub accepted a cell speaking for another")
	}

	// Revoked and foreign certificates never get a connection.
	revokedCfg := cellTLS(t, w.ca, "cell-4")
	w.hub.Revoke(revokedCfg.Certificates[0].Leaf.SerialNumber)
	if _, err := hubclient.Dial(ctx, hubclient.Config{URL: w.hubURL, TLS: revokedCfg, CellID: "cell-4"}); err == nil {
		t.Fatal("revoked certificate connected")
	}
	other, _ := testpki.NewCA("other")
	foreign := cellTLS(t, other, "cell-1")
	foreign.RootCAs = w.ca.Pool()
	if _, err := hubclient.Dial(ctx, hubclient.Config{URL: w.hubURL, TLS: foreign, CellID: "cell-1"}); err == nil {
		t.Fatal("certificate from another CA connected")
	}
	if _, err := hubclient.Dial(ctx, hubclient.Config{URL: w.hubURL, TLS: &tls.Config{RootCAs: w.ca.Pool()}, CellID: "cell-1"}); err == nil {
		t.Fatal("dialed without a client certificate")
	}
	if w.hub.Violations.Load() < 2 {
		t.Fatalf("violations %d", w.hub.Violations.Load())
	}
}

// cell.revoked: the cell stops taking work at once.
func TestRevokedCellRefusesWork(t *testing.T) {
	w := newWorld(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	_ = w.hub.Send(ctx, "cell-1", "", &protocol.CellRevokedBody{Reason: "test"})
	if w.agent.DeadMan().Accepting() {
		t.Fatal("revoked cell still accepting")
	}
}

// S-11: a hub asking org B to take org A's pool machine gets a new machine,
// never A's. No claim is handed a pool machine (pool fill is not in this
// cell yet): org A gets new machines too, and the pool machine is untouched.
func TestS11PoolMachineNeverChangesOrg(t *testing.T) {
	w := newWorld(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	now := time.Now()
	poolA, err := w.drv.Create(ctx, driver.MachineSpec{
		CellID: "cell-1", EnvironmentID: "env-1", Role: driver.RolePool, OrgID: "org-a", ClaimID: "pool-a", ImageID: "img-1",
		ClaimGroupID: "sg-pool", KMSKeyRef: "kms-org-a", ExpiresAt: now.Add(24 * time.Hour), HardExpiresAt: now.Add(7 * 24 * time.Hour),
	})
	if err != nil {
		t.Fatal(err)
	}
	w.acquire(t, ctx, "claim-b", "org-b")
	w.acquire(t, ctx, "claim-a", "org-a")
	for _, m := range w.drv.Machines() {
		if m.Ref.MachineID == poolA.MachineID {
			if m.State != "running" || m.Ref.Tags[driver.TagExpires] != driver.FormatTime(now.Add(24*time.Hour)) {
				t.Fatal("org A's pool machine was touched")
			}
			continue
		}
		if org := m.Ref.Tags[driver.TagClaim][len("claim-"):]; m.Spec.OrgID != "org-"+org || m.Spec.KMSKeyRef != "kms-org-"+org {
			t.Fatalf("machine of %s: %+v", m.Ref.Tags[driver.TagClaim], m.Spec)
		}
	}
	for _, claim := range []string{"claim-a", "claim-b"} {
		l, _ := w.agent.Leases().Get(claim)
		for _, m := range l.Machines {
			if m.MachineID == poolA.MachineID {
				t.Fatalf("%s was handed the pool machine", claim)
			}
		}
	}
}

// S-09 at the cell: a runaway step on one claim does not stop the other
// claim's probe, and machines the cloud cannot give become Blocker resources.
func TestS09CellSurvivesExhaustion(t *testing.T) {
	w := newWorld(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	w.acquire(t, ctx, "claim-pr", "org-a")
	w.acquire(t, ctx, "claim-base", "org-a")

	hog := hubclient.NewID()
	if err := w.hub.Send(ctx, "cell-1", "claim-pr", &protocol.ExecBody{StepID: hog, Command: "while :; do :; done & yes | head -c 40000000", TimeoutMs: 1500}); err != nil {
		t.Fatal(err)
	}
	probe := hubclient.NewID()
	if err := w.hub.Send(ctx, "cell-1", "claim-base", probeRun(probe, w.appPort, "/users")); err != nil {
		t.Fatal(err)
	}
	got := map[string]*protocol.StepResultBody{}
	for len(got) < 2 {
		ev, err := w.hub.WaitFor(ctx, func(e hubstub.Event) bool {
			r, ok := e.Body.(*protocol.StepResultBody)
			return ok && (r.StepID == hog || r.StepID == probe)
		})
		if err != nil {
			t.Fatalf("results so far %v: %v", got, err)
		}
		r := ev.Body.(*protocol.StepResultBody)
		got[r.StepID] = r
	}
	if r := got[probe]; r.Probe == nil || r.Probe.HTTP.Status != 200 {
		t.Fatalf("base side did not carry on: %+v", r)
	}
	if r := got[hog]; r.Exec == nil || r.Exec.ExitCode != 124 || !r.Exec.Truncated {
		t.Fatalf("runaway step: %+v", r.Exec)
	}

	w.drv.SetFailCreate(errors.New("InsufficientInstanceCapacity"))
	if err := w.hub.Send(ctx, "cell-1", "claim-3", &protocol.ClaimAcquireBody{Repo: protocol.RepoRef{Provider: protocol.GitProviderGithub, FullName: "o/r", APIBase: "https://api.github.com"},
		OrgID: "org-a", EnvironmentID: "env-1", ImageID: "img-1", Side: protocol.SidePr, Sha: sha,
		Consumer: protocol.ConsumerRuntime, RepoToken: "ghs_download", Expose: []protocol.Expose{},
		HardExpiresAt: time.Now().Add(30 * time.Minute).UTC().Format(time.RFC3339),
	}); err != nil {
		t.Fatal(err)
	}
	ev, err := w.hub.WaitSettled(ctx, "claim-3")
	if err != nil {
		t.Fatal(err)
	}
	f, ok := ev.Body.(*protocol.ClaimFailedBody)
	if !ok || f.Kind != protocol.BlockerKindResources || f.Signature != "create_workload" || !strings.Contains(f.Reason, "InsufficientInstanceCapacity") {
		t.Fatalf("claim.failed %+v", ev.Body)
	}
	// claim.failed comes after the cleanup: nothing of claim-3 is left.
	if _, ok := w.agent.Leases().Get("claim-3"); ok {
		t.Fatal("lease of the failed claim kept")
	}
	if st := w.hub.ClaimState("claim-3"); st != "" {
		t.Fatalf("hub still holds the failed claim: %q", st)
	}
	expectNack := func(err error, code string) {
		t.Helper()
		var n *hubclient.NackError
		if !errors.As(err, &n) || n.Code != code {
			t.Fatalf("want nack %s, got %v", code, err)
		}
	}
	expectNack(w.hub.Send(ctx, "cell-1", "claim-3", &protocol.ExecBody{StepID: hubclient.NewID(), Command: "id", TimeoutMs: 1000}), "unknown_claim")
	// ceiling past the consumer's limit is refused up front.
	err = w.hub.Send(ctx, "cell-1", "claim-4", &protocol.ClaimAcquireBody{Repo: protocol.RepoRef{Provider: protocol.GitProviderGithub, FullName: "o/r", APIBase: "https://api.github.com"},
		OrgID: "org-a", EnvironmentID: "env-1", ImageID: "img-1", Side: protocol.SidePr, Sha: sha,
		Consumer: protocol.ConsumerRuntime, RepoToken: "ghs_download", Expose: []protocol.Expose{},
		HardExpiresAt: time.Now().Add(5 * time.Hour).UTC().Format(time.RFC3339),
	})
	expectNack(err, "ceiling_exceeded")
}

// egress.policy replaces the claim's extra allowlist; the agent pushes it
// through EgressControl whether it arrives before or after claim.ready.
func TestEgressPolicyReplacesExtraAllow(t *testing.T) {
	w := newWorld(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	var n *hubclient.NackError
	if err := w.hub.SendEgressPolicy(ctx, "cell-1", "claim-x", []string{"a.example"}); !errors.As(err, &n) || n.Code != "unknown_claim" {
		t.Fatalf("egress.policy for an unknown claim: %v", err)
	}

	err := w.hub.Send(ctx, "cell-1", "claim-1", &protocol.ClaimAcquireBody{Repo: protocol.RepoRef{Provider: protocol.GitProviderGithub, FullName: "o/r", APIBase: "https://api.github.com"},
		OrgID: "org-a", EnvironmentID: "env-1", ImageID: "img-1", Side: protocol.SideBase, Sha: sha,
		Consumer: protocol.ConsumerRuntime, RepoToken: "ghs_download", Expose: []protocol.Expose{},
		HardExpiresAt: time.Now().Add(55 * time.Minute).UTC().Format(time.RFC3339),
	})
	if err != nil {
		t.Fatal(err)
	}
	// Before claim.ready (or racing it): the policy is kept and applied.
	if err := w.hub.SendEgressPolicy(ctx, "cell-1", "claim-1", []string{"registry.npmjs.org"}); err != nil {
		t.Fatal(err)
	}
	if _, err := w.hub.WaitReady(ctx, "claim-1"); err != nil {
		t.Fatal(err)
	}
	waitApplied := func(want ...string) {
		t.Helper()
		for {
			select {
			case c := <-w.egress.applied:
				if c.ClaimID == "claim-1" && strings.Join(c.ExtraAllow, ",") == strings.Join(want, ",") {
					return
				}
			case <-ctx.Done():
				t.Fatalf("never applied %v", want)
			}
		}
	}
	waitApplied("registry.npmjs.org")

	// After claim.ready: re-applied with the new list, which replaces the old.
	if err := w.hub.SendEgressPolicy(ctx, "cell-1", "claim-1", []string{"api.stripe.com"}); err != nil {
		t.Fatal(err)
	}
	waitApplied("api.stripe.com")

	if err := w.hub.Send(ctx, "cell-1", "claim-1", &protocol.ClaimReleaseBody{}); err != nil {
		t.Fatal(err)
	}
	select {
	case id := <-w.egress.removed:
		if id != "claim-1" {
			t.Fatalf("removed %s", id)
		}
	case <-ctx.Done():
		t.Fatal("policy not removed on release")
	}
}

// A hub whose hello ack names no version, or one this cell does not speak,
// gets no session: the cell hangs up and dials again.
func TestHelloAckWithoutSupportedVersionEndsSession(t *testing.T) {
	for name, ack := range map[string]*protocol.AckBody{"missing": {}, "unsupported": {Version: ptr(int64(protocol.ProtocolVersion + 5))}} {
		t.Run(name, func(t *testing.T) {
			w := newWorld(t, func(h *hubstub.Hub) { h.HelloAck = func() *protocol.AckBody { return ack } })
			select {
			case <-w.hub.Hellos():
			case <-time.After(5 * time.Second):
				t.Fatal("cell did not dial again")
			}
			if v := w.agent.Version(); v != 0 {
				t.Fatalf("version %d", v)
			}
			if !strings.Contains(w.logs.String(), "hub.version") || strings.Contains(w.logs.String(), "hub.connected") {
				t.Fatalf("logs: %s", w.logs.String())
			}
		})
	}
}

func ptr[T any](v T) *T { return &v }

// The session keeps what the hub's hello ack accepts: a hub that names
// readyBuildSteps gets claim.ready timing.buildSteps, an older one (no
// accepts) never does.
func TestTheSessionKeepsWhatTheHelloAckAccepts(t *testing.T) {
	for name, tc := range map[string]struct {
		accepts []string
		want    string
	}{"an older hub": {nil, "accepts=0"}, "a hub that accepts build steps": {[]string{protocol.FeatureReadyBuildSteps}, "accepts=1"}} {
		t.Run(name, func(t *testing.T) {
			w := newWorld(t, func(h *hubstub.Hub) {
				h.HelloAck = func() *protocol.AckBody {
					return &protocol.AckBody{Version: ptr(int64(protocol.ProtocolVersion)), Accepts: tc.accepts}
				}
			})
			waitLog(t, w, "hub.connected", tc.want)
		})
	}
}

// A claim.ready lost on the wire, or whose ack is lost, is sent again until
// the hub acks it; the hub acks the resend of a claim it already settled.
func TestClaimReadyResentUntilAcked(t *testing.T) {
	w := newWorld(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	w.hub.DropSettle.Store(2)
	w.acquire(t, ctx, "claim-lost", "org-a")
	if n := w.hub.DropSettle.Load(); n != 0 {
		t.Fatalf("%d drops left: the cell did not resend", n)
	}

	// The ack is lost: the resend of a ready claim is acked, not refused.
	w.hub.DropSettleAck.Store(1)
	before := w.hub.Violations.Load()
	w.acquire(t, ctx, "claim-ack-lost", "org-a")
	waitLog(t, w, "claim.ready.acked", "claim-ack-lost", "attempt=2")
	if v := w.hub.Violations.Load(); v != before {
		t.Fatalf("resend counted as %d violation(s)", v-before)
	}
	if got := w.hub.Settled.Load(); got != 2 {
		t.Fatalf("hub settled %d times, want 2", got)
	}
	for _, l := range strings.Split(w.logs.String(), "\n") {
		if strings.Contains(l, "msg=claim.") && !strings.Contains(l, "cell=cell-1") {
			t.Fatalf("claim log line without the cell: %s", l)
		}
		if strings.Contains(l, "ghs_download") {
			t.Fatalf("repo token in the log: %s", l)
		}
	}
}

// claim.failed is resent the same way; a hub that no longer waits for the
// claim (nack) ends the retries.
func TestClaimFailedResentAndNackEndsRetries(t *testing.T) {
	w := newWorld(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	w.drv.SetFailCreate(errors.New("InsufficientInstanceCapacity"))
	w.hub.DropSettle.Store(1)
	if err := w.hub.Send(ctx, "cell-1", "claim-f", &protocol.ClaimAcquireBody{Repo: protocol.RepoRef{Provider: protocol.GitProviderGithub, FullName: "o/r", APIBase: "https://api.github.com"},
		OrgID: "org-a", EnvironmentID: "env-1", ImageID: "img-1", Side: protocol.SidePr, Sha: sha,
		Consumer: protocol.ConsumerRuntime, RepoToken: "ghs_download", Expose: []protocol.Expose{},
		HardExpiresAt: time.Now().Add(30 * time.Minute).UTC().Format(time.RFC3339),
	}); err != nil {
		t.Fatal(err)
	}
	ev, err := w.hub.WaitSettled(ctx, "claim-f")
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := ev.Body.(*protocol.ClaimFailedBody); !ok {
		t.Fatalf("settled with %T", ev.Body)
	}
	// The hub dropped one claim.failed and the cell resent it until acked.
	// Which attempt that is depends on whether the first one left before
	// the hub connection was up (it then waits in the outbox), so the test
	// asks for a resend, not for a number.
	acked := waitLog(t, w, "claim.failed.acked", "claim=claim-f")
	if w.hub.DropSettle.Load() != 0 {
		t.Fatal("the hub never dropped the first claim.failed")
	}
	if attempt := logAttempt(t, acked); attempt < 2 {
		t.Fatalf("acked at attempt %d: the dropped frame was never resent", attempt)
	}

	// A claim the hub never asked for: nacked once, never retried.
	w.drv.SetFailCreate(nil)
	w.hub.Forget("claim-gone")
	if err := w.hub.SendUntracked(ctx, "cell-1", "claim-gone", &protocol.ClaimAcquireBody{Repo: protocol.RepoRef{Provider: protocol.GitProviderGithub, FullName: "o/r", APIBase: "https://api.github.com"},
		OrgID: "org-a", EnvironmentID: "env-1", ImageID: "img-1", Side: protocol.SideBase, Sha: sha,
		Consumer: protocol.ConsumerRuntime, RepoToken: "ghs_download", Expose: []protocol.Expose{},
		HardExpiresAt: time.Now().Add(30 * time.Minute).UTC().Format(time.RFC3339),
	}); err != nil {
		t.Fatal(err)
	}
	waitLog(t, w, "claim.ready.nacked", "claim-gone", "attempt=1")
	time.Sleep(100 * time.Millisecond)
	for _, l := range strings.Split(w.logs.String(), "\n") {
		if strings.Contains(l, "claim.ready.retry") && strings.Contains(l, "claim=claim-gone") {
			t.Fatalf("retried after a nack: %s", l)
		}
	}
	// The cell cleaned up a claim nobody will use.
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, ok := w.agent.Leases().Get("claim-gone"); !ok {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("nacked claim kept its lease")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// waitLog waits for a log line carrying every part and returns it.
func waitLog(t *testing.T, w *world, parts ...string) string {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		for _, l := range strings.Split(w.logs.String(), "\n") {
			ok := true
			for _, p := range parts {
				if !strings.Contains(l, p) {
					ok = false
					break
				}
			}
			if ok {
				return l
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("no log line with %v in:\n%s", parts, w.logs.String())
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// logAttempt reads the attempt=N field of a log line.
func logAttempt(t *testing.T, line string) int {
	t.Helper()
	for _, f := range strings.Fields(line) {
		if v, ok := strings.CutPrefix(f, "attempt="); ok {
			n, err := strconv.Atoi(v)
			if err != nil {
				t.Fatalf("attempt %q in %s", v, line)
			}
			return n
		}
	}
	t.Fatalf("no attempt in %s", line)
	return 0
}
