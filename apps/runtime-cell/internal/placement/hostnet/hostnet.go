// Package hostnet is the host-network Placement for microVMs
// (docs/runtime/isolation-architecture.md C3): a claim's network is a Linux
// bridge on the host in a /24 of the cell's pool, each machine joins it
// through a tap device of its own, and the host's nftables (rules.go) leave
// the cell's egress address as the only thing a machine reaches.
//
// The egress (cmd/egress: proxy and resolver) listens on one address of the
// host, on a dummy interface the placement keeps up, and machines reach it
// through their bridge's gateway: there is no route out and no NAT.
//
// What the kernel cannot label (a bridge, a tap) is kept in a state file per
// network under the placement's directory, read back on start.
package hostnet

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash/fnv"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/placement"
)

// Name is the placement's name.
const Name = "hostnet"

// DefaultPool is where claim bridges take their /24.
var DefaultPool = netip.MustParsePrefix("10.213.0.0/16")

// DefaultEgress is the egress address when the cell names none: outside
// the default pool.
var DefaultEgress = netip.MustParseAddr("10.212.255.1")

// Runner runs a host command (ip, nft) with stdin; the output is returned
// for errors.
type Runner interface {
	Run(ctx context.Context, stdin []byte, name string, args ...string) ([]byte, error)
}

// Exec runs commands on the host.
type Exec struct{}

