package management

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/injector"
)

func fakeServer(t *testing.T, body string, status int) string {
	t.Helper()
	p := filepath.Join(privateDir(t), "fake.sock")
	l, e := net.ListenUnix("unix", &net.UnixAddr{Name: p, Net: "unix"})
	if e != nil {
		t.Fatal(e)
	}
	l.SetUnlinkOnClose(false)
	if e = os.Chmod(p, 0600); e != nil {
		t.Fatal(e)
	}
	s := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Location", "http://127.0.0.1:9/synthetic-redirect-secret")
		w.WriteHeader(status)
		_, _ = io.WriteString(w, body)
	}), ReadHeaderTimeout: time.Second}
	go func() { _ = s.Serve(l) }()
	t.Cleanup(func() { _ = s.Close(); _ = l.Close() })
	return p
}
func TestClientSanitizesUntrustedMetadataResponse(t *testing.T) {
	valid := `{"organizationId":"org-a","environmentId":"env-a","id":"payments","version":1,"expiresAt":"2030-01-01T00:00:00Z","revoked":false}`
	cases := []string{`null`, `{"versions":null}`, `{"Versions":[]}`, `{"versions":[],"versions":[]}`, `{"versions":[],"value":"synthetic-untrusted-secret"}`, `{"versions":[]} {}`, `{"versions":[` + strings.Replace(valid, `"id":"payments"`, `"id":"payments","value":"synthetic-untrusted-secret"`, 1) + `]}`, `{"versions":[` + strings.Replace(valid, `"organizationId":"org-a"`, `"organizationId":"other-org"`, 1) + `]}`, `{"versions":[` + strings.Replace(valid, `"id":"payments"`, `"Id":"payments"`, 1) + `]}`, `{"versions":[` + strings.Replace(valid, `"version":1`, `"version":1.0`, 1) + `]}`, `{"versions":[` + strings.Replace(valid, `"version":1`, `"version":1,"version":2`, 1) + `]}`, `{"versions":[` + strings.Replace(valid, `"revoked":false`, `"revoked":"false"`, 1) + `]}`, `{"versions":[` + strings.Replace(valid, `"id":"payments"`, `"id":"<script>synthetic</script>"`, 1) + `]}`, `{"versions":[` + strings.Replace(valid, `"expiresAt":"2030-01-01T00:00:00Z"`, `"expiresAt":null`, 1) + `]}`, strings.Repeat("x", MaxResponseBytes+1)}
	for _, body := range cases {
		t.Run("reject-"+string(rune('A'+len(body)%26)), func(t *testing.T) {
			socket := fakeServer(t, body, 200)
			b, e := Call(context.Background(), socket, "list", []byte(`{"organizationId":"org-a","environmentId":"env-a"}`))
			if e == nil || len(b) != 0 || strings.Contains(e.Error(), "synthetic") {
				t.Fatalf("untrusted response escaped: bytes=%d error=%v", len(b), e)
			}
		})
	}
	socket := fakeServer(t, `{"versions":[`+valid+`]}`, 200)
	b, e := Call(context.Background(), socket, "list", []byte(`{"organizationId":"org-a","environmentId":"env-a"}`))
	if e != nil || !bytes.Contains(b, []byte(`"id":"payments"`)) {
		t.Fatalf("valid response rejected: %v", e)
	}
	for _, status := range []int{302, 400, 403, 409, 503} {
		socket = fakeServer(t, `{"error":"synthetic-untrusted-secret"}`, status)
		b, e = Call(context.Background(), socket, "list", []byte(`{"organizationId":"org-a","environmentId":"env-a"}`))
		if e == nil || len(b) != 0 || strings.Contains(e.Error(), "synthetic") {
			t.Fatal("error/redirect body escaped")
		}
	}
}
func TestKernelPeerIdentityEnforcedInBothDirections(t *testing.T) {
	base := privateDir(t)
	socket, _, _ := startServer(t, newVault(t, base), base)
	_, e := call(context.Background(), socket, "list", []byte(`{"organizationId":"org-a","environmentId":"env-a"}`), func(c *net.UnixConn) error { return samePeer(c, uint32(os.Geteuid()+1)) })
	var typed *Error
	if !errors.As(e, &typed) || typed.Code != "denied" {
		t.Fatalf("client accepted wrong peer identity: %v", e)
	}
	path := filepath.Join(privateDir(t), "reject.sock")
	l, e := listenPrivate(path)
	if e != nil {
		t.Fatal(e)
	}
	defer l.Close()
	l.check = func(c *net.UnixConn) error { return samePeer(c, uint32(os.Geteuid()+1)) }
	done := make(chan error, 1)
	go func() {
		c, e := l.Accept()
		if e == nil {
			_ = c.Close()
		}
		done <- e
	}()
	c, e := net.DialUnix("unix", nil, &net.UnixAddr{Name: path, Net: "unix"})
	if e != nil {
		t.Fatal(e)
	}
	defer c.Close()
	_ = c.SetReadDeadline(time.Now().Add(time.Second))
	b := make([]byte, 1)
	if _, e = c.Read(b); !errors.Is(e, io.EOF) {
		t.Fatalf("server failed to close wrong-UID peer: %v", e)
	}
	_ = l.Close()
	if e = <-done; e == nil {
		t.Fatal("wrong UID reached accepted connection")
	}
}
func TestSocketCleanupPreservesReplacementAndAllowsCleanRestart(t *testing.T) {
	base := privateDir(t)
	path := filepath.Join(base, "admin.sock")
	l, e := listenPrivate(path)
	if e != nil {
		t.Fatal(e)
	}
	if e = os.Remove(path); e != nil {
		t.Fatal(e)
	}
	if e = os.WriteFile(path, []byte("foreign replacement"), 0600); e != nil {
		t.Fatal(e)
	}
	_ = l.Close()
	b, e := os.ReadFile(path)
	if e != nil || string(b) != "foreign replacement" {
		t.Fatal("replacement node removed")
	}
	_ = os.Remove(path)
	l, e = listenPrivate(path)
	if e != nil {
		t.Fatal(e)
	}
	_ = l.Close()
	if _, e = os.Lstat(path); !os.IsNotExist(e) {
		t.Fatal("owned socket not cleaned")
	}
	l, e = listenPrivate(path)
	if e != nil {
		t.Fatal(e)
	}
	_ = l.Close()
}

