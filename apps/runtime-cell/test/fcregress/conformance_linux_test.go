//go:build linux

// Package fcregress runs the backend conformance suite (test/conformance)
// and the environment machine's Docker on the firecracker backend: real
// microVMs from a real kit, on a host with KVM. Opt-in, as root:
//
//	KODY_E2E_FIRECRACKER=1 \
//	KODY_E2E_FIRECRACKER_KIT=/var/lib/kodus-cell/kit \
//	KODY_E2E_FIRECRACKER_KIT_DIGEST=sha256:<manifest digest> \
//	KODY_E2E_FIRECRACKER_STATE=/mnt/xfs/kody-e2e \
//	  go test -count=1 -v ./test/fcregress/
//
// The state directory must be on XFS with reflink=1 or on btrfs. The host
// must reach the internet (the allowed host goes through the cell's egress).
package fcregress

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/microvm"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/guest"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation/vmsnap"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/placement/hostnet"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy/control"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/testpki"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/test/conformance"
)

const (
	cellID  = "cell-fc-conf"
	allowed = "dl-cdn.alpinelinux.org"
)

func open(t *testing.T, opts ...func(*microvm.Firecracker)) microvm.Stack {
	t.Helper()
	if os.Getenv("KODY_E2E_FIRECRACKER") != "1" {
		t.Skip("KODY_E2E_FIRECRACKER=1 runs it as root on a host with KVM (see the package comment)")
	}
	kitDir, digest, state := os.Getenv("KODY_E2E_FIRECRACKER_KIT"), os.Getenv("KODY_E2E_FIRECRACKER_KIT_DIGEST"), os.Getenv("KODY_E2E_FIRECRACKER_STATE")
	if kitDir == "" || digest == "" || state == "" {
		t.Fatal("KODY_E2E_FIRECRACKER_KIT, KODY_E2E_FIRECRACKER_KIT_DIGEST and KODY_E2E_FIRECRACKER_STATE are required")
	}
	f := microvm.Firecracker{
		CellID: cellID, KitDir: kitDir, KitDigest: digest, StateDir: state, Host: isolation.ProbeHost(),
		MemoryMB: 1024, CPUs: 1, MaxMemoryMB: 4096, MaxCPUs: 4,
		// The state disk admits environments at their disk ceiling (S-09):
		// 10 GiB data disks fit a Run's two sides and the setup on this host.
		DataGB: 10,
	}
	for _, o := range opts {
		o(&f)
	}
	s, err := microvm.Open(context.Background(), f)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

// The suite on firecracker: sandbox microVMs of the kit's sandbox base, on
// claim bridges whose only way out is the cell's egress on the host.
func TestFirecrackerKeepsTheConformanceBehaviours(t *testing.T) {
	// Each sandbox's NIC is bounded low enough that the host's network
	// stack is never what bounds a noisy one (the neighbour behaviour).
	limits := driver.IOLimits{NetMbps: 50}
	s := open(t, func(f *microvm.Firecracker) { f.Limits = limits })
	// The cell's injector in this process: the egress on the host hands
	// credential hosts to it over loopback.
	l, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	e := startEgress(t, s.Place.Egress().String(), "-injector-addr", l.Addr().String())
	secrets := conformance.StartInjector(t, l, []string{"127.0.0.1"}, e.Push, secretHost, notSecretHost)
	reap, err := microvm.NewForReaper(cellID, stateDir())
	if err != nil {
		t.Fatal(err)
	}
	conformance.Run(t, conformance.Target{
		// A machine is its VMM's cgroup, which the jailer bounds.
		MachineMemory: func(t *testing.T, ref driver.MachineRef) (int, int) {
			return conformance.CgroupMemory(t, "/sys/fs/cgroup/kodus-microvm/"+machineJailID(ref.MachineID))
		},
		Reaper: reap, ReaperOrphans: reap, Orphan: microvmOrphan, Limits: &limits, DownloadURL: "https://" + allowed + "/alpine/v3.20/releases/x86_64/alpine-standard-3.20.3-x86_64.iso",
		Name: "firecracker", CellID: cellID, Driver: s.Driver, Parts: s.Driver.Parts(), Boundary: true,
		Egress: e, AllowedHost: allowed, DeniedHost: "example.com",
		Secrets: secrets, SecretHost: secretHost, NotSecretHost: notSecretHost,
		Snapshots: snapshots{s.Driver, s.Backend},
		Leftovers: func(t *testing.T, machineID string) []string {
			// What the host holds, not the cell's books: the out-of-process
			// reaper removes the tap device, and the cell prunes its record
			// when it starts again.
			left := s.Backend.Remains(machineID)
			if _, err := os.Stat("/sys/class/net/" + hostnet.TapName(machineID)); err == nil {
				left = append(left, "tap of "+machineID)
			}
			if _, err := os.Stat(hostnet.NetnsPath(hostnet.NetnsName(machineID))); err == nil {
				left = append(left, "netns of "+machineID)
			}
			return left
		},
	})
}

// snapshots is the microvm driver's snapshot path for the suite.
type snapshots struct {
	d *microvm.Driver
	b interface{ Store() *vmsnap.Store }
}

func (s snapshots) Forget(_ context.Context, snap isolation.SnapshotRef) error {
	return s.b.Store().Remove(snap.Org, snap.ID)
}

func (s snapshots) Snapshot(ctx context.Context, ref driver.MachineRef, p isolation.Purpose) (isolation.SnapshotRef, error) {
	return s.d.Snapshot(ctx, ref, p)
}

func (s snapshots) Restore(ctx context.Context, spec driver.MachineSpec, snap isolation.SnapshotRef) (driver.MachineRef, error) {
	return s.d.CreateSandboxFrom(ctx, spec, snap)
}

func (s snapshots) Pause(ctx context.Context, ref driver.MachineRef) error {
	return s.d.Suspend(ctx, ref, driver.SuspendHibernate)
}

func (s snapshots) Resume(ctx context.Context, ref driver.MachineRef) error {
	return s.d.Resume(ctx, ref)
}

// An environment machine boots the kit's environment base and runs Docker
// on its own kernel: the guest agent answers as root and dockerd is up.
func TestFirecrackerEnvironmentMachineRunsDocker(t *testing.T) {
	s := open(t)
	ctx := context.Background()
	claim := "fc-env-" + time.Now().Format("150405")
	n, err := s.Driver.PrepareClaim(ctx, driver.ClaimNetworkSpec{CellID: cellID, OrgID: "org-fc", ClaimID: claim})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Driver.ReleaseClaim(context.Background(), n) })
	now := time.Now()
	ref, err := s.Driver.Create(ctx, driver.MachineSpec{
		CellID: cellID, EnvironmentID: "env-fc", Role: driver.RoleWorkload, OrgID: "org-fc", ClaimID: claim,
		ImageID: "environment", ImageRef: "environment", ClaimGroupID: n.WorkloadGroupID, KMSKeyRef: "kms-org-fc",
		ClaimSize: driver.ClaimSize{MemoryMB: 2048, CPUs: 2}, ExpiresAt: now.Add(10 * time.Minute), HardExpiresAt: now.Add(30 * time.Minute),
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Driver.Destroy(context.Background(), ref) })
	var c *guest.Client
	deadline := time.Now().Add(60 * time.Second)
	for c == nil {
		if rw, err := s.Driver.DialGuest(ctx, ref); err == nil {
			c = guest.NewClient(rw, cellID, claim)
		} else if time.Now().After(deadline) {
			t.Fatalf("the environment's guest agent never answered: %v", err)
		} else {
			time.Sleep(200 * time.Millisecond)
		}
	}
	defer c.Close()
	t.Logf("boot %s: %d ms (create to the guest agent's vsock answer)", ref.MachineID, time.Since(now).Milliseconds())
	cmd := "id -u; for i in $(seq 60); do docker info --format '{{.ServerVersion}} {{.CgroupVersion}}' 2>/dev/null && exit 0; sleep 1; done; exit 1"
	timeout := int64(90_000)
	r, err := c.Do(ctx, guest.NewID(), protocol.SandboxOp{Op: protocol.SandboxOpKindExec, Command: &cmd, TimeoutMs: &timeout})
	if err != nil || r.Exec == nil {
		t.Fatalf("exec: %+v %v", r, err)
	}
	if r.Exec.ExitCode != 0 || !strings.HasPrefix(r.Exec.Stdout, "0\n") || !strings.Contains(r.Exec.Stdout, " 2") {
		t.Fatalf("docker in the environment machine: exit %d %q %q", r.Exec.ExitCode, r.Exec.Stdout, r.Exec.Stderr)
	}
	t.Logf("dockerd in %s: %s", ref.MachineID, strings.TrimSpace(r.Exec.Stdout))
	start := time.Now()
	if err := s.Driver.Destroy(ctx, ref); err != nil {
		t.Fatal(err)
	}
	t.Logf("destroy %s: %d ms", ref.MachineID, time.Since(start).Milliseconds())
}