func (Exec) Run(ctx context.Context, stdin []byte, name string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, name, args...) //nolint:gosec // G204: the placement's own fixed commands, with names it made
	if stdin != nil {
		cmd.Stdin = strings.NewReader(string(stdin))
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		return out, fmt.Errorf("hostnet: %s %s: %w: %s", name, strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return out, nil
}

// Config is the placement's.
type Config struct {
	// StateDir keeps one file per claim network.
	StateDir string
	// Pool is where networks take their /24 (DefaultPool when invalid).
	Pool netip.Prefix
	// Egress is the egress's address on the host (DefaultEgress when
	// invalid); EgressInterface the dummy interface that carries it
	// ("kodus-egress" when empty).
	Egress          netip.Addr
	EgressInterface string
	// TCPPorts and UDPPorts are the egress's ports a machine may reach:
	// the resolver (53) and the proxy (80, 443) when empty.
	TCPPorts, UDPPorts []uint16
	// Table is the nftables table name ("kodus_microvm" when empty).
	Table  string
	Runner Runner
}

// Tap is one machine's tap on its claim's bridge.
type Tap struct {
	Name    string     `json:"name"`
	Machine string     `json:"machine"`
	IP      netip.Addr `json:"ip"`
	MAC     string     `json:"mac"`
	UID     int        `json:"uid"`
	// Netns is the machine's own network namespace, where its VMM runs and
	// its tap is (empty: a tap of a cell from before, on the host).
	Netns string `json:"netns,omitempty"`
}

// Network is one claim network as the state file keeps it.
type Network struct {
	Name    string            `json:"name"`
	Bridge  string            `json:"bridge"`
	Subnet  netip.Prefix      `json:"subnet"`
	Labels  map[string]string `json:"labels"`
	Taps    map[string]Tap    `json:"taps"`
	Egress  bool              `json:"egress"`
	Gateway netip.Addr        `json:"gateway"`
}

// Attachment is what a machine's VM is given: its tap and its address.
type Attachment struct {
	Tap     string
	MAC     string
	IP      netip.Addr
	Gateway netip.Addr
	Prefix  int
	// DNS is the claim's resolver (the egress), invalid with no egress.
	DNS netip.Addr
	// Netns is the path of the machine's network namespace, which its VMM
	// joins (the jailer's --netns) and where Tap is.
	Netns string
}

// Placement is the host network.
type Placement struct {
	cfg  Config
	mu   sync.Mutex
	nets map[string]*Network
}

var _ placement.Placement = (*Placement)(nil)

// New reads the state, keeps the egress interface up and applies the
// ruleset for what is there, so a restarted cell is fenced at once.
func New(ctx context.Context, cfg Config) (*Placement, error) {
	if !cfg.Pool.IsValid() {
		cfg.Pool = DefaultPool
	}
	if !cfg.Pool.Addr().Is4() || cfg.Pool.Bits() > 24 {
		return nil, fmt.Errorf("hostnet: pool %s is not an IPv4 pool of a /24 or wider", cfg.Pool)
	}
	if !cfg.Egress.IsValid() {
		cfg.Egress = DefaultEgress
	}
	if !cfg.Egress.Is4() || cfg.Pool.Contains(cfg.Egress) {
		return nil, fmt.Errorf("hostnet: egress address %s must be IPv4 and outside the pool %s", cfg.Egress, cfg.Pool)
	}
	if cfg.EgressInterface == "" {
		cfg.EgressInterface = "kodus-egress"
	}
	if len(cfg.TCPPorts) == 0 {
		cfg.TCPPorts = []uint16{53, 80, 443}
	}
	if len(cfg.UDPPorts) == 0 {
		cfg.UDPPorts = []uint16{53}
	}
	if cfg.Table == "" {
		cfg.Table = "kodus_microvm"
	}
	if cfg.Runner == nil {
		cfg.Runner = Exec{}
	}
	if cfg.StateDir == "" {
		return nil, errors.New("hostnet: a state directory is required")
	}
	if err := os.MkdirAll(cfg.StateDir, 0o700); err != nil {
		return nil, err
	}
	p := &Placement{cfg: cfg, nets: map[string]*Network{}}
	entries, err := os.ReadDir(cfg.StateDir)
	if err != nil {
		return nil, err
	}
	for _, e := range entries {
		if !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(cfg.StateDir, e.Name()))
		if err != nil {
			return nil, err
		}
		var n Network
		if err := json.Unmarshal(raw, &n); err != nil {
			return nil, fmt.Errorf("hostnet: state %s: %w", e.Name(), err)
		}
		p.nets[n.Name] = &n
	}
	if err := p.ensureEgress(ctx); err != nil {
		return nil, err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := p.applyLocked(ctx); err != nil {
		return nil, err
	}
	return p, nil
}

func (p *Placement) run(ctx context.Context, name string, args ...string) error {
	_, err := p.cfg.Runner.Run(ctx, nil, name, args...)
	return err
}

func (p *Placement) ensureEgress(ctx context.Context) error {
	ifc := p.cfg.EgressInterface
	if _, err := p.cfg.Runner.Run(ctx, nil, "ip", "link", "show", "dev", ifc); err != nil {
		if err := p.run(ctx, "ip", "link", "add", "name", ifc, "type", "dummy"); err != nil {
			return err
		}
	}
	if err := p.run(ctx, "ip", "addr", "replace", p.cfg.Egress.String()+"/32", "dev", ifc); err != nil {
		return err
	}
	return p.run(ctx, "ip", "link", "set", "dev", ifc, "up")
}

// Egress is the address the cell's egress listens on.
func (p *Placement) Egress() netip.Addr { return p.cfg.Egress }

func (p *Placement) Name() string { return Name }

// ifname is a short stable interface name for key (IFNAMSIZ is 16).
func ifname(prefix, key string) string {
	s := sha256.Sum256([]byte(key))
	return prefix + hex.EncodeToString(s[:5])
}

func (p *Placement) statePath(network string) string {
	return filepath.Join(p.cfg.StateDir, ifname("n", network)+".json")
}

func (p *Placement) saveLocked(n *Network) error {
	raw, err := json.Marshal(n)
	if err != nil {
		return err
	}
	tmp := p.statePath(n.Name) + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, p.statePath(n.Name))
}

func (p *Placement) rulesLocked() Rules {
	r := Rules{Table: p.cfg.Table, TCPPorts: p.cfg.TCPPorts, UDPPorts: p.cfg.UDPPorts}
	r.Egress = p.cfg.Egress
	for _, n := range p.nets {
		r.Networks = append(r.Networks, *n)
	}
	return r
}

