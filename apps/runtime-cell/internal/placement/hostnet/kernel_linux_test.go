//go:build linux

package hostnet

import (
	"context"
	"net"
	"net/netip"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/unix"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/placement"
)

// The fence on a real kernel, without a VM: each tap is swapped for a veth
// of the same name whose other end is a network namespace standing in for
// the guest, with the address and MAC the placement gave it. Root, iproute2
// and nftables; it changes the host's network, so run it in a throwaway
// privileged container:
//
//	KODY_E2E_HOSTNET=1 go test -run TestOnARealKernel -v ./internal/placement/hostnet/
func TestOnARealKernelAMachineReachesTheEgressAndNothingElse(t *testing.T) {
	if os.Getenv("KODY_E2E_HOSTNET") != "1" {
		t.Skip("KODY_E2E_HOSTNET=1 runs it as root in a throwaway privileged container (it changes the host's network)")
	}
	ctx := context.Background()
	p, err := New(ctx, Config{StateDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	egress := p.Egress()
	serve(t, egress.String()+":443") // the proxy
	serve(t, "0.0.0.0:2222")         // anything else the host serves
	udp, err := net.ListenPacket("udp", egress.String()+":53")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = udp.Close() })
	go func() {
		b := make([]byte, 512)
		for {
			n, from, err := udp.ReadFrom(b)
			if err != nil {
				return
			}
			_, _ = udp.WriteTo(b[:n], from)
		}
	}()
	guest := func(network, machine, ns string) Attachment {
		claimNetwork(t, p, network)
		return fakeMachine(t, p, network, machine, ns)
	}
	a := guest("kodus-e2e-a", "ma", "kody-ga")
	b := guest("kodus-e2e-b", "mb", "kody-gb")
	time.Sleep(500 * time.Millisecond) // the bridges' ports leave the listening state
	reach := func(ns, addr string, from netip.Addr) bool { return reaches(t, ns, addr, from) }
	if !reach("kody-ga", egress.String()+":443", netip.Addr{}) {
		t.Fatal("the machine does not reach the egress, so the refusals below prove nothing")
	}
	inNetns(t, "kody-ga", func() {
		c, err := net.DialTimeout("udp", egress.String()+":53", time.Second)
		if err != nil {
			t.Fatal(err)
		}
		_ = c.SetDeadline(time.Now().Add(time.Second))
		_, _ = c.Write([]byte("q"))
		if n, err := c.Read(make([]byte, 4)); err != nil || n != 1 {
			t.Errorf("the resolver port does not answer: %v", err)
		}
		_ = c.Close()
	})
	for _, addr := range []string{
		egress.String() + ":2222",    // the egress address, another port
		a.Gateway.String() + ":2222", // the host through the gateway
		b.IP.String() + ":2222",      // another claim's machine
		b.Gateway.String() + ":2222", // another claim's gateway
		"1.1.1.1:443",                // the internet, straight
	} {
		if reach("kody-ga", addr, netip.Addr{}) {
			t.Errorf("the machine reached %s", addr)
		}
	}
	// Speaking as another address of its subnet, or with another MAC, is dropped.
	spoof := a.IP.As4()
	spoof[3] = 200
	sh(t, "ip", "netns", "exec", "kody-ga", "ip", "addr", "add", netip.AddrFrom4(spoof).String()+"/24", "dev", "g0")
	if reach("kody-ga", egress.String()+":443", netip.AddrFrom4(spoof)) {
		t.Error("a spoofed source address reached the egress")
	}
	sh(t, "ip", "netns", "exec", "kody-ga", "ip", "link", "set", "dev", "g0", "address", "06:00:de:ad:be:ef")
	if reach("kody-ga", egress.String()+":443", netip.Addr{}) {
		t.Error("a spoofed MAC reached the egress")
	}
}