// Two sandboxes of one claim reach each other on its bridge on a host whose
// Docker drops forwarded traffic, with br_netfilter loaded as Docker leaves
// it once a network needs it. The boot (Create to the guest agent's first
// answer) and destroy times are logged.
func TestFirecrackerTwoMachinesOfOneClaimReachEachOther(t *testing.T) {
	s := open(t)
	if out, err := exec.Command("modprobe", "br_netfilter").CombinedOutput(); err != nil {
		t.Logf("modprobe br_netfilter: %v %s", err, out)
	}
	fwd, _ := exec.Command("iptables", "-w", "5", "-S", "FORWARD").Output()
	nf, _ := os.ReadFile("/proc/sys/net/bridge/bridge-nf-call-iptables")
	t.Logf("host: %s, bridge-nf-call-iptables=%s", strings.SplitN(string(fwd), "\n", 2)[0], strings.TrimSpace(string(nf)))
	ctx := context.Background()
	claim := "fc-pair-" + time.Now().Format("150405")
	n, err := s.Driver.PrepareClaim(ctx, driver.ClaimNetworkSpec{CellID: cellID, OrgID: "org-fc", ClaimID: claim})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Driver.ReleaseClaim(context.Background(), n) })
	boot := func(role driver.Role) (driver.MachineRef, *guest.Client) {
		now := time.Now()
		ref, err := s.Driver.CreateSandbox(ctx, driver.SandboxRequest{Spec: driver.MachineSpec{
			CellID: cellID, EnvironmentID: "env-fc", Role: role, OrgID: "org-fc", ClaimID: claim,
			ClaimGroupID: n.WorkloadGroupID, KMSKeyRef: "kms-org-fc",
			ExpiresAt: now.Add(10 * time.Minute), HardExpiresAt: now.Add(30 * time.Minute),
		}})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = s.Driver.Destroy(context.WithoutCancel(ctx), ref) })
		for {
			if rw, err := s.Driver.DialGuest(ctx, ref); err == nil {
				c := guest.NewClient(rw, cellID, claim)
				if r, err := c.Do(ctx, guest.NewID(), protocol.SandboxOp{Op: protocol.SandboxOpKindStat}); err == nil && r.Ok {
					t.Logf("boot %s: %d ms (create to the guest agent's first answer)", ref.MachineID, time.Since(now).Milliseconds())
					t.Cleanup(func() { _ = c.Close() })
					return ref, c
				}
				_ = c.Close()
			}
			if time.Since(now) > 30*time.Second {
				t.Fatalf("the guest agent of %s never answered", ref.MachineID)
			}
			time.Sleep(20 * time.Millisecond)
		}
	}
	one, c1 := boot(driver.RoleWorkload)
	two, c2 := boot(driver.RolePool)
	sh := func(c *guest.Client, command string) *protocol.SandboxExecResult {
		timeout := int64(60_000)
		r, err := c.Do(ctx, guest.NewID(), protocol.SandboxOp{Op: protocol.SandboxOpKindExec, Command: &command, TimeoutMs: &timeout})
		if err != nil || r.Exec == nil {
			t.Errorf("exec: %+v %v", r, err)
			return &protocol.SandboxExecResult{ExitCode: -1}
		}
		return r.Exec
	}
	served := make(chan *protocol.SandboxExecResult, 1)
	go func() {
		served <- sh(c2, `python3 -c 'import socket
s = socket.socket(); s.bind(("0.0.0.0", 8080)); s.listen(1); s.settimeout(30)
c, a = s.accept(); c.sendall(b"hi"); c.close(); print(a[0])'`)
	}()
	got := sh(c1, fmt.Sprintf(`python3 -c 'import socket, sys, time
for _ in range(100):
    try:
        s = socket.create_connection((%q, 8080), timeout=1); print(s.recv(2).decode()); sys.exit(0)
    except OSError as e:
        err = e; time.sleep(0.2)
print("refused", err); sys.exit(1)'`, two.PrivateAddress))
	srv := <-served
	if got.ExitCode != 0 || strings.TrimSpace(got.Stdout) != "hi" || strings.TrimSpace(srv.Stdout) != one.PrivateAddress {
		t.Fatalf("%s -> %s on their claim's bridge: client %d %q %q, server %d %q %q",
			one.PrivateAddress, two.PrivateAddress, got.ExitCode, got.Stdout, got.Stderr, srv.ExitCode, srv.Stdout, srv.Stderr)
	}
	for _, ref := range []driver.MachineRef{one, two} {
		start := time.Now()
		if err := s.Driver.Destroy(ctx, ref); err != nil {
			t.Fatal(err)
		}
		t.Logf("destroy %s: %d ms", ref.MachineID, time.Since(start).Milliseconds())
	}
}

