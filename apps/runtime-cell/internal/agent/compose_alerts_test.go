package agent

import (
	"context"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/kodyexec"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// composer is a ComposeBooter whose containers get the next address set.
type composer struct {
	mu    sync.Mutex
	ips   [][]string
	files [][]byte
}

func (c *composer) Up(_ context.Context, _ driver.MachineRef, file []byte, _ string) ([]string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.files = append(c.files, file)
	ips := c.ips[0]
	if len(c.ips) > 1 {
		c.ips = c.ips[1:]
	}
	return ips, nil
}

func (r *recEgress) lastSources() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.applied) == 0 {
		return nil
	}
	return r.applied[len(r.applied)-1].Sources
}

// The compose project boots through the driver, and its containers'
// addresses are in the claim's egress policy, again after a reset.
func TestComposeContainersAreSourcesOfTheClaimPolicy(t *testing.T) {
	cp := &composer{ips: [][]string{{"172.30.0.2", "172.30.0.3"}, {"172.30.0.7"}}}
	h := newHarness(t, func(c *Config) { c.Composer = cp })
	b := h.acquireBody()
	b.Expose = []protocol.Expose{{Service: "api", Port: 3000, Kind: protocol.ExposeKindHTTP}}
	if err := h.handle("claim-1", protocol.MessageTypeClaimAcquire, b); err != nil {
		t.Fatal(err)
	}
	h.conn.next(t, isReady)
	if got := h.egress.lastSources(); !slices.Equal(got, []string{"172.30.0.2", "172.30.0.3"}) {
		t.Fatalf("policy sources %v", got)
	}
	if len(cp.files) != 1 || !strings.Contains(string(cp.files[0]), "api") {
		t.Fatalf("compose file %q", cp.files)
	}
	reset := &protocol.MachineResetBody{StepID: step1, Snapshot: protocol.Snapshot{Kind: protocol.SnapshotKindComposeVolumes, Ref: "v"}}
	if err := h.handle("claim-1", protocol.MessageTypeMachineReset, reset); err != nil {
		t.Fatal(err)
	}
	if r := h.conn.next(t, isResult(step1)).(*protocol.StepResultBody); r.VMHealth != protocol.VMHealthOk {
		t.Fatalf("reset %+v", r)
	}
	if got := h.egress.lastSources(); !slices.Equal(got, []string{"172.30.0.7"}) {
		t.Fatalf("after the reset the policy names %v", got)
	}
}

type alertFeed struct{ ch chan []Alert }

func (f alertFeed) Alerts(ctx context.Context, _ int64) ([]Alert, error) {
	select {
	case a := <-f.ch:
		return a, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// An exfiltration alert stops the claim and reports a blocker for it.
func TestExfiltrationAlertBlocksTheClaim(t *testing.T) {
	feed := alertFeed{ch: make(chan []Alert, 1)}
	started := make(chan struct{})
	h := newHarness(t, func(c *Config) {
		c.Alerts = feed
		c.Transport = stubTransport{exec: func(ctx context.Context, _ kodyexec.Request) (kodyexec.Result, error) {
			close(started)
			<-ctx.Done()
			return kodyexec.Result{}, ctx.Err()
		}}
	})
	// This fixture starts with an already-negotiated source; the source
	// handshake and loss lifecycle are exercised in source_health_test.go.
	h.a.alertSourceReady()
	h.ready("claim-1")
	if err := h.handle("claim-1", protocol.MessageTypeExec, &protocol.ExecBody{StepID: step1, Command: "curl", TimeoutMs: 600_000}); err != nil {
		t.Fatal(err)
	}
	<-started
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); h.a.watchAlerts(ctx) }()
	feed.ch <- []Alert{{Seq: 1, ClaimID: "claim-1", Host: "evil.example", Kind: "credential_exfiltration", At: time.Now()}}
	bl := h.conn.next(t, func(f any) bool { _, ok := f.(*protocol.BlockedBody); return ok }).(*protocol.BlockedBody)
	cancel()
	<-done
	if bl.Kind != protocol.BlockerKindSecurityViolation || bl.Signature != "credential_exfiltration" || !strings.Contains(bl.Message, "evil.example") {
		t.Fatalf("blocked %+v", bl)
	}
	if code := nackCode(h.handle("claim-1", protocol.MessageTypeExec, &protocol.ExecBody{StepID: "2f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b", Command: "id", TimeoutMs: 1000})); code != "claim_compromised" {
		t.Fatalf("a step after the alert: %q", code)
	}
	h.a.Wait()
	if n := h.conn.attempts(isResult(step1)); n != 0 {
		t.Fatal("the running step was not stopped")
	}
}

