package agent

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/clock"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver/fake"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/hubclient"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/kodyexec"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/observer"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/tarball"
)

const testSHA = "0123456789abcdef0123456789abcdef01234567"

// syncBuf is a log sink tests read while the agent writes.
type syncBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuf) Write(p []byte) (int, error) { s.mu.Lock(); defer s.mu.Unlock(); return s.b.Write(p) }
func (s *syncBuf) String() string              { s.mu.Lock(); defer s.mu.Unlock(); return s.b.String() }

// hubConn is a fake hub connection: it records every frame and answers
// each Request with the next error of its script (nil when empty).
type hubConn struct {
	mu     sync.Mutex
	script []error
	frames []any
	sent   chan any
}

func newHubConn(script ...error) *hubConn { return &hubConn{script: script, sent: make(chan any, 64)} }

func (h *hubConn) Request(_ context.Context, _ protocol.Header, body any) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	var err error
	if len(h.script) > 0 {
		err, h.script = h.script[0], h.script[1:]
	}
	h.frames = append(h.frames, body)
	if err == nil {
		h.sent <- body
	}
	return err
}

// attempts counts the sends of frames of body's type.
func (h *hubConn) attempts(match func(any) bool) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	n := 0
	for _, f := range h.frames {
		if match(f) {
			n++
		}
	}
	return n
}

// next returns the next acked frame that matches.
func (h *hubConn) next(t *testing.T, match func(any) bool) any {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		select {
		case f := <-h.sent:
			if match(f) {
				return f
			}
		case <-deadline:
			t.Fatal("no matching frame reached the hub")
			return nil
		}
	}
}

func isReady(f any) bool  { _, ok := f.(*protocol.ClaimReadyBody); return ok }
func isFailed(f any) bool { _, ok := f.(*protocol.ClaimFailedBody); return ok }
func isResult(step string) func(any) bool {
	return func(f any) bool { r, ok := f.(*protocol.StepResultBody); return ok && r.StepID == step }
}

// stubTransport runs exec through a function and accepts every upload, or
// fails each with upload when it is set.
type stubTransport struct {
	exec   func(ctx context.Context, req kodyexec.Request) (kodyexec.Result, error)
	upload error
}

func (s stubTransport) Exec(ctx context.Context, _ driver.MachineRef, req kodyexec.Request) (kodyexec.Result, error) {
	if s.exec == nil {
		return kodyexec.Result{Stdout: "ok"}, nil
	}
	return s.exec(ctx, req)
}

func (s stubTransport) Upload(context.Context, driver.MachineRef, string, string) error {
	return s.upload
}

// recEgress records the policies pushed and removed.
type recEgress struct {
	mu      sync.Mutex
	applied []ClaimInfo
	removed []string
}

func (r *recEgress) Apply(_ context.Context, c ClaimInfo) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.applied = append(r.applied, c)
	return nil
}

func (r *recEgress) Remove(_ context.Context, id string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.removed = append(r.removed, id)
	return nil
}

func (r *recEgress) removedIDs() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.removed...)
}

// recKeys records the per-claim keys made and forgotten.
type recKeys struct {
	mu   sync.Mutex
	live map[string]bool
}

func (k *recKeys) PrepareClaim(id string) (string, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	if k.live == nil {
		k.live = map[string]bool{}
	}
	k.live[id] = true
	return "#cloud-config", nil
}

func (k *recKeys) Forget(id string) { k.mu.Lock(); defer k.mu.Unlock(); delete(k.live, id) }

func (k *recKeys) has(id string) bool { k.mu.Lock(); defer k.mu.Unlock(); return k.live[id] }

type nopRevoker struct{}

func (nopRevoker) Revoke(context.Context, string) error { return nil }

