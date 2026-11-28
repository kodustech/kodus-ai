package conformance

import (
	"context"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/guest"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// fetch is a python3 program that GETs argv[1] and exits 0 when an answer came back.
const fetch = `import sys, urllib.request
try:
    urllib.request.urlopen(sys.argv[1], timeout=10).read(64)
    print("reached")
except Exception as e:
    print("refused", type(e).__name__)
    sys.exit(3)`

// A machine reaches an allowed host through the cell's egress and nothing
// else: not a host off the list, not an address, not another resolver.
func offAllowListEgressIsRefused(t *testing.T, tg Target) {
	if tg.Egress == nil {
		t.Skip(tg.Name + " has no network boundary between a machine and the host: run it on gvisor")
	}
	b := newBox(t, tg, "org-conf-a", driver.ClaimSize{}, driver.RoleWorkload)
	if err := tg.Egress.Allow(context.Background(), b.claim, b.org, b.net, []string{b.ref.PrivateAddress}, []string{tg.AllowedHost}); err != nil {
		t.Fatalf("allow: %v", err)
	}
	get := func(url string) *protocol.SandboxExecResult {
		return b.sh(t, "python3 -c "+shellQuote(fetch)+" "+shellQuote(url))
	}
	if r := get("https://" + tg.AllowedHost + "/"); r.ExitCode != 0 {
		t.Fatalf("the allowed host was not reached, so a refusal would prove nothing: %s %s", r.Stdout, r.Stderr)
	}
	for _, url := range []string{"https://" + tg.DeniedHost + "/", "http://1.1.1.1/"} {
		if r := get(url); r.ExitCode == 0 {
			t.Errorf("%s went through: %s", url, r.Stdout)
		}
	}
	if r := b.python(t, `import socket; s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.settimeout(5); s.sendto(b"\x12\x34\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00\x07example\x03com\x00\x00\x01\x00\x01", ("8.8.8.8", 53)); s.recv(512)`); r.ExitCode == 0 {
		t.Error("a resolver other than the cell's answered")
	}
}

// The guest agent opens every path one segment at a time without following
// a link, so a symlink in /workspace, to a directory or a file, takes no
// file op outside it; a plain file still reads.
func aWorkspaceSymlinkCannotReadOutsideIt(t *testing.T, tg Target) {
	b := newBox(t, tg, "org-conf-a", driver.ClaimSize{}, driver.RoleWorkload)
	b.write(t, "plain.txt", "inside")
	if got, err := b.read(t, "plain.txt"); err != nil || got != "inside" {
		t.Fatalf("a plain file does not read, so a refusal would prove nothing: %q %v", got, err)
	}
	if r := b.sh(t, "ln -s / root && ln -s /etc/hosts hosts && mkdir -p d && ln -s .. d/up && ln -s plain.txt alias"); r.ExitCode != 0 {
		t.Fatalf("links: %s", r.Stderr)
	}
	for _, p := range []string{"root/etc/hosts", "hosts", "d/up/plain.txt", "alias"} {
		if got, err := b.read(t, p); err == nil {
			t.Errorf("read %s followed a link: %q", p, got)
		}
	}
	for _, op := range []protocol.SandboxOp{
		{Op: protocol.SandboxOpKindList, Path: ptr("root")},
		{Op: protocol.SandboxOpKindStat, Path: ptr("root/etc")},
		{Op: protocol.SandboxOpKindWrite, Path: ptr("root/tmp/escaped"), Content: ptr("eA=="), Mkdirs: ptr(true)},
	} {
		if r := b.do(t, op); r.Ok {
			t.Errorf("%s %s followed a link: %+v", op.Op, *op.Path, r)
		}
	}
}

// The machine holds a placeholder; the value reaches the secret's own host
// and no other, not even another credential host of the same claim.
func aPlaceholderBecomesTheValueOnlyForItsHost(t *testing.T, tg Target) {
	if tg.Secrets == nil {
		t.Skip(tg.Name + " runs no injector beside its egress in this harness (Target.Secrets, conformance.StartInjector)")
	}
	b := newBox(t, tg, "org-conf-a", driver.ClaimSize{}, driver.RoleWorkload)
	placeholder, value, call := tg.Secrets.Grant(t, b.claim, b.org, b.net, []string{b.ref.PrivateAddress}, tg.SecretHost, tg.NotSecretHost)
	env := "KODY_CONF_SECRET=" + placeholder
	if r := b.sh(t, call(tg.SecretHost), env); r.ExitCode != 0 || strings.Contains(r.Stdout, value) {
		t.Fatalf("call to the secret's host: exit %d, the machine read the value back: %v (%s)", r.ExitCode, strings.Contains(r.Stdout, value), r.Stderr)
	}
	if got := tg.Secrets.Received(tg.SecretHost); got != "Bearer "+value {
		t.Fatal("the secret's host did not receive the value")
	}
	_ = b.sh(t, call(tg.NotSecretHost), env)
	if got := tg.Secrets.Received(tg.NotSecretHost); strings.Contains(got, value) {
		t.Fatal("another host received the value")
	}
	if r := b.sh(t, "env"); strings.Contains(r.Stdout, value) {
		t.Fatal("the machine's env holds the value")
	}
}

// Two orgs' machines are two machines, apart: neither sees the other's
// files, neither reaches the other's address, and a blank pool machine a
// claim held is never the one the next claim gets, nor are its files.
func twoOrgsNeverShareAMachineOrPooledClone(t *testing.T, tg Target) {
	a := newBox(t, tg, "org-conf-a", driver.ClaimSize{}, driver.RoleWorkload)
	b := newBox(t, tg, "org-conf-b", driver.ClaimSize{}, driver.RoleWorkload)
	if a.ref.MachineID == b.ref.MachineID || a.ref.DriverRef == b.ref.DriverRef || a.net.WorkloadGroupID == b.net.WorkloadGroupID {
		t.Fatalf("two orgs share a machine or a network: %+v %+v", a.ref, b.ref)
	}
	a.write(t, "org-a.txt", "a's")
	if got, err := b.read(t, "org-a.txt"); err == nil {
		t.Fatalf("org b read org a's file: %q", got)
	}
	if tg.Boundary {
		// Each claim network has no route to another: a's address does not answer b.
		probe := `import socket, sys; s = socket.socket(); s.settimeout(4)
try:
    s.connect((sys.argv[1], 22)); sys.exit(0)
except ConnectionRefusedError:
    sys.exit(0)
except Exception:
    sys.exit(3)`
		if r := b.sh(t, "python3 -c "+shellQuote(probe)+" "+a.ref.PrivateAddress); r.ExitCode == 0 {
			t.Errorf("org b reached org a's machine at %s", a.ref.PrivateAddress)
		}
	}
	// A blank pool machine is held by one claim and destroyed with it: the
	// next pool machine is another, with none of its files.
	p := newBox(t, tg, "kodus-sandbox-pool", driver.ClaimSize{}, driver.RolePool)
	p.write(t, "held-by-a.txt", "a's")
	first := p.ref
	p.release()
	q := newBox(t, tg, "kodus-sandbox-pool", driver.ClaimSize{}, driver.RolePool)
	if q.ref.DriverRef == first.DriverRef {
		t.Fatal("the next pool machine is the one a claim held")
	}
	if got, err := q.read(t, "held-by-a.txt"); err == nil {
		t.Fatalf("the next pool machine holds the last claim's file: %q", got)
	}
}

// Released, a machine answers nothing, is listed nowhere, and the host
// keeps nothing of it: no container, no volume, no directory.
func aReleasedMachineIsGoneWithItsFiles(t *testing.T, tg Target) {
	b := newBox(t, tg, "org-conf-a", driver.ClaimSize{}, driver.RoleWorkload)
	b.write(t, "work/output.txt", "something to keep")
	if left := tg.Leftovers(t, b.ref.MachineID); len(left) == 0 {
		t.Fatal("the host shows nothing of a live machine, so an empty list later would prove nothing")
	}
	ref := b.ref
	b.release()
	if rw, err := tg.Driver.DialGuest(context.Background(), ref); err == nil {
		_ = rw.Close()
		t.Fatal("a released machine's guest agent answers")
	}
	listed, err := tg.Driver.List(context.Background(), map[string]string{driver.TagClaim: b.claim})
	if err != nil {
		t.Fatal(err)
	}
	if slices.ContainsFunc(listed, func(r driver.MachineRef) bool { return r.MachineID == ref.MachineID }) {
		t.Fatal("a released machine is still listed")
	}
	if left := tg.Leftovers(t, ref.MachineID); len(left) > 0 {
		t.Fatalf("the host keeps %v of a released machine", left)
	}
}

// A machine of 512 MB and 1 CPU cannot hold a gigabyte, and two busy
// processes in it get about one CPU between them. Over its memory the
// command fails, or the whole machine ends: gVisor's sandbox is one process
// group under the limit, so the host's OOM killer takes the machine with
// its guest agent (the stream closes). Either way the gigabyte was not held;
// the CPU part runs in a machine of its own.
func memoryAndCPULimitsHold(t *testing.T, tg Target) {
	if !tg.Boundary {
		t.Skip(tg.Name + " runs commands on the host: it limits nothing")
	}
	size := driver.ClaimSize{MemoryMB: 512, CPUs: 1}
	mem := newBox(t, tg, "org-conf-a", size, driver.RoleWorkload)
	if r := mem.python(t, `b = b"x" * (64 << 20); print(len(b))`); r.ExitCode != 0 {
		t.Fatalf("64 MB does not fit, so a refusal of 1 GB would prove nothing: %s", r.Stderr)
	}
	program := "python3 -c " + shellQuote(`b = b"x" * (1 << 30); print(len(b))`)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	res, err := mem.client.Do(ctx, guest.NewID(), protocol.SandboxOp{Op: protocol.SandboxOpKindExec, Command: &program, TimeoutMs: ptr[int64](90_000)})
	cancel()
	if err == nil && res.Exec != nil && res.Exec.ExitCode == 0 {
		t.Fatal("a 512 MB machine held 1 GB")
	}
	mem.release()
	b := newBox(t, tg, "org-conf-a", size, driver.RoleWorkload)
	// The work two spinning processes get done in 3 s with one CPU against
	// the same in a machine of two: about half. Work, not CPU time: gVisor's
	// sentry counts a task's time while the host's CFS has throttled it, so
	// its getrusage read 4.3-4.8 s for two spinners in 3 s while the
	// container's cgroup used 3.07 s of its 1-CPU cpu.max (30 throttled
	// periods); runc read 3.0 s. The limit held; the old check read the
	// guest's clock. Against a 2-CPU machine, not one spinner: a lone
	// spinner gets less than a whole CPU under gVisor (two did 1.3-1.5x its
	// work on one CPU, 2.6x on two).
	spin := func(m *box) int {
		t.Helper()
		program := `import os, time
end = time.time() + 3; pipes = []
for _ in range(2):
    r, w = os.pipe()
    if os.fork() == 0:
        n = 0
        while time.time() < end: n += 1
        os.write(w, str(n).encode()); os._exit(0)
    os.close(w); pipes.append(r)
total = sum(int(os.read(r, 64)) for r in pipes)
for _ in range(2): os.wait()
print(total)`
		r := m.sh(t, "python3 -c "+shellQuote(program))
		n, err := strconv.Atoi(strings.TrimSpace(r.Stdout))
		if r.ExitCode != 0 || err != nil || n <= 0 {
			t.Fatalf("spin: exit %d %q %s", r.ExitCode, r.Stdout, r.Stderr)
		}
		return n
	}
	oneCPU := spin(b)
	b.release()
	twoCPUs := spin(newBox(t, tg, "org-conf-a", driver.ClaimSize{MemoryMB: 512, CPUs: 2}, driver.RoleWorkload))
	ratio := float64(oneCPU) / float64(twoCPUs)
	t.Logf("%s: two spinners did %d iterations in 3 s on one CPU, %d on two (%.2f)", tg.Name, oneCPU, twoCPUs, ratio)
	if ratio > 0.75 {
		t.Fatalf("two processes on one CPU did %.2f of their work on two: the CPU limit does not hold", ratio)
	}
}
