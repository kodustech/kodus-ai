package hostnet

import (
	"context"
	"fmt"
	"net/netip"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/placement"
)

// host is the kernel as the placement sees it: links that exist, the last
// ruleset nft took, and Docker's DOCKER-USER chain when docker is set.
type host struct {
	mu         sync.Mutex
	links      map[string]string // name -> kind
	ruleset    string
	failOn     string
	docker     bool
	dockerUser []string
	cmds       []string
}

func (h *host) Run(_ context.Context, stdin []byte, name string, args ...string) ([]byte, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	line := name + " " + strings.Join(args, " ")
	h.cmds = append(h.cmds, line)
	if h.failOn != "" && strings.Contains(line, h.failOn) {
		return []byte("refused"), errFake
	}
	switch {
	case name == "nft":
		h.ruleset = string(stdin)
	case name == "iptables":
		return h.iptables(args)
	case len(args) == 3 && args[0] == "-o" && args[1] == "link" && args[2] == "show":
		var b strings.Builder
		i := 1
		for n, kind := range h.links {
			suffix := ""
			if kind == "veth" {
				suffix = "@if9"
			}
			fmt.Fprintf(&b, "%d: %s%s: <BROADCAST,MULTICAST,UP> mtu 1500 qdisc noqueue state UP\n", i, n, suffix)
			i++
		}
		return []byte(b.String()), nil
	case len(args) >= 3 && args[0] == "link" && args[1] == "show":
		if _, ok := h.links[args[3]]; !ok {
			return []byte("Cannot find device"), errFake
		}
	case len(args) >= 4 && args[0] == "link" && args[1] == "add" && args[2] == "name":
		h.links[args[3]] = args[len(args)-1]
	case len(args) >= 4 && args[0] == "link" && args[1] == "add":
		// "link add <name> type veth peer name veth0 netns <ns>": the host end.
		h.links[args[2]] = args[4]
	case len(args) >= 2 && (args[0] == "-n" || args[0] == "netns"):
		// Inside a machine's namespace, or the namespace itself: not the host's links.
		return nil, nil
	case len(args) >= 4 && args[0] == "tuntap" && args[1] == "add":
		h.links[args[3]] = "tap"
	case len(args) >= 4 && args[0] == "link" && args[1] == "del":
		if _, ok := h.links[args[3]]; !ok {
			return []byte("Cannot find device"), errFake
		}
		delete(h.links, args[3])
	}
	return nil, nil
}

// iptables keeps DOCKER-USER's rules as their spec after the chain name.
func (h *host) iptables(args []string) ([]byte, error) {
	for len(args) > 0 && (args[0] == "-w" || args[0] == "5") {
		args = args[1:]
	}
	if !h.docker || len(args) < 2 || args[1] != "DOCKER-USER" {
		return []byte("iptables: No chain/target/match by that name."), errFake
	}
	rule := strings.Join(args[2:], " ")
	switch args[0] {
	case "-S":
		return nil, nil
	case "-C":
		if !slices.Contains(h.dockerUser, rule) {
			return []byte("Bad rule"), errFake
		}
	case "-I":
		h.dockerUser = append([]string{rule}, h.dockerUser...)
	}
	return nil, nil
}

type fakeErr struct{}

func (fakeErr) Error() string { return "fake failure" }

var errFake = fakeErr{}