func repoServer(t *testing.T) string {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	_ = tw.WriteHeader(&tar.Header{Name: "o-r-0123/README.md", Typeflag: tar.TypeReg, Mode: 0o644, Size: 5})
	_, _ = tw.Write([]byte("hello"))
	_ = tw.Close()
	_ = gz.Close()
	body := buf.Bytes()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(body) }))
	t.Cleanup(srv.Close)
	return srv.URL
}

type harness struct {
	t      *testing.T
	a      *Agent
	drv    *fake.Driver
	conn   *hubConn
	clk    *clock.Fake
	egress *recEgress
	keys   *recKeys
	logs   *syncBuf
}

// newHarness is an agent on the fake driver (VM isolation), a fake hub
// connection, a fake clock that never sleeps, and a repo server.
func newHarness(t *testing.T, edit ...func(*Config)) *harness {
	t.Helper()
	d := fake.New()
	d.Isolation = driver.IsolationVM
	repo := repoServer(t)
	h := &harness{t: t, drv: d, conn: newHubConn(), clk: clock.NewFake(time.Now()), egress: &recEgress{}, keys: &recKeys{}, logs: &syncBuf{}}
	cfg := Config{
		CellID: "cell-1", Driver: d, Transport: stubTransport{},
		Observers: func(context.Context, ClaimInfo, []observer.Target) (observer.Client, error) {
			return nil, errors.New("no observer in this test")
		},
		Repo:      func(protocol.ClaimAcquireBody) (string, error) { return repo + "/tarball", nil },
		Extractor: tarball.InProcessExtractor{}, Revoker: nopRevoker{},
		OrgKey: func(string) (string, error) { return "k", nil },
		Egress: h.egress, Keys: h.keys,
		WorkDir: t.TempDir(), Clock: h.clk, Log: slog.New(slog.NewTextHandler(h.logs, nil)),
		SettleAttempts: 3, ExecGrace: 50 * time.Millisecond,
	}
	for _, f := range edit {
		f(&cfg)
	}
	a, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	a.conn = h.conn
	h.a = a
	t.Cleanup(a.Wait)
	return h
}

func (h *harness) acquireBody() *protocol.ClaimAcquireBody {
	return &protocol.ClaimAcquireBody{
		Repo:  protocol.RepoRef{Provider: protocol.GitProviderGithub, FullName: "o/r", APIBase: "https://api.github.com"},
		OrgID: "org-a", EnvironmentID: "env-1", ImageID: "img-1", Side: protocol.SideBase, Sha: testSHA,
		Consumer: protocol.ConsumerRuntime, RepoToken: "ghs_download", Expose: []protocol.Expose{},
		HardExpiresAt: protocol.FormatTime(h.clk.Now().Add(50 * time.Minute)),
	}
}

func msg(claimID string, typ protocol.MessageType, body any) *protocol.Message {
	m := &protocol.Message{Envelope: protocol.Envelope{ID: hubclient.NewID(), Type: typ}, Body: body}
	if claimID != "" {
		m.Envelope.ClaimID = &claimID
	}
	return m
}

// handle runs a frame through Handle, and a deferred answer to its end.
func (h *harness) handle(claimID string, typ protocol.MessageType, body any) error {
	err := h.a.Handle(context.Background(), msg(claimID, typ, body))
	if run, ok := hubclient.IsLater(err); ok {
		return run(context.Background())
	}
	return err
}

// ready acquires a claim and waits for its claim.ready.
func (h *harness) ready(claimID string, edit ...func(*protocol.ClaimAcquireBody)) {
	h.t.Helper()
	b := h.acquireBody()
	for _, f := range edit {
		f(b)
	}
	if err := h.handle(claimID, protocol.MessageTypeClaimAcquire, b); err != nil {
		h.t.Fatalf("claim.acquire: %v", err)
	}
	h.conn.next(h.t, isReady)
}

func nackCode(err error) string {
	var n *hubclient.NackError
	if errors.As(err, &n) {
		return n.Code
	}
	if err != nil {
		return "error:" + err.Error()
	}
	return ""
}
