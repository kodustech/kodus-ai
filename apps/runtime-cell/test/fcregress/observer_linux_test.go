//go:build linux

package fcregress

import (
	"context"
	"crypto/tls"
	"fmt"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/microvm"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/guest"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/testpki"
)

// A claim's observer is a small microVM on the claim's bridge that the cell
// reaches over its vsock only: it answers the cell's certificate there, it
// listens on no TCP port, so a workload VM of the same claim (which reaches
// every address on that bridge) cannot reach its control channel. Its boot
// (Create to its first TLS answer) and resident memory are logged.
func TestFirecrackerObserverVMAnswersOnlyOverVsock(t *testing.T) {
	ca, err := testpki.NewCA("fc-obs-ca")
	if err != nil {
		t.Fatal(err)
	}
	tlsDir := t.TempDir()
	obsCert, _ := ca.Issue("observer", time.Hour, "observer")
	if err := ca.WriteFiles(tlsDir, "", obsCert); err != nil {
		t.Fatal(err)
	}
	s := open(t, func(f *microvm.Firecracker) { f.ObserverTLSDir = tlsDir })
	ctx := context.Background()
	claim := "fc-obs-" + time.Now().Format("150405")
	n, err := s.Driver.PrepareClaim(ctx, driver.ClaimNetworkSpec{CellID: cellID, OrgID: "org-fc", ClaimID: claim})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Driver.ReleaseClaim(context.Background(), n) })
	now := time.Now()
	spec := driver.MachineSpec{
		CellID: cellID, EnvironmentID: "env-fc", Role: driver.RoleObserver, OrgID: "org-fc", ClaimID: claim,
		ClaimGroupID: n.WorkloadGroupID, KMSKeyRef: "kms-org-fc",
		ExpiresAt: now.Add(10 * time.Minute), HardExpiresAt: now.Add(30 * time.Minute),
	}
	before := firecrackers(t)
	obs, err := s.Driver.Create(ctx, spec)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Driver.Destroy(context.Background(), obs) })

	cellCert, _ := ca.Issue(cellID, time.Hour)
	hc := &http.Client{Timeout: 10 * time.Second, Transport: &http.Transport{
		DisableKeepAlives: true,
		TLSClientConfig:   &tls.Config{Certificates: []tls.Certificate{cellCert}, RootCAs: ca.Pool(), ServerName: "observer", MinVersion: tls.VersionTLS13},
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return s.Driver.DialObserver(ctx, obs.MachineID)
		},
	}}
	url := "https://" + net.JoinHostPort(obs.PrivateAddress, strconv.Itoa(microvm.ObserverVsockPort)) + "/v1/requests"
	var status int
	for {
		if r, err := hc.Get(url); err == nil {
			status = r.StatusCode
			_ = r.Body.Close()
			break
		}
		if time.Since(now) > 30*time.Second {
			t.Fatal("the observer never answered over its vsock")
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Logf("observer %s: %d ms from Create to its first TLS answer over vsock (status %d)", obs.MachineID, time.Since(now).Milliseconds(), status)
	for pid := range firecrackers(t) {
		if !before[pid] {
			t.Logf("observer VMM pid %d resident memory: %s", pid, rss(pid))
		}
	}

	// A workload VM of the same claim tries the observer's address on its
	// port and on the guest agent's: nothing listens on TCP there.
	spec.Role = driver.RoleWorkload
	wl, err := s.Driver.CreateSandbox(ctx, driver.SandboxRequest{Spec: spec})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Driver.Destroy(context.Background(), wl) })
	var c *guest.Client
	for c == nil {
		if rw, err := s.Driver.DialGuest(ctx, wl); err == nil {
			cl := guest.NewClient(rw, cellID, claim)
			if r, err := cl.Do(ctx, guest.NewID(), protocol.SandboxOp{Op: protocol.SandboxOpKindStat}); err == nil && r.Ok {
				c = cl
				break
			}
			_ = cl.Close()
		}
		if time.Since(now) > time.Minute {
			t.Fatal("the workload's guest agent never answered")
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Cleanup(func() { _ = c.Close() })
	command := fmt.Sprintf(`python3 -c 'import socket
for port in (%d, 1023, 1024, 52):
    try:
        socket.create_connection((%q, port), timeout=3); print("open", port)
    except OSError as e:
        print("closed", port, e)'`, microvm.ObserverVsockPort, obs.PrivateAddress)
	timeout := int64(60_000)
	r, err := c.Do(ctx, guest.NewID(), protocol.SandboxOp{Op: protocol.SandboxOpKindExec, Command: &command, TimeoutMs: &timeout})
	if err != nil || r.Exec == nil || r.Exec.ExitCode != 0 {
		t.Fatalf("probe from the workload: %+v %v", r, err)
	}
	t.Logf("from the workload %s to the observer %s:\n%s", wl.PrivateAddress, obs.PrivateAddress, r.Exec.Stdout)
	if strings.Contains(r.Exec.Stdout, "open") || strings.Count(r.Exec.Stdout, "closed") != 4 {
		t.Fatalf("the workload reached a TCP port of the observer: %s", r.Exec.Stdout)
	}
	if !strings.Contains(r.Exec.Stdout, "refused") {
		t.Fatalf("the observer's address did not answer at all (no bridge between them?), so the test proves nothing: %s", r.Exec.Stdout)
	}
}

// firecrackers is the pids of the host's firecracker processes.
func firecrackers(t *testing.T) map[int]bool {
	t.Helper()
	out := map[int]bool{}
	ents, _ := os.ReadDir("/proc")
	for _, e := range ents {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		if comm, _ := os.ReadFile("/proc/" + e.Name() + "/comm"); strings.TrimSpace(string(comm)) == "firecracker" {
			out[pid] = true
		}
	}
	return out
}

func rss(pid int) string {
	b, _ := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/status")
	for _, l := range strings.Split(string(b), "\n") {
		if strings.HasPrefix(l, "VmRSS:") {
			return strings.TrimSpace(strings.TrimPrefix(l, "VmRSS:"))
		}
	}
	return "unknown"
}