func newPlacement(t *testing.T, h *host, dir string) *Placement {
	t.Helper()
	p, err := New(context.Background(), Config{StateDir: dir, Runner: h})
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func newHost() *host { return &host{links: map[string]string{}} }

// A claim network is a bridge in its own /24 of the pool, its gateway the
// subnet's first address; two claims never share a subnet, and the
// networks and their labels survive a restart of the cell.
func TestAClaimNetworkIsABridgeInAFreeSubnetThatSurvivesARestart(t *testing.T) {
	h, dir := newHost(), t.TempDir()
	p := newPlacement(t, h, dir)
	ctx := context.Background()
	a, err := p.CreateNetwork(ctx, placement.NetworkSpec{Name: "kodus-claim-a", Key: "claim-a", Labels: map[string]string{"kodus.cell": "cell-1"}})
	if err != nil {
		t.Fatal(err)
	}
	b, err := p.CreateNetwork(ctx, placement.NetworkSpec{Name: "kodus-claim-b", Key: "claim-a"})
	if err != nil {
		t.Fatal(err)
	}
	if a == b || !DefaultPool.Contains(a.Addr()) || a.Bits() != 24 {
		t.Fatalf("subnets %s %s", a, b)
	}
	if h.links[ifname(BridgePrefix, "kodus-claim-a")] != "bridge" {
		t.Fatalf("no bridge: %v", h.links)
	}
	again := newPlacement(t, h, dir)
	labels, err := again.NetworkLabels(ctx, "kodus-claim-a")
	if err != nil || labels["kodus.cell"] != "cell-1" {
		t.Fatalf("labels after a restart: %v %v", labels, err)
	}
	if got, _ := again.NetworkLabels(ctx, "kodus-claim-none"); got != nil {
		t.Fatalf("a network that does not exist has labels %v", got)
	}
	if c, err := again.CreateNetwork(ctx, placement.NetworkSpec{Name: "kodus-claim-c", Key: "claim-a"}); err != nil || c == a || c == b {
		t.Fatalf("a third network after a restart: %s %v", c, err)
	}
}

// Each machine gets a tap of its own on its claim's bridge, owned by its
// VMM's user, with an address in the subnet's upper half, a MAC of its own
// and the claim's resolver once the egress is attached.
func TestEachMachineGetsItsOwnTapAddressAndMAC(t *testing.T) {
	h := newHost()
	p := newPlacement(t, h, t.TempDir())
	ctx := context.Background()
	subnet, _ := p.CreateNetwork(ctx, placement.NetworkSpec{Name: "kodus-claim-a", Key: "a"})
	egress, err := p.AttachEgress(ctx, "kodus-claim-a", "")
	if err != nil || egress != DefaultEgress.String() {
		t.Fatalf("egress %q %v", egress, err)
	}
	one, err := p.AttachTap(ctx, "kodus-claim-a", "m1", 1_000_001)
	if err != nil {
		t.Fatal(err)
	}
	two, err := p.AttachTap(ctx, "kodus-claim-a", "m2", 1_000_002)
	if err != nil {
		t.Fatal(err)
	}
	if one.IP == two.IP || one.MAC == two.MAC || one.Tap == two.Tap {
		t.Fatalf("two machines share: %+v %+v", one, two)
	}
	for _, a := range []Attachment{one, two} {
		if !subnet.Contains(a.IP) || a.IP.As4()[3] < 128 || a.Gateway != subnet.Addr().Next() || a.DNS != DefaultEgress {
			t.Fatalf("attachment %+v on %s", a, subnet)
		}
	}
	if h.links[one.Tap] != "veth" || one.Netns != NetnsPath(NetnsName("m1")) {
		t.Fatalf("no veth to the machine's namespace: %v %+v", h.links, one)
	}
	if err := p.RemoveNetwork(ctx, "kodus-claim-a"); err == nil {
		t.Fatal("a bridge with machines on it was removed")
	}
	for _, m := range []string{"m1", "m2"} {
		if err := p.DetachTap(ctx, "kodus-claim-a", m); err != nil {
			t.Fatal(err)
		}
	}
	if err := p.DetachTap(ctx, "kodus-claim-a", "m1"); err != nil {
		t.Fatalf("detaching twice: %v", err)
	}
	if err := p.RemoveNetwork(ctx, "kodus-claim-a"); err != nil {
		t.Fatal(err)
	}
	if len(h.links) != 1 { // the egress interface stays
		t.Fatalf("left on the host: %v", h.links)
	}
}

// The ruleset lets a claim's machine reach the egress address on its ports
// and nothing else of the host; forwards nothing off the machine's own
// bridge; and fences every tap to its own address and MAC, IPv4 and ARP.
func TestTheRulesetLeavesOnlyTheEgressAndFencesEachTap(t *testing.T) {
	h := newHost()
	p := newPlacement(t, h, t.TempDir())
	ctx := context.Background()
	_, _ = p.CreateNetwork(ctx, placement.NetworkSpec{Name: "kodus-claim-a", Key: "a"})
	_, _ = p.AttachEgress(ctx, "kodus-claim-a", "")
	m, err := p.AttachTap(ctx, "kodus-claim-a", "m1", 1_000_001)
	if err != nil {
		t.Fatal(err)
	}
	rs := h.ruleset
	if rs != p.Ruleset() {
		t.Fatal("the applied ruleset is not the placement's")
	}
	br := ifname(BridgePrefix, "kodus-claim-a")
	want := []string{
		"delete table inet kodus_microvm",
		`iifname "kfb*" jump from_machines`,
		"ip daddr 10.212.255.1 udp dport { 53 } accept",
		"ip daddr 10.212.255.1 tcp dport { 53, 80, 443 } accept",
		`iifname "` + br + `" oifname "` + br + `" accept`,
		`iifname "kfb*" counter drop`,
		`oifname "kfb*" counter drop`,
		`iifname "` + m.Tap + `" ether saddr != ` + m.MAC + ` drop`,
		`iifname "` + m.Tap + `" ether type arp arp saddr ip != ` + m.IP.String() + ` drop`,
		`iifname "` + m.Tap + `" ether type ip ip saddr != ` + m.IP.String() + ` drop`,
		`iifname "` + m.Tap + `" ether type != { ip, arp } drop`,
	}
	for _, w := range want {
		if !strings.Contains(rs, w) {
			t.Errorf("ruleset lacks %q", w)
		}
	}
	// The only accepts from a machine to the host are to the egress.
	_, in, ok := strings.Cut(rs, "chain from_machines")
	if !ok {
		t.Fatal("no from_machines chain")
	}
	in, _, _ = strings.Cut(in, "}")
	for _, line := range strings.Split(in, "\n") {
		if strings.Contains(line, "accept") && !strings.Contains(line, "ip daddr 10.212.255.1 ") {
			t.Errorf("accepts more than the egress: %q", line)
		}
	}
	// Once the machine is gone its tap is no longer named.
	_ = p.DetachTap(ctx, "kodus-claim-a", "m1")
	if strings.Contains(h.ruleset, m.Tap) {
		t.Fatal("a detached tap is still in the ruleset")
	}
}

// On a host whose Docker drops forwarded traffic by policy, the claim
// bridges' own traffic is let through once, however many claims and cell
// restarts; on a host without Docker nothing is added. Two machines of one
// claim used to be cut off from each other once br_netfilter was loaded:
// the ruleset's same-bridge accept does not override Docker's drop.
func TestClaimBridgesAreLetThroughDockersForwardPolicyOnce(t *testing.T) {
	h, dir := newHost(), t.TempDir()
	h.docker = true
	h.dockerUser = []string{"-j RETURN"}
	ctx := context.Background()
	p := newPlacement(t, h, dir)
	for _, n := range []string{"kodus-claim-a", "kodus-claim-b"} {
		if _, err := p.CreateNetwork(ctx, placement.NetworkSpec{Name: n, Key: n}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := newPlacement(t, h, dir).CreateNetwork(ctx, placement.NetworkSpec{Name: "kodus-claim-c", Key: "c"}); err != nil {
		t.Fatal(err)
	}
	want := []string{"-i kfb+ -o kfb+ -j ACCEPT", "-j RETURN"}
	if !slices.Equal(h.dockerUser, want) {
		t.Fatalf("DOCKER-USER %q, want %q", h.dockerUser, want)
	}
	noDocker := newHost()
	if _, err := newPlacement(t, noDocker, t.TempDir()).CreateNetwork(ctx, placement.NetworkSpec{Name: "kodus-claim-a", Key: "a"}); err != nil {
		t.Fatalf("a host without Docker: %v", err)
	}
	if len(noDocker.dockerUser) != 0 {
		t.Fatalf("rules on a host without Docker: %q", noDocker.dockerUser)
	}
}

// A tap is fenced before it exists: when nft refuses the ruleset, no tap is
// made and the machine is refused.
func TestATapIsNotMadeWhenItCannotBeFenced(t *testing.T) {
	h := newHost()
	p := newPlacement(t, h, t.TempDir())
	ctx := context.Background()
	_, _ = p.CreateNetwork(ctx, placement.NetworkSpec{Name: "kodus-claim-a", Key: "a"})
	h.failOn = "nft"
	if _, err := p.AttachTap(ctx, "kodus-claim-a", "m1", 1_000_001); err == nil {
		t.Fatal("a machine was attached without its fence")
	}
	for name, kind := range h.links {
		if kind == "tap" {
			t.Fatalf("tap %s made without its fence", name)
		}
	}
}

// The egress address must be outside the claims' pool: a machine could
// otherwise take it as its own.
func TestTheEgressAddressMustBeOutsideThePool(t *testing.T) {
	_, err := New(context.Background(), Config{StateDir: t.TempDir(), Runner: newHost(), Egress: netip.MustParseAddr("10.213.9.1")})
	if err == nil || !strings.Contains(err.Error(), "outside the pool") {
		t.Fatalf("err %v", err)
	}
}

// A machine restored into its own place keeps its address (and so its MAC):
// its claim's egress policy names it by address. An address another tap
// holds, or one outside the network's machines, is refused.
func TestAMachineRestoredInPlaceKeepsItsAddress(t *testing.T) {
	h := newHost()
	p := newPlacement(t, h, t.TempDir())
	ctx := context.Background()
	_, _ = p.CreateNetwork(ctx, placement.NetworkSpec{Name: "kodus-claim-a", Key: "a"})
	one, _ := p.AttachTap(ctx, "kodus-claim-a", "m1", 1_000_001)
	_, _ = p.AttachTap(ctx, "kodus-claim-a", "m2", 1_000_002)
	_, _ = p.AttachTap(ctx, "kodus-claim-a", "m3", 1_000_003)
	_ = p.DetachTap(ctx, "kodus-claim-a", "m2")
	three := p.Taps("kodus-claim-a")["m3"]
	_ = p.DetachTap(ctx, "kodus-claim-a", "m3")
	again, err := p.AttachTapAt(ctx, "kodus-claim-a", "m3", 1_000_004, three.IP)
	if err != nil || again.IP != three.IP || again.MAC != three.MAC {
		t.Fatalf("m3 came back at %s %s (was %s %s): %v; the next free address would be m2's", again.IP, again.MAC, three.IP, three.MAC, err)
	}
	if _, err := p.AttachTapAt(ctx, "kodus-claim-a", "m4", 1_000_005, one.IP); err == nil {
		t.Fatal("a second tap took m1's address")
	}
	gw := one.Gateway
	if _, err := p.AttachTapAt(ctx, "kodus-claim-a", "m5", 1_000_006, gw); err == nil {
		t.Fatal("a tap took the gateway's address")
	}
}

// The host's machine taps are listed by name (a veth's "@ifN" cut), and a
// cell starting again prunes the claim networks no machine record holds:
// their taps, bridges, state and rules; a network still held keeps all.
func TestACellStartingAgainPrunesTheNetworksNoMachineHolds(t *testing.T) {
	h, dir := newHost(), t.TempDir()
	p := newPlacement(t, h, dir)
	ctx := context.Background()
	for _, n := range []string{"kodus-claim-a", "kodus-claim-b"} {
		if _, err := p.CreateNetwork(ctx, placement.NetworkSpec{Name: n, Key: n}); err != nil {
			t.Fatal(err)
		}
		if _, err := p.AttachTap(ctx, n, n+"-workload", 1); err != nil {
			t.Fatal(err)
		}
	}
	h.links[TapName("kodus-x-workload")] = "veth"
	taps, err := p.HostTaps(ctx)
	slices.Sort(taps)
	want := []string{TapName("kodus-claim-a-workload"), TapName("kodus-claim-b-workload"), TapName("kodus-x-workload")}
	slices.Sort(want)
	if err != nil || !slices.Equal(taps, want) {
		t.Fatalf("host taps %v %v, want %v", taps, err, want)
	}
	again := newPlacement(t, h, dir)
	gone, err := again.PruneNetworks(ctx, func(n string) bool { return n == "kodus-claim-a" })
	if err != nil || !slices.Equal(gone, []string{"kodus-claim-b"}) {
		t.Fatalf("pruned %v %v", gone, err)
	}
	if _, ok := h.links[ifname(BridgePrefix, "kodus-claim-b")]; ok {
		t.Fatal("the pruned network's bridge is still there")
	}
	if _, ok := h.links[TapName("kodus-claim-b-workload")]; ok {
		t.Fatal("the pruned network's tap is still there")
	}
	if strings.Contains(h.ruleset, ifname(BridgePrefix, "kodus-claim-b")) || !strings.Contains(h.ruleset, ifname(BridgePrefix, "kodus-claim-a")) {
		t.Fatalf("ruleset after the prune:\n%s", h.ruleset)
	}
	if l, _ := newPlacement(t, h, dir).NetworkLabels(ctx, "kodus-claim-b"); l != nil {
		t.Fatal("the pruned network comes back after a restart")
	}
	if err := again.RemoveTap(ctx, TapName("kodus-x-workload")); err != nil {
		t.Fatal(err)
	}
	if _, ok := h.links[TapName("kodus-x-workload")]; ok {
		t.Fatal("RemoveTap left the tap")
	}
}

// A machine's tap is in a network namespace of its own, where its VMM runs
// (the jailer's --netns), bridged to a veth whose host end carries the
// tap's name on the claim's bridge: the fence that names the tap holds,
// and a VMM escape finds only the machine's own interface. Detaching
// removes both the host end and the namespace.
func TestAMachinesTapIsInItsOwnNetworkNamespace(t *testing.T) {
	h := newHost()
	p := newPlacement(t, h, t.TempDir())
	ctx := context.Background()
	if _, err := p.CreateNetwork(ctx, placement.NetworkSpec{Name: "kodus-claim-a", Key: "a"}); err != nil {
		t.Fatal(err)
	}
	a, err := p.AttachTap(ctx, "kodus-claim-a", "m1", 4242)
	if err != nil {
		t.Fatal(err)
	}
	ns := NetnsName("m1")
	if a.Netns != "/run/netns/"+ns || a.Tap != TapName("m1") {
		t.Fatalf("attachment %+v", a)
	}
	for _, want := range []string{
		"ip netns add " + ns,
		"ip link add " + a.Tap + " type veth peer name veth0 netns " + ns,
		"ip -n " + ns + " tuntap add dev " + a.Tap + " mode tap user 4242 group 4242",
		"ip -n " + ns + " link set dev " + a.Tap + " master br0",
		"ip link set dev " + a.Tap + " master " + ifname(BridgePrefix, "kodus-claim-a"),
	} {
		if !slices.Contains(h.cmds, want) {
			t.Errorf("no %q in %v", want, h.cmds)
		}
	}
	if !strings.Contains(h.ruleset, a.Tap) {
		t.Fatal("the fence does not name the machine's host link")
	}
	if err := p.DetachTap(ctx, "kodus-claim-a", "m1"); err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(h.cmds, "ip netns del "+ns) {
		t.Fatalf("the namespace stays: %v", h.cmds)
	}
}