// pushedEgress is the cell's egress on the host: the proxy and resolver on
// the placement's egress address, the policy pushed as the agent does.
// owners is which claim's policy holds each source, so a claim whose
// machine takes an address another (released) claim's policy still holds
// removes that policy first, as the agent removes a claim's on release.
type pushedEgress struct {
	push   control.Pusher
	mu     *sync.Mutex
	owners map[string]string
}

func (p pushedEgress) Allow(ctx context.Context, claimID, orgID string, n driver.ClaimNetwork, sources, hosts []string) error {
	return p.Push(ctx, policy.ClaimPolicy{
		ClaimID: claimID, OrgID: orgID, Phase: policy.PhaseTest, Sources: sources, Allow: hosts,
		SteerTo: n.EgressAddress, ExpiresAt: time.Now().Add(time.Hour), IssuedAt: time.Now(),
	})
}

// Push sends a claim's policy, after removing the policy of another claim
// that still holds one of its sources.
func (p pushedEgress) Push(ctx context.Context, pol policy.ClaimPolicy) error {
	claimID := pol.ClaimID
	p.mu.Lock()
	for _, src := range pol.Sources {
		if owner, ok := p.owners[src]; ok && owner != claimID {
			if err := p.push.Remove(ctx, owner); err != nil {
				p.mu.Unlock()
				return err
			}
			for s, o := range p.owners {
				if o == owner {
					delete(p.owners, s)
				}
			}
		}
		p.owners[src] = claimID
	}
	p.mu.Unlock()
	return p.push.Push(ctx, pol)
}