// Two machines of one claim (an environment and its observer) reach each
// other on their bridge on a host whose Docker drops forwarded traffic by
// policy with br_netfilter loaded, as Docker leaves it once a network needs
// it. They used to be cut off: with br_netfilter the frame also crosses the
// IPv4 forward hook, and the ruleset's same-bridge accept does not override
// Docker's drop. A host without Docker's chain gets the same shape here
// (DOCKER-USER first in FORWARD, policy drop), restored at the end.
//
//	KODY_E2E_HOSTNET=1 go test -run TestOnARealKernelTwoMachinesOfOneClaim -v ./internal/placement/hostnet/
func TestOnARealKernelTwoMachinesOfOneClaimReachEachOtherPastDockersForwardDrop(t *testing.T) {
	if os.Getenv("KODY_E2E_HOSTNET") != "1" {
		t.Skip("KODY_E2E_HOSTNET=1 runs it as root in a throwaway privileged container (it changes the host's network)")
	}
	_ = exec.Command("modprobe", "br_netfilter").Run()
	if out, err := exec.Command("sysctl", "-n", "net.bridge.bridge-nf-call-iptables").Output(); err != nil || strings.TrimSpace(string(out)) != "1" {
		sh(t, "sysctl", "-q", "-w", "net.bridge.bridge-nf-call-iptables=1")
	}
	if exec.Command("iptables", "-w", "5", "-S", "DOCKER-USER").Run() != nil {
		sh(t, "iptables", "-w", "5", "-N", "DOCKER-USER")
		sh(t, "iptables", "-w", "5", "-I", "FORWARD", "-j", "DOCKER-USER")
		t.Cleanup(func() {
			_ = exec.Command("iptables", "-w", "5", "-D", "FORWARD", "-j", "DOCKER-USER").Run()
			_ = exec.Command("iptables", "-w", "5", "-F", "DOCKER-USER").Run()
			_ = exec.Command("iptables", "-w", "5", "-X", "DOCKER-USER").Run()
		})
	}
	policy := "ACCEPT"
	if out, err := exec.Command("iptables", "-w", "5", "-S", "FORWARD").Output(); err == nil && strings.HasPrefix(string(out), "-P FORWARD DROP") {
		policy = "DROP"
	}
	sh(t, "iptables", "-w", "5", "-P", "FORWARD", "DROP")
	t.Cleanup(func() { _ = exec.Command("iptables", "-w", "5", "-P", "FORWARD", policy).Run() })

	ctx := context.Background()
	p, err := New(ctx, Config{StateDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	claimNetwork(t, p, "kodus-e2e-c")
	one := fakeMachine(t, p, "kodus-e2e-c", "workload", "kody-c1")
	two := fakeMachine(t, p, "kodus-e2e-c", "observer", "kody-c2")
	inNetns(t, "kody-c2", func() { serve(t, two.IP.String()+":2222") })
	time.Sleep(500 * time.Millisecond) // the bridge's ports leave the listening state
	if !reaches(t, "kody-c1", two.IP.String()+":2222", netip.Addr{}) {
		t.Fatalf("%s does not reach %s on their claim's bridge", one.IP, two.IP)
	}
}

// claimNetwork is a claim network with the egress attached, removed when
// the test ends (after its machines, which register later).
func claimNetwork(t *testing.T, p *Placement, network string) {
	t.Helper()
	ctx := context.Background()
	if _, err := p.CreateNetwork(ctx, placement.NetworkSpec{Name: network, Key: network}); err != nil {
		t.Fatal(err)
	}
	if _, err := p.AttachEgress(ctx, network, ""); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = p.RemoveNetwork(context.WithoutCancel(ctx), network) })
}

// fakeMachine attaches a tap for machine and swaps it for a veth of the
// same name whose other end is the network namespace ns, with the address
// and MAC the placement gave it.
func fakeMachine(t *testing.T, p *Placement, network, machine, ns string) Attachment {
	t.Helper()
	ctx := context.Background()
	a, err := p.AttachTap(ctx, network, machine, 4242)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = p.DetachTap(context.WithoutCancel(ctx), network, machine) })
	br := ifname(BridgePrefix, network)
	sh(t, "ip", "link", "del", "dev", a.Tap)
	sh(t, "ip", "netns", "add", ns)
	t.Cleanup(func() { _ = exec.Command("ip", "netns", "del", ns).Run() })
	sh(t, "ip", "link", "add", a.Tap, "type", "veth", "peer", "name", "g0", "netns", ns)
	sh(t, "ip", "link", "set", "dev", a.Tap, "master", br, "up")
	in := func(args ...string) { sh(t, append([]string{"ip", "netns", "exec", ns}, args...)...) }
	in("ip", "link", "set", "dev", "g0", "address", a.MAC)
	in("ip", "addr", "add", netip.PrefixFrom(a.IP, a.Prefix).String(), "dev", "g0")
	in("ip", "link", "set", "dev", "g0", "up")
	in("ip", "link", "set", "dev", "lo", "up")
	in("ip", "route", "add", "default", "via", a.Gateway.String())
	return a
}

// serve answers "hi" to every TCP connection on addr until the test ends.
func serve(t *testing.T, addr string) {
	t.Helper()
	l, err := net.Listen("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = l.Close() })
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			_, _ = c.Write([]byte("hi"))
			_ = c.Close()
		}
	}()
}

// reaches reports whether a TCP connection from namespace ns to addr (from
// the given source, when valid) is answered.
func reaches(t *testing.T, ns, addr string, from netip.Addr) bool {
	t.Helper()
	ok := false
	inNetns(t, ns, func() {
		d := net.Dialer{Timeout: 1500 * time.Millisecond}
		if from.IsValid() {
			d.LocalAddr = &net.TCPAddr{IP: from.AsSlice()}
		}
		c, err := d.Dial("tcp", addr)
		if err == nil {
			buf := make([]byte, 2)
			_ = c.SetDeadline(time.Now().Add(time.Second))
			n, _ := c.Read(buf)
			ok = n == 2
			_ = c.Close()
		}
	})
	return ok
}

func sh(t *testing.T, args ...string) {
	t.Helper()
	if out, err := exec.Command(args[0], args[1:]...).CombinedOutput(); err != nil {
		t.Fatalf("%s: %v %s", strings.Join(args, " "), err, out)
	}
}

// inNetns runs f on a thread in the named network namespace.
func inNetns(t *testing.T, name string, f func()) {
	t.Helper()
	done := make(chan struct{})
	go func() {
		defer close(done)
		runtime.LockOSThread() // the thread ends with the goroutine, in the namespace
		fd, err := unix.Open("/run/netns/"+name, unix.O_RDONLY|unix.O_CLOEXEC, 0)
		if err != nil {
			t.Error(err)
			return
		}
		defer func() { _ = unix.Close(fd) }()
		if err := unix.Setns(fd, unix.CLONE_NEWNET); err != nil {
			t.Error(err)
			return
		}
		f()
	}()
	<-done
}
