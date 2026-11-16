package egress

import (
	"bufio"
	"bytes"
	"crypto/tls"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"
)

// lockedBuf is a log the proxy writes from its goroutines and the test reads.
type lockedBuf struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (l *lockedBuf) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.buf.Write(p)
}

func (l *lockedBuf) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.buf.String()
}

// S-60 Upload budget, in D8's observe-only mode: a claim that sends past its
// budget to an allowed host is logged once and counted, and its connection
// is not cut. Cutting it (and a neutral Run) waits on measured numbers.
func TestS60UploadPastTheBudgetIsObservedNotCut(t *testing.T) {
	logs := &lockedBuf{}
	r := newRig(t, nil, func(p *Proxy) {
		p.UploadBudget = 1024
		p.Log = slog.New(slog.NewJSONHandler(logs, nil))
	})
	c, err := tls.DialWithDialer(&net.Dialer{Timeout: 2 * time.Second}, "tcp4", r.proxyTLS, &tls.Config{ServerName: "registry.example", InsecureSkipVerify: true}) //nolint:gosec // G402: the test upstream presents a self-signed cert
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	body := strings.Repeat("x", 8192)
	fmt.Fprintf(c, "POST /upload HTTP/1.1\r\nHost: registry.example\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s", len(body), body)
	resp, err := http.ReadResponse(bufio.NewReader(c), nil)
	if err != nil {
		t.Fatalf("the upload was cut: %v", err)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status %d", resp.StatusCode)
	}
	deadline := time.Now().Add(2 * time.Second)
	for !strings.Contains(logs.String(), "egress.upload_budget.exceeded") && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if n := strings.Count(logs.String(), "egress.upload_budget.exceeded"); n != 1 {
		t.Fatalf("logged %d times: %s", n, logs.String())
	}
	if !strings.Contains(logs.String(), `"mode":"observe"`) || r.proxy.UploadSent("claim-1") < 8192 {
		t.Fatalf("not observed: sent %d", r.proxy.UploadSent("claim-1"))
	}
}

func TestUploadBudgetCountsPerClaimAndForgets(t *testing.T) {
	var logs bytes.Buffer
	u := newUploadBudget(100, slog.New(slog.NewJSONHandler(&logs, nil)))
	a := u.of("claim-a")
	u.add("claim-a", "h", a, 60)
	u.add("claim-b", "h", u.of("claim-b"), 60)
	if u.crossed.Load() != 0 {
		t.Fatal("crossed below the budget")
	}
	u.add("claim-a", "h", a, 60)
	u.add("claim-a", "h", a, 60)
	if u.crossed.Load() != 1 || u.Sent("claim-a") != 180 || u.Sent("claim-b") != 60 {
		t.Fatalf("crossed %d, a %d, b %d", u.crossed.Load(), u.Sent("claim-a"), u.Sent("claim-b"))
	}
	u.forget("claim-a")
	if u.Sent("claim-a") != 0 {
		t.Fatal("forgotten claim still counted")
	}
	var off *uploadBudget
	off.add("x", "h", off.of("x"), 1<<30)
	if newUploadBudget(0, nil).of("x") != nil {
		t.Fatal("a zero budget measures")
	}
}