// The secret's host and another credential host: real names the egress
// resolves; the injector answers both from a local server.
const (
	secretHost    = "example.org"
	notSecretHost = "example.net"
)

func startEgress(t *testing.T, addr string, extra ...string) pushedEgress {
	t.Helper()
	dir := t.TempDir()
	bin := filepath.Join(dir, "egress")
	build := exec.Command("go", "build", "-o", bin, "../../cmd/egress")
	build.Env = append(os.Environ(), "CGO_ENABLED=0")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build egress: %v\n%s", err, out)
	}
	ca, err := testpki.NewCA("fc-e2e-ca")
	if err != nil {
		t.Fatal(err)
	}
	server, _ := ca.Issue("kodus-egress", time.Hour, "kodus-egress")
	if err := ca.WriteFiles(dir, "", server); err != nil {
		t.Fatal(err)
	}
	agent, _ := ca.Issue("cell-fc-e2e", time.Hour)
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	der, _ := x509.MarshalPKIXPublicKey(pub)
	if err := os.WriteFile(filepath.Join(dir, "agent.pub.pem"), pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}), 0o600); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(bin, "-listen-tls", addr+":443", "-listen-http", addr+":80", "-dns-listen", addr+":53",
		"-control", "127.0.0.1:19443", "-cert", filepath.Join(dir, "cert.pem"), "-key", filepath.Join(dir, "key.pem"),
		"-ca", filepath.Join(dir, "ca.pem"), "-agent-pub", filepath.Join(dir, "agent.pub.pem"),
		"-upstream-dns", "1.1.1.1:53", "-transparent=false")
	cmd.Args = append(cmd.Args, extra...)
	logf, _ := os.Create(filepath.Join(dir, "egress.log"))
	cmd.Stdout, cmd.Stderr = logf, logf
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait(); _ = logf.Close() })
	tr := &http.Transport{TLSClientConfig: &tls.Config{Certificates: []tls.Certificate{agent}, RootCAs: ca.Pool(), ServerName: "kodus-egress", MinVersion: tls.VersionTLS13}}
	push := control.Pusher{Endpoints: []control.Endpoint{{Name: control.EndpointEgress, URL: "https://127.0.0.1:19443"}}, HTTP: &http.Client{Transport: tr, Timeout: 10 * time.Second}, Key: priv}
	deadline := time.Now().Add(10 * time.Second)
	for {
		c, err := tls.Dial("tcp", "127.0.0.1:19443", tr.TLSClientConfig)
		if err == nil {
			_ = c.Close()
			break
		}
		if time.Now().After(deadline) {
			b, _ := os.ReadFile(filepath.Join(dir, "egress.log"))
			t.Fatalf("the egress never listened: %v\n%s", err, b)
		}
		time.Sleep(100 * time.Millisecond)
	}
	return pushedEgress{push: push, mu: &sync.Mutex{}, owners: map[string]string{}}
}

// microvmOrphan is a machine whose cell died mid-claim: its record gone,
// its VMM, cgroup, jail, host link and network namespace not.
func microvmOrphan(t *testing.T, ref driver.MachineRef) func() []string {
	t.Helper()
	id := machineJailID(ref.MachineID)
	raw, err := os.ReadFile(filepath.Join(stateDir(), "vm", "jail", "firecracker", id, "root", "firecracker.pid"))
	if err != nil {
		t.Fatal(err)
	}
	pieces := []string{
		"/proc/" + strings.TrimSpace(string(raw)),
		"/sys/fs/cgroup/kodus-microvm/" + id,
		filepath.Join(stateDir(), "vm", "jail", "firecracker", id),
		"/sys/class/net/" + hostnet.TapName(ref.MachineID),
		hostnet.NetnsPath(hostnet.NetnsName(ref.MachineID)),
	}
	if err := os.Remove(filepath.Join(stateDir(), "vm", "machines", id+".json")); err != nil {
		t.Fatal(err)
	}
	return func() []string {
		var left []string
		for _, p := range pieces {
			if _, err := os.Stat(p); err == nil {
				left = append(left, p)
			}
		}
		return left
	}
}