// A driver that builds no image refuses image.bake when it arrives. It used
// to be acked and fail in the background, so the setup recorded "image.bake
// accepted" for an image that was never made.
func TestBakeOnADriverThatCannotBakeIsRefusedAtOnce(t *testing.T) {
	h := newHarness(t)
	h.drv.CannotBake = true
	err := h.handle("", protocol.MessageTypeImageBake, &protocol.ImageBakeBody{OrgID: "org-a", EnvironmentID: "env-1", Sha: testSHA, RecipeSha: "r"})
	if code := nackCode(err); code != "bake_unsupported" {
		t.Fatalf("image.bake = %v (code %q), want bake_unsupported", err, code)
	}
	h.a.Wait()
	if bakes := h.drv.BakesSnapshot(); len(bakes) != 0 {
		t.Fatalf("a bake started anyway: %+v", bakes)
	}
}

// The bake carries the cell and the org its snapshots are tagged with.
func TestBakeSpecNamesTheCellAndOrg(t *testing.T) {
	h := newHarness(t)
	if err := h.handle("", protocol.MessageTypeImageBake, &protocol.ImageBakeBody{OrgID: "org-a", EnvironmentID: "env-1", Sha: testSHA, RecipeSha: "r"}); err != nil {
		t.Fatal(err)
	}
	h.a.Wait()
	bakes := h.drv.BakesSnapshot()
	if len(bakes) != 1 {
		t.Fatalf("bakes %+v", bakes)
	}
	tags := driver.SnapshotTags(bakes[0])
	if tags[driver.TagCell] != "cell-1" || tags[driver.TagOrg] != "org-a" {
		t.Fatalf("snapshot tags %v", tags)
	}
}

// upSeesPolicy is a ComposeBooter that records how many policies were
// pushed when its Up ran: a project that builds fetches during Up.
type upSeesPolicy struct {
	composer
	egress  *recEgress
	atUp    int
	sources []string
}

func (u *upSeesPolicy) Up(ctx context.Context, ref driver.MachineRef, file []byte, dir string) ([]string, error) {
	u.egress.mu.Lock()
	u.atUp = len(u.egress.applied)
	if u.atUp > 0 {
		u.sources = u.egress.applied[u.atUp-1].Sources
	}
	u.egress.mu.Unlock()
	return u.composer.Up(ctx, ref, file, dir)
}

// The claim's policy is in place before its project comes up (the builder
// fetches through it during Up), and again after with the containers.
func TestTheEgressPolicyIsInPlaceBeforeTheProjectBuilds(t *testing.T) {
	up := &upSeesPolicy{composer: composer{ips: [][]string{{"172.30.0.2"}}}}
	h := newHarness(t, func(c *Config) { c.Composer = up })
	up.egress = h.egress
	if err := h.handle("claim-1", protocol.MessageTypeClaimAcquire, h.acquireBody()); err != nil {
		t.Fatal(err)
	}
	h.conn.next(t, isReady)
	if up.atUp != 1 {
		t.Fatalf("%d policies were pushed before Up, want 1", up.atUp)
	}
	if slices.Contains(up.sources, "172.30.0.2") {
		t.Fatalf("the policy before Up named a container that did not exist yet: %v", up.sources)
	}
	if got := h.egress.lastSources(); !slices.Contains(got, "172.30.0.2") {
		t.Fatalf("after Up the policy names %v", got)
	}
}