func (p *Placement) applyLocked(ctx context.Context) error {
	_, err := p.cfg.Runner.Run(ctx, []byte(p.rulesLocked().Ruleset()), "nft", "-f", "-")
	return err
}

// Ruleset is the nft script the placement applies for what it holds now.
func (p *Placement) Ruleset() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.rulesLocked().Ruleset()
}

// slot is the n-th /24 of the pool.
func slot(pool netip.Prefix, n uint32) netip.Prefix {
	b := pool.Masked().Addr().As4()
	var base [4]byte
	binary.BigEndian.PutUint32(base[:], binary.BigEndian.Uint32(b[:])&^0xff+n<<8)
	return netip.PrefixFrom(netip.AddrFrom4(base), 24)
}

// dockerForward lets the claim bridges' own traffic through Docker's
// FORWARD chain. Once br_netfilter is loaded (Docker loads it when a network
// needs it), a frame between two machines of one claim also crosses the
// host's IPv4 forward hook, where Docker's filter table drops it by policy;
// the ruleset's same-bridge accept cannot help, since an accept in one
// nftables base chain does not override a drop in another. The rule names
// every claim bridge in and out, but frames between two bridges never reach
// it: the ruleset's forward chain runs first (priority filter - 10) and
// drops them.
var dockerForward = []string{"DOCKER-USER", "-i", BridgePrefix + "+", "-o", BridgePrefix + "+", "-j", "ACCEPT"}

// ensureDockerForward puts dockerForward first in DOCKER-USER when the host
// has that chain and the rule is not there yet. A host without Docker's
// chain (no Docker, or no iptables) has no such drop, and nothing is added.
// The rule stays when the cell stops, like the egress interface.
func (p *Placement) ensureDockerForward(ctx context.Context) error {
	ok := func(args ...string) bool {
		_, err := p.cfg.Runner.Run(ctx, nil, "iptables", append([]string{"-w", "5"}, args...)...)
		return err == nil
	}
	if !ok("-S", "DOCKER-USER") || ok(append([]string{"-C"}, dockerForward...)...) {
		return nil
	}
	if err := p.run(ctx, "iptables", append([]string{"-w", "5", "-I"}, dockerForward...)...); err != nil {
		return fmt.Errorf("hostnet: let claim bridges through DOCKER-USER: %w", err)
	}
	return nil
}

// CreateNetwork makes the claim's bridge in a free /24 of the pool, the
// first one from where the key points; its gateway is the subnet's .1.
func (p *Placement) CreateNetwork(ctx context.Context, spec placement.NetworkSpec) (netip.Prefix, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if n, ok := p.nets[spec.Name]; ok {
		return netip.Prefix{}, fmt.Errorf("hostnet: network %s exists (%s)", spec.Name, n.Subnet)
	}
	// Checked on every network, not once: Docker may start after the cell.
	if err := p.ensureDockerForward(ctx); err != nil {
		return netip.Prefix{}, err
	}
	used := map[netip.Prefix]bool{}
	for _, n := range p.nets {
		used[n.Subnet] = true
	}
	slots := uint32(1) << (24 - p.cfg.Pool.Bits())
	h := fnv.New32a()
	_, _ = h.Write([]byte(spec.Key))
	start := h.Sum32() % slots
	var subnet netip.Prefix
	for i := range slots {
		s := slot(p.cfg.Pool, (start+i)%slots)
		if !used[s] {
			subnet = s
			break
		}
	}
	if !subnet.IsValid() {
		return netip.Prefix{}, fmt.Errorf("hostnet: no free /24 in %s", p.cfg.Pool)
	}
	gw := subnet.Addr().Next()
	n := &Network{Name: spec.Name, Bridge: ifname(BridgePrefix, spec.Name), Subnet: subnet, Labels: spec.Labels, Taps: map[string]Tap{}, Gateway: gw}
	steps := [][]string{
		{"ip", "link", "add", "name", n.Bridge, "type", "bridge"},
		{"ip", "addr", "add", netip.PrefixFrom(gw, 24).String(), "dev", n.Bridge},
		{"sysctl", "-q", "-w", "net.ipv6.conf." + n.Bridge + ".disable_ipv6=1"},
		{"ip", "link", "set", "dev", n.Bridge, "up"},
	}
	for _, s := range steps {
		if err := p.run(ctx, s[0], s[1:]...); err != nil {
			_ = p.run(context.WithoutCancel(ctx), "ip", "link", "del", "dev", n.Bridge)
			return netip.Prefix{}, err
		}
	}
	p.nets[n.Name] = n
	if err := p.saveLocked(n); err != nil {
		return netip.Prefix{}, err
	}
	if err := p.applyLocked(ctx); err != nil {
		return netip.Prefix{}, err
	}
	return subnet, nil
}