type blockingVault struct {
	injector.RefusingVault
	started     chan struct{}
	release     chan struct{}
	active, max atomic.Int32
}

func (v *blockingVault) ListVersions(ctx context.Context, _ injector.SecretScope) ([]injector.SecretVersionInfo, error) {
	n := v.active.Add(1)
	defer v.active.Add(-1)
	for old := v.max.Load(); n > old && !v.max.CompareAndSwap(old, n); old = v.max.Load() {
	}
	v.started <- struct{}{}
	select {
	case <-v.release:
		return []injector.SecretVersionInfo{}, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}
func TestManagementConcurrencyBoundAndActiveCallCancellation(t *testing.T) {
	v := &blockingVault{started: make(chan struct{}, 8), release: make(chan struct{})}
	socket, _, _ := startServer(t, v, privateDir(t))
	body := []byte(`{"organizationId":"org-a","environmentId":"env-a"}`)
	ctx, cancel := context.WithCancel(context.Background())
	results := make(chan error, 4)
	var wg sync.WaitGroup
	for range 4 {
		wg.Go(func() { _, e := Call(ctx, socket, "list", body); results <- e })
	}
	for range 4 {
		select {
		case <-v.started:
		case <-time.After(2 * time.Second):
			t.Fatal("vault calls did not start")
		}
	}
	if _, e := Call(context.Background(), socket, "list", body); e == nil {
		t.Fatal("fifth handler bypassed bound")
	}
	if v.max.Load() != 4 {
		t.Fatalf("active handler bound=%d", v.max.Load())
	}
	cancel()
	wg.Wait()
	for range 4 {
		e := <-results
		var typed *Error
		if !errors.As(e, &typed) || typed.Code != "cancelled" {
			t.Fatalf("active cancellation lost: %v", e)
		}
	}
	close(v.release)
}
