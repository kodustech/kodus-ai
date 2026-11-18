//go:build linux

package fcregress

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/guest"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/placement/hostnet"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// The §10 security cases a backend decides, run as attacks from inside
// real microVMs on this host (docs/runtime/isolation-p3-snapshots.md,
// "Security suite on firecracker"). Claim A holds a sandbox VM (the code
// sandbox's user, python3) and an environment VM (root: what a PR's
// privileged container gets); claim B holds a sandbox VM with a listener.
// Every refusal is checked against a control that succeeds, so a test that
// cannot reach anything proves nothing and fails.
func TestFirecrackerSecuritySuite(t *testing.T) {
	s := open(t)
	e := startEgress(t, s.Place.Egress().String())
	ctx := context.Background()
	egress := s.Place.Egress().String()
	stamp := time.Now().Format("150405")
	claimA, claimB := "fc-sec-a-"+stamp, "fc-sec-b-"+stamp
	nA, nB := claimNet(t, s.Driver, claimA), claimNet(t, s.Driver, claimB)

	type vm struct {
		ref driver.MachineRef
		c   *guest.Client
	}
	// A claim's machines are named by their role: claim A's sandbox is its
	// second machine (role pool), as TestFirecrackerTwoMachinesOfOneClaimReachEachOther.
	boot := func(claim string, n driver.ClaimNetwork, env bool, role driver.Role, mut func(*driver.MachineSpec)) vm {
		t.Helper()
		spec := machineSpec(claim, n, role, mut)
		var ref driver.MachineRef
		var err error
		if env {
			spec.ImageID, spec.ImageRef, spec.ClaimSize = "environment", "environment", driver.ClaimSize{MemoryMB: 2048, CPUs: 2}
			ref, err = s.Driver.Create(ctx, spec)
		} else {
			ref, err = s.Driver.CreateSandbox(ctx, driver.SandboxRequest{Spec: spec})
		}
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = s.Driver.Destroy(context.WithoutCancel(ctx), ref) })
		c := answer(t, func() (*guest.Client, error) { //nolint:contextcheck // answer dials until the agent answers, on its own context as the other tests' helpers
			rw, err := s.Driver.DialGuest(ctx, ref)
			if err != nil {
				return nil, err
			}
			return guest.NewClient(rw, cellID, claim), nil
		}, time.Minute)
		t.Cleanup(func() { _ = c.Close() })
		return vm{ref, c}
	}
	sa := boot(claimA, nA, false, driver.RolePool, nil)
	ea := boot(claimA, nA, true, driver.RoleWorkload, nil)
	sb := boot(claimB, nB, false, driver.RoleWorkload, nil)
	if err := e.Allow(ctx, claimA, "org-fc", nA, []string{sa.ref.PrivateAddress, ea.ref.PrivateAddress}, []string{"registry.npmjs.org"}); err != nil {
		t.Fatal(err)
	}
	out := func(m vm, cmd string) string {
		t.Helper()
		r := run(t, m.c, cmd, 60_000)
		return strings.TrimSpace(r.Stdout + r.Stderr)
	}
	// py runs a python3 program in a sandbox VM.
	py := func(m vm, prog string) string { return out(m, "python3 - <<'PY'\n"+prog+"\nPY") }
	// tcp reports "open" or "closed <why>" for each address from python.
	tcp := func(m vm, addrs ...string) string {
		var b strings.Builder
		b.WriteString("import socket\nfor host, port in [")
		for _, a := range addrs {
			h, p, _ := strings.Cut(a, "|")
			fmt.Fprintf(&b, "(%q, %s),", h, p)
		}
		b.WriteString("]:\n    try:\n        socket.create_connection((host, port), timeout=3).close(); print('open', host, port)\n    except OSError as e:\n        print('closed', host, port, e)\n")
		return py(m, b.String())
	}
	// bashTCP is the same from the environment VM (root, no python): exit 0 when it connected.
	bashTCP := func(m vm, host, port string) string {
		return out(m, fmt.Sprintf("timeout 4 bash -c 'exec 3<>/dev/tcp/%s/%s' 2>&1 && echo open || echo closed", host, port))
	}
	hostIP := func() string {
		b, err := exec.Command("sh", "-c", "ip -4 route get 1.1.1.1 | sed -n 's/.* src \\([0-9.]*\\).*/\\1/p'").Output()
		if err != nil {
			t.Fatal(err)
		}
		return strings.TrimSpace(string(b))
	}()
	report := func(t *testing.T, format string, a ...any) { t.Logf("EVIDENCE "+format, a...) }

	t.Run("S-01 no metadata, secret or host credential reaches the VM", func(t *testing.T) {
		hostIMDS, _ := exec.Command("sh", "-c", "curl -s -m 3 -o /dev/null -w '%{http_code}' -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60'").Output()
		v4, v6 := bashTCP(ea, "169.254.169.254", "80"), bashTCP(ea, "fd00:ec2::254", "80")
		if strings.HasSuffix(v4, "open") || strings.HasSuffix(v6, "open") {
			t.Fatalf("the VM reached the instance metadata service: v4 %q v6 %q", v4, v6)
		}
		env := out(ea, "env | cut -d= -f1 | sort | tr '\\n' ' '; echo; cat /proc/cmdline")
		for _, bad := range []string{"AWS_", "TOKEN", "SECRET", "KODUS_", "PASSWORD"} {
			if strings.Contains(strings.ToUpper(env), bad) {
				t.Fatalf("the VM's environment or kernel command line names %s: %s", bad, env)
			}
		}
		mounts := out(ea, "cut -d' ' -f1,2 /proc/mounts | grep -v -E '^(proc|sysfs|tmpfs|devtmpfs|devpts|cgroup2|mqueue|overlay|nsfs|shm|bpf|securityfs|debugfs|tracefs|hugetlbfs|configfs|fusectl|pstore) ' | tr '\\n' ' '")
		report(t, "S-01 host IMDS answers %s; from the VM as root: IMDSv4 %s, IMDSv6 %s; env names and cmdline: %s; block mounts: %s", hostIMDS, v4, v6, env, mounts)
	})

	t.Run("S-02 no traffic between claims, to the host or over vsock to the host", func(t *testing.T) {
		served := make(chan string, 1)
		go func() {
			r, err := sb.c.Do(ctx, guest.NewID(), sandboxExec(`python3 -c 'import socket
s = socket.socket(); s.bind(("0.0.0.0", 8080)); s.listen(4); s.settimeout(20)
try:
    c, a = s.accept(); print("accepted", a[0])
except OSError as e:
    print("none", e)'`, 30_000))
			if err != nil || r.Exec == nil {
				served <- fmt.Sprintf("listener failed: %v", err)
				return
			}
			served <- strings.TrimSpace(r.Exec.Stdout)
		}()
		time.Sleep(time.Second)
		cross := tcp(sa, sb.ref.PrivateAddress+"|8080")
		crossRoot := bashTCP(ea, sb.ref.PrivateAddress, "8080")
		host := tcp(sa, egress+"|22", egress+"|19443", egress+"|8080", hostIP+"|22", "127.0.0.1|22")
		vsock := py(sa, `import socket
for port in (52, 1023, 1024, 5000, 7443):
    s = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM); s.settimeout(3)
    try:
        s.connect((2, port)); print("open", port)
    except OSError as e:
        print("closed", port, e)`)
		heard := <-served
		if strings.Contains(cross, "open") || strings.HasSuffix(crossRoot, "open") || strings.HasPrefix(heard, "accepted") {
			t.Fatalf("claim A reached claim B: %q %q, B heard %q", cross, crossRoot, heard)
		}
		if strings.Contains(host, "open") || strings.Contains(vsock, "open") {
			t.Fatalf("a VM reached the host: tcp %q vsock %q", host, vsock)
		}
		// The control: the same VM does reach the egress it is allowed.
		if ctl := tcp(sa, egress+"|443"); !strings.Contains(ctl, "open") {
			t.Fatalf("the control failed: the VM does not reach its egress at all: %q", ctl)
		}
		report(t, "S-02 A sandbox -> B %s:8080: %s; A root -> B: %s; B heard: %s; to the host: %s; vsock to the host (CID 2): %s; observer: TestFirecrackerObserverVMAnswersOnlyOverVsock",
			sb.ref.PrivateAddress, cross, crossRoot, heard, host, vsock)
	})

	t.Run("S-02 spoofed source address or MAC is dropped", func(t *testing.T) {
		spoof := spoofedNeighbour(ea.ref.PrivateAddress)
		probe := fmt.Sprintf("timeout 4 bash -c 'exec 3<>/dev/tcp/%s/443' 2>/dev/null; echo exit=$?", egress)
		gw := `gw=$(ip -4 route show default | awk '{print $3}'); `
		before := out(ea, probe)
		spoofSrc := out(ea, gw+fmt.Sprintf("ip addr add %s/32 dev eth0 && ip route replace default via $gw dev eth0 src %s; ip route replace %s/32 dev eth0 src %s 2>/dev/null; %s; ip route replace default via $gw dev eth0 src %s; ip route del %s/32 dev eth0 2>/dev/null; ip addr del %s/32 dev eth0", spoof, spoof, egress, spoof, probe, ea.ref.PrivateAddress, egress, spoof))
		spoofMAC := out(ea, gw+"mac=$(cat /sys/class/net/eth0/address); ip link set eth0 down; ip link set eth0 address 02:00:00:de:ad:01; ip link set eth0 up; ip route replace default via $gw dev eth0; ip neigh flush dev eth0; "+probe+"; ip link set eth0 down; ip link set eth0 address $mac; ip link set eth0 up; ip route replace default via $gw dev eth0; ip neigh flush dev eth0")
		after := out(ea, probe)
		if !strings.HasSuffix(before, "exit=0") || !strings.HasSuffix(after, "exit=0") {
			t.Fatalf("the control failed: own address to egress:443 before %q, after %q", before, after)
		}
		if strings.HasSuffix(spoofSrc, "exit=0") || strings.HasSuffix(spoofMAC, "exit=0") {
			t.Fatalf("a spoofed frame reached the egress: source %q, MAC %q", spoofSrc, spoofMAC)
		}
		report(t, "S-02 spoof as root in the VM: own address to egress:443 %s; source %s %s; MAC 02:00:00:de:ad:01 %s; own again %s", before, spoof, spoofSrc, spoofMAC, after)
	})

	t.Run("S-03 every way out but the egress is refused", func(t *testing.T) {
		direct := tcp(sa, "1.1.1.1|443", "8.8.8.8|53")
		v6 := tcp(sa, "2606:4700:4700::1111|443")
		udp := py(sa, `import socket
q = bytes.fromhex("abcd01000001000000000000076578616d706c6503636f6d0000010001")
for server in ("8.8.8.8", "1.1.1.1"):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.settimeout(3)
    try:
        s.sendto(q, (server, 53)); s.recvfrom(512); print("answered", server)
    except OSError as e:
        print("no answer", server, e)`)
		names := py(sa, `import socket
for name in ("dns.google", "cloudflare-dns.com", "s3.amazonaws.com", "registry.npmjs.org"):
    try:
        print(name, sorted({a[4][0] for a in socket.getaddrinfo(name, 443, proto=socket.IPPROTO_TCP)}))
    except OSError as e:
        print(name, "unresolved", e)`)
		sni := py(sa, fmt.Sprintf(`import socket, ssl
ctx = ssl.create_default_context()
for name in ("dns.google", "cloudflare-dns.com", "registry.npmjs.org"):
    try:
        with socket.create_connection((%q, 443), timeout=5) as raw:
            with ctx.wrap_socket(raw, server_hostname=name) as tl:
                print(name, "handshake", tl.version())
    except (OSError, ssl.SSLError) as e:
        print(name, "refused", type(e).__name__)`, egress))
		if strings.Contains(direct, "open") || strings.Contains(v6, "open") || strings.Contains(udp, "answered") {
			t.Fatalf("a direct way out: tcp %q v6 %q udp %q", direct, v6, udp)
		}
		for _, l := range strings.Split(names, "\n") {
			if !strings.HasPrefix(l, "registry.npmjs.org") && !strings.Contains(l, "unresolved") && !strings.Contains(l, "'"+egress+"'") {
				t.Fatalf("a name off the allow-list resolved to a real address: %q", l)
			}
		}
		for _, l := range strings.Split(sni, "\n") {
			if !strings.HasPrefix(l, "registry.npmjs.org") && strings.Contains(l, "handshake") {
				t.Fatalf("the egress carried TLS for a host off the allow-list (DoH): %q", l)
			}
		}
		if !strings.Contains(sni, "registry.npmjs.org handshake") {
			t.Fatalf("the control failed: the allowed host did not pass: %q", sni)
		}
		report(t, "S-03 direct: %s; IPv6: %s; UDP DNS: %s; names: %s; TLS through the egress by SNI: %s", direct, v6, udp, names, sni)
	})

	t.Run("S-04 generic storage and an unlisted domain are refused", func(t *testing.T) {
		got := py(sa, fmt.Sprintf(`import socket, ssl
ctx = ssl.create_default_context()
for name in ("s3.amazonaws.com", "storage.googleapis.com", "transfer.sh", "pastebin.com"):
    try:
        with socket.create_connection((%q, 443), timeout=5) as raw:
            with ctx.wrap_socket(raw, server_hostname=name) as tl:
                print(name, "handshake")
    except (OSError, ssl.SSLError) as e:
        print(name, "refused", type(e).__name__)`, egress))
		if strings.Contains(got, "handshake") {
			t.Fatalf("a storage or unlisted host passed: %q", got)
		}
		report(t, "S-04 %s (the egress denylist and the admin approval itself: internal/egress and internal/recipe unit tests)", got)
	})

	t.Run("S-06 the egress never carries a VM to the host or the cloud", func(t *testing.T) {
		got := py(sa, fmt.Sprintf(`import socket, ssl
ctx = ssl.create_default_context(); ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE
for name in ("169.254.169.254", "metadata.google.internal", %q, "localhost", "kodus-egress"):
    try:
        with socket.create_connection((%q, 443), timeout=5) as raw:
            with ctx.wrap_socket(raw, server_hostname=name) as tl:
                print(name, "handshake")
    except (OSError, ssl.SSLError) as e:
        print(name, "refused", type(e).__name__)
for host in ("169.254.169.254", "localhost", %q):
    try:
        with socket.create_connection((%q, 80), timeout=5) as c:
            c.sendall(("GET /latest/meta-data/ HTTP/1.1\r\nHost: %%s\r\nConnection: close\r\n\r\n" %% host).encode())
            print(host, "http", c.recv(64).split(b"\r\n")[0])
    except OSError as e:
        print(host, "http refused", type(e).__name__)`, hostIP, egress, hostIP, egress))
		for _, l := range strings.Split(got, "\n") {
			if strings.Contains(l, "handshake") || strings.Contains(l, "200 OK") {
				t.Fatalf("the egress carried the VM to the host or the metadata service: %q", l)
			}
		}
		report(t, "S-06 %s", got)
	})

	t.Run("S-08 a machine past its hard ceiling is destroyed by the reaper alone", func(t *testing.T) {
		// The reaper as deployed: its own binary, its own process, reading
		// only the cell's state directory and the host (cmd/reaper -driver
		// microvm), never the cell's driver in this process.
		bin := filepath.Join(t.TempDir(), "reaper")
		if out, err := exec.Command("go", "build", "-o", bin, "../../cmd/reaper").CombinedOutput(); err != nil {
			t.Fatalf("build the reaper: %v\n%s", err, out)
		}
		reap := func() string {
			t.Helper()
			out, err := exec.Command(bin, "-driver", "microvm", "-cell-id", cellID, "-firecracker-state-dir", stateDir(), "-once").CombinedOutput()
			if err != nil {
				t.Fatalf("the reaper: %v\n%s", err, out)
			}
			return string(out)
		}
		claimC := "fc-sec-c-" + stamp
		nC := claimNet(t, s.Driver, claimC) //nolint:contextcheck // the helper makes and releases a claim network on its own context, as the other tests'.
		short := boot(claimC, nC, false, driver.RoleWorkload, func(m *driver.MachineSpec) {
			m.ExpiresAt, m.HardExpiresAt = time.Now().Add(3*time.Second), time.Now().Add(4*time.Second)
		})
		time.Sleep(5 * time.Second)
		out := reap()
		left, _ := s.Driver.List(ctx, map[string]string{driver.TagCell: cellID})
		for _, r := range left {
			if r.MachineID == short.ref.MachineID {
				t.Fatalf("still listed after the reaper: %+v\n%s", r, out)
			}
		}
		if !strings.Contains(out, `"terminated":1`) {
			t.Fatalf("the reaper did not terminate %s:\n%s", short.ref.MachineID, out)
		}
		gone := func(what string, paths ...string) {
			t.Helper()
			for _, p := range paths {
				// A killed VMM is a zombie until its parent reaps it.
				for end := time.Now().Add(10 * time.Second); time.Now().Before(end); time.Sleep(200 * time.Millisecond) {
					if _, err := os.Stat(p); os.IsNotExist(err) {
						break
					}
				}
				if _, err := os.Stat(p); !os.IsNotExist(err) {
					t.Fatalf("%s %s is still there after the reaper", what, p)
				}
			}
		}
		id := machineJailID(short.ref.MachineID)
		gone("the expired machine's", "/sys/fs/cgroup/kodus-microvm/"+id, filepath.Join(stateDir(), "vm", "jail", "firecracker", id))
		report(t, "S-08 the out-of-process reaper terminated %s past its hard ceiling: %s", short.ref.MachineID, strings.TrimSpace(out))

		// A cell that died mid-claim: the machine's record is gone, its VMM,
		// cgroup, jail and tap are not. The reaper's orphan pass ends them.
		claimD := "fc-sec-d-" + stamp
		nD := claimNet(t, s.Driver, claimD) //nolint:contextcheck // the helper makes and releases a claim network on its own context, as the other tests'.
		lost := boot(claimD, nD, false, driver.RoleWorkload, nil)
		lid := machineJailID(lost.ref.MachineID)
		raw, err := os.ReadFile(filepath.Join(stateDir(), "vm", "jail", "firecracker", lid, "root", "firecracker.pid"))
		if err != nil {
			t.Fatal(err)
		}
		pid := strings.TrimSpace(string(raw))
		if err := os.Remove(filepath.Join(stateDir(), "vm", "machines", lid+".json")); err != nil {
			t.Fatal(err)
		}
		out = reap()
		tap := hostnet.TapName(lost.ref.MachineID)
		gone("the orphan's", "/proc/"+pid, "/sys/fs/cgroup/kodus-microvm/"+lid, filepath.Join(stateDir(), "vm", "jail", "firecracker", lid), "/sys/class/net/"+tap)
		report(t, "S-08 orphan pass: a machine without its record (VMM pid %s, tap %s) ended by the reaper: %s", pid, tap, strings.TrimSpace(out))
	})

	t.Run("S-09 a full disk and a fork bomb stay inside their VM", func(t *testing.T) {
		free := func() int64 {
			var st syscall.Statfs_t
			_ = syscall.Statfs(stateDir(), &st)
			return int64(st.Bavail) * st.Bsize //nolint:gosec // G115: a file system's counts fit an int64
		}
		freeBefore := free()
		// The fill writes the whole data disk: minutes on a busy state disk.
		fill := run(t, ea.c, "df -B1 --output=size,avail /var/lib/kody-data | tail -1; fallocate -l 500G /var/lib/kody-data/fill 2>&1 || dd if=/dev/zero of=/var/lib/kody-data/fill bs=4M 2>&1 | tail -1; df -B1 --output=avail /var/lib/kody-data | tail -1; rm -f /var/lib/kody-data/fill", 300_000)
		disk := strings.TrimSpace(fill.Stdout + fill.Stderr)
		freeAfter := free()
		if !strings.Contains(disk, "No space left") {
			t.Fatalf("the VM's disk did not fill at its own size: %q", disk)
		}
		// What the VM wrote came out of the room its disks were admitted
		// with: at most its data disk, and the host's disk keeps its margin.
		if grew := freeBefore - freeAfter; grew > 10<<30 || freeAfter < 1<<30 {
			t.Fatalf("the VM's full disk took %d MiB of the host's (free %d MiB after)", grew>>20, freeAfter>>20)
		}
		_ = out(ea, "nohup timeout -s KILL 25 bash -c 'b(){ b|b& }; b' >/dev/null 2>&1 &")
		time.Sleep(3 * time.Second)
		var worst time.Duration
		for range 5 {
			start := time.Now()
			if r := run(t, sb.c, "true", 10_000); r.ExitCode != 0 {
				t.Fatalf("the other claim's VM did not answer during the bomb: %+v", r)
			}
			worst = max(worst, time.Since(start))
			time.Sleep(time.Second)
		}
		load, _ := exec.Command("sh", "-c", "cut -d' ' -f1-3 /proc/loadavg; nproc").Output()
		if worst > 2*time.Second {
			t.Fatalf("the other claim's VM took %v to run a command during the bomb", worst)
		}
		report(t, "S-09 disk in the VM: %s; host state disk free before %d MiB, after %d MiB; fork bomb as root in claim A's VM: claim B's VM answered in at most %v, host load %s", strings.ReplaceAll(disk, "\n", " | "), freeBefore>>20, freeAfter>>20, worst.Round(time.Millisecond), strings.ReplaceAll(strings.TrimSpace(string(load)), "\n", " / "))
	})
}

// spoofedNeighbour is another address of the machine's /31 or /24, never its own.
func spoofedNeighbour(own string) string {
	i := strings.LastIndexByte(own, '.')
	if strings.HasSuffix(own, ".200") {
		return own[:i] + ".201"
	}
	return own[:i] + ".200"
}

func stateDir() string { return os.Getenv("KODY_E2E_FIRECRACKER_STATE") }

func sandboxExec(command string, timeoutMs int64) protocol.SandboxOp {
	return protocol.SandboxOp{Op: protocol.SandboxOpKindExec, Command: &command, TimeoutMs: &timeoutMs}
}