// AttachEgress lets the network's machines reach the egress (the ruleset
// already does; this records it) and returns the egress address, the
// claim's resolver and the address the resolver steers allowed names to.
func (p *Placement) AttachEgress(_ context.Context, network, _ string) (string, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	n, ok := p.nets[network]
	if !ok {
		return "", fmt.Errorf("hostnet: no network %s", network)
	}
	n.Egress = true
	if err := p.saveLocked(n); err != nil {
		return "", err
	}
	return p.cfg.Egress.String(), nil
}

// DetachEgress records that the network no longer has a way out; the
// ruleset stays (it fences every bridge alike).
func (p *Placement) DetachEgress(_ context.Context, network, _ string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	n, ok := p.nets[network]
	if !ok {
		return nil
	}
	n.Egress = false
	return p.saveLocked(n)
}

// RemoveNetwork removes a bridge no machine is attached to.
func (p *Placement) RemoveNetwork(ctx context.Context, network string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	n, ok := p.nets[network]
	if !ok {
		return nil
	}
	if len(n.Taps) > 0 {
		return fmt.Errorf("hostnet: network %s still has %d machines", network, len(n.Taps))
	}
	if out, err := p.cfg.Runner.Run(ctx, nil, "ip", "link", "del", "dev", n.Bridge); err != nil && !strings.Contains(string(out), "Cannot find device") {
		return err
	}
	delete(p.nets, network)
	if err := os.Remove(p.statePath(network)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return p.applyLocked(ctx)
}

// NetworkLabels are the network's labels; nil when it does not exist.
func (p *Placement) NetworkLabels(_ context.Context, network string) (map[string]string, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	n, ok := p.nets[network]
	if !ok {
		return nil, nil //nolint:nilnil // placement.Placement: no labels is no network, as on the docker placement
	}
	out := make(map[string]string, len(n.Labels))
	for k, v := range n.Labels {
		out[k] = v
	}
	return out, nil
}

// macOf is a locally administered MAC carrying the address (06:00:a.b.c.d).
func macOf(ip netip.Addr) string {
	b := ip.As4()
	return fmt.Sprintf("06:00:%02x:%02x:%02x:%02x", b[0], b[1], b[2], b[3])
}

// AttachTap makes machine's tap on network's bridge, owned by uid (the
// jailed VMM's user), with the first free address of the subnet's upper
// half, and fences it to that address and its MAC.
func (p *Placement) AttachTap(ctx context.Context, network, machine string, uid int) (Attachment, error) {
	return p.AttachTapAt(ctx, network, machine, uid, netip.Addr{})
}

// AttachTapAt is AttachTap at the address want when it is valid: a machine
// restored into its own place keeps its address, so its claim's egress
// policy (keyed by source address) and its peers still name it. want must be
// a machine address of the network (.128 to .254) that no tap holds.
func (p *Placement) AttachTapAt(ctx context.Context, network, machine string, uid int, want netip.Addr) (Attachment, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	n, ok := p.nets[network]
	if !ok {
		return Attachment{}, fmt.Errorf("hostnet: no network %s", network)
	}
	if _, ok := n.Taps[machine]; ok {
		return Attachment{}, fmt.Errorf("hostnet: %s already has a tap on %s", machine, network)
	}
	taken := map[netip.Addr]bool{}
	for _, t := range n.Taps {
		taken[t.IP] = true
	}
	var ip netip.Addr
	b := n.Subnet.Addr().As4()
	if want.IsValid() {
		if !want.Is4() || !n.Subnet.Contains(want) || want.As4()[3] < 128 || want.As4()[3] == 255 || taken[want] {
			return Attachment{}, fmt.Errorf("hostnet: %s is not a free machine address of %s", want, network)
		}
	}
	for host := 128; host < 255 && !want.IsValid(); host++ {
		b[3] = byte(host)
		if a := netip.AddrFrom4(b); !taken[a] {
			ip = a
			break
		}
	}
	if want.IsValid() {
		ip = want
	}
	if !ip.IsValid() {
		return Attachment{}, fmt.Errorf("hostnet: network %s has no free address", network)
	}
	t := Tap{Name: ifname(TapPrefix, machine), Machine: machine, IP: ip, MAC: macOf(ip), UID: uid, Netns: NetnsName(machine)}
	steps := machineLinkSteps(t, n.Bridge)
	// Fence first: the rules name the tap before it can carry a frame.
	n.Taps[machine] = t
	if err := p.applyLocked(ctx); err != nil {
		delete(n.Taps, machine)
		return Attachment{}, err
	}
	for _, s := range steps {
		if err := p.run(ctx, s[0], s[1:]...); err != nil {
			_ = removeMachineLinks(context.WithoutCancel(ctx), p.cfg.Runner, t)
			delete(n.Taps, machine)
			_ = p.applyLocked(context.WithoutCancel(ctx))
			return Attachment{}, err
		}
	}
	if err := p.saveLocked(n); err != nil {
		return Attachment{}, err
	}
	a := Attachment{Tap: t.Name, MAC: t.MAC, IP: ip, Gateway: n.Gateway, Prefix: 24, Netns: NetnsPath(t.Netns)}
	if n.Egress {
		a.DNS = p.cfg.Egress
	}
	return a, nil
}

// DetachTap removes machine's tap from network; a tap already gone is fine.
func (p *Placement) DetachTap(ctx context.Context, network, machine string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	n, ok := p.nets[network]
	if !ok {
		return nil
	}
	t, ok := n.Taps[machine]
	if !ok {
		return nil
	}
	if err := removeMachineLinks(ctx, p.cfg.Runner, t); err != nil {
		return err
	}
	delete(n.Taps, machine)
	if err := p.saveLocked(n); err != nil {
		return err
	}
	return p.applyLocked(ctx)
}

// Taps are the taps on network, by machine.
func (p *Placement) Taps(network string) map[string]Tap {
	p.mu.Lock()
	defer p.mu.Unlock()
	n, ok := p.nets[network]
	if !ok {
		return nil
	}
	out := make(map[string]Tap, len(n.Taps))
	for k, v := range n.Taps {
		out[k] = v
	}
	return out
}

// Prerequisites names what the host lacks for this placement: the ip and
// nft commands and the tun device.
func Prerequisites(lookPath func(string) (string, error), stat func(string) (os.FileInfo, error)) []string {
	var missing []string
	for _, bin := range [][2]string{{"ip", "iproute2"}, {"nft", "nftables"}, {"sysctl", "procps"}} {
		if _, err := lookPath(bin[0]); err != nil {
			missing = append(missing, "the "+bin[0]+" command ("+bin[1]+")")
		}
	}
	if fi, err := stat("/dev/net/tun"); err != nil || fi.Mode()&os.ModeCharDevice == 0 {
		missing = append(missing, "/dev/net/tun")
	}
	return missing
}
