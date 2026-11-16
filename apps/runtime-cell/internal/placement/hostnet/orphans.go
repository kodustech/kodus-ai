package hostnet

import (
	"context"
	"errors"
	"fmt"
	"net/netip"
	"os"
	"strconv"
	"strings"
)

// What is left on the host by a cell that did not end cleanly: taps whose
// machine has no record, and claim networks whose machines are all gone.
// The out-of-process reaper removes taps by name (TapRemover) and never
// rewrites the nft table, which only the cell's placement writes; the cell
// prunes its networks (and with them their rules) at start, before it
// serves anything (PruneNetworks).

// TapName is the tap a machine of this name gets (AttachTapAt). In the
// machine's network namespace it is the tap its VMM opens; on the host, the
// end of the veth pair to it on the claim's bridge, so every rule that
// names a machine's tap holds as before.
func TapName(machine string) string { return ifname(TapPrefix, machine) }

// NetnsPrefix names the machines' network namespaces.
const NetnsPrefix = "kfn"

// NetnsName is the network namespace a machine of this name gets.
func NetnsName(machine string) string { return ifname(NetnsPrefix, machine) }

// NetnsPath is where ip netns keeps a namespace's handle.
func NetnsPath(name string) string { return "/run/netns/" + name }

// machineLinkSteps make a machine's own network namespace with its tap in
// it, bridged to a veth whose host end (the tap's name) joins the claim's
// bridge: the VMM joins that namespace (the jailer's --netns), so a VMM
// escape lands where the only interface is the machine's own, not in the
// host's namespace with every interface and route of the host.
func machineLinkSteps(t Tap, bridge string) [][]string {
	ns := t.Netns
	in := func(args ...string) []string { return append([]string{"ip", "-n", ns}, args...) }
	return [][]string{
		{"ip", "netns", "add", ns},
		{"ip", "netns", "exec", ns, "sysctl", "-q", "-w", "net.ipv6.conf.all.disable_ipv6=1"},
		{"ip", "netns", "exec", ns, "sysctl", "-q", "-w", "net.ipv6.conf.default.disable_ipv6=1"},
		{"ip", "link", "add", t.Name, "type", "veth", "peer", "name", "veth0", "netns", ns},
		in("link", "add", "br0", "type", "bridge"),
		in("link", "set", "dev", "veth0", "master", "br0"),
		in("tuntap", "add", "dev", t.Name, "mode", "tap", "user", strconv.Itoa(t.UID), "group", strconv.Itoa(t.UID)),
		in("link", "set", "dev", t.Name, "master", "br0"),
		in("link", "set", "dev", "lo", "up"),
		in("link", "set", "dev", "veth0", "up"),
		in("link", "set", "dev", "br0", "up"),
		in("link", "set", "dev", t.Name, "up"),
		{"sysctl", "-q", "-w", "net.ipv6.conf." + t.Name + ".disable_ipv6=1"},
		{"ip", "link", "set", "dev", t.Name, "master", bridge},
		{"ip", "link", "set", "dev", t.Name, "up"},
	}
}

// removeMachineLinks removes a machine's host link and its namespace (with
// the tap and bridge in it); either already gone is fine.
func removeMachineLinks(ctx context.Context, r Runner, t Tap) error {
	if err := removeLink(ctx, r, t.Name); err != nil {
		return err
	}
	if t.Netns == "" {
		return nil
	}
	return removeNetns(ctx, r, t.Netns)
}

func removeNetns(ctx context.Context, r Runner, name string) error {
	if out, err := r.Run(ctx, nil, "ip", "netns", "del", name); err != nil && !strings.Contains(string(out), "No such file") {
		return fmt.Errorf("hostnet: remove namespace %s: %w: %s", name, err, strings.TrimSpace(string(out)))
	}
	return nil
}

// HostNetns are the host's machine network namespaces.
func HostNetns(ctx context.Context, r Runner) ([]string, error) {
	out, err := r.Run(ctx, nil, "ip", "netns", "list")
	if err != nil {
		return nil, fmt.Errorf("hostnet: list namespaces: %w: %s", err, strings.TrimSpace(string(out)))
	}
	var names []string
	for _, l := range strings.Split(string(out), "\n") {
		// "kfn0a1b2c3d4e (id: 3)"
		if f := strings.Fields(l); len(f) > 0 && strings.HasPrefix(f[0], NetnsPrefix) {
			names = append(names, f[0])
		}
	}
	return names, nil
}

// HostTaps are the host's interfaces named like a machine's tap.
func HostTaps(ctx context.Context, r Runner) ([]string, error) {
	out, err := r.Run(ctx, nil, "ip", "-o", "link", "show")
	if err != nil {
		return nil, fmt.Errorf("hostnet: list links: %w: %s", err, strings.TrimSpace(string(out)))
	}
	var taps []string
	for _, l := range strings.Split(string(out), "\n") {
		// "12: kft0a1b2c3d4e@if3: <BROADCAST,...>": the name is the second field.
		f := strings.Fields(l)
		if len(f) < 2 {
			continue
		}
		name, _, _ := strings.Cut(strings.TrimSuffix(f[1], ":"), "@")
		if strings.HasPrefix(name, TapPrefix) {
			taps = append(taps, name)
		}
	}
	return taps, nil
}

// removeLink deletes a link; one already gone is fine.
func removeLink(ctx context.Context, r Runner, name string) error {
	if out, err := r.Run(ctx, nil, "ip", "link", "del", "dev", name); err != nil && !strings.Contains(string(out), "Cannot find device") {
		return fmt.Errorf("hostnet: remove %s: %w: %s", name, err, strings.TrimSpace(string(out)))
	}
	return nil
}

// TapRemover is the reaper's network side of a microVM backend: it removes
// a machine's tap device by name and holds no state, so it never races the
// cell's placement over the nft table (the rule naming a tap that is gone
// matches nothing until the cell prunes it).
type TapRemover struct{ Runner Runner }

func (t TapRemover) runner() Runner {
	if t.Runner == nil {
		return Exec{}
	}
	return t.Runner
}

// AttachTapAt is refused: the reaper makes nothing.
func (TapRemover) AttachTapAt(context.Context, string, string, int, netip.Addr) (Attachment, error) {
	return Attachment{}, errors.New("hostnet: the reaper attaches no tap")
}

// DetachTap removes the machine's host link and its network namespace.
func (t TapRemover) DetachTap(ctx context.Context, _, machine string) error {
	return removeMachineLinks(ctx, t.runner(), Tap{Name: TapName(machine), Netns: NetnsName(machine)})
}

// HostNetns are the host's machine network namespaces.
func (t TapRemover) HostNetns(ctx context.Context) ([]string, error) {
	return HostNetns(ctx, t.runner())
}

// RemoveNetns removes a machine's network namespace by its name.
func (t TapRemover) RemoveNetns(ctx context.Context, name string) error {
	return removeNetns(ctx, t.runner(), name)
}

// NetnsOf is the network namespace a machine of this name has.
func (TapRemover) NetnsOf(machine string) string { return NetnsName(machine) }

// HostTaps are the host's machine taps.
func (t TapRemover) HostTaps(ctx context.Context) ([]string, error) { return HostTaps(ctx, t.runner()) }

// RemoveTap removes a tap device by its name.
func (t TapRemover) RemoveTap(ctx context.Context, name string) error {
	return removeLink(ctx, t.runner(), name)
}

// TapOf is the tap a machine of this name has.
func (TapRemover) TapOf(machine string) string { return TapName(machine) }

// HostTaps are the host's machine taps.
func (p *Placement) HostTaps(ctx context.Context) ([]string, error) {
	return HostTaps(ctx, p.cfg.Runner)
}

// RemoveTap removes a tap device by its name, and the placement's record of
// it when it holds one.
func (p *Placement) RemoveTap(ctx context.Context, name string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, n := range p.nets {
		for m, t := range n.Taps {
			if t.Name == name {
				if err := removeMachineLinks(ctx, p.cfg.Runner, t); err != nil {
					return err
				}
				delete(n.Taps, m)
				if err := p.saveLocked(n); err != nil {
					return err
				}
				return p.applyLocked(ctx)
			}
		}
	}
	return removeLink(ctx, p.cfg.Runner, name)
}

// TapOf is the tap a machine of this name has.
func (*Placement) TapOf(machine string) string { return TapName(machine) }

// HostNetns are the host's machine network namespaces.
func (p *Placement) HostNetns(ctx context.Context) ([]string, error) {
	return HostNetns(ctx, p.cfg.Runner)
}

// RemoveNetns removes a machine's network namespace by its name.
func (p *Placement) RemoveNetns(ctx context.Context, name string) error {
	return removeNetns(ctx, p.cfg.Runner, name)
}

// NetnsOf is the network namespace a machine of this name has.
func (*Placement) NetnsOf(machine string) string { return NetnsName(machine) }

// PruneNetworks removes every claim network keep does not name: its taps,
// its bridge, its state and, in one new ruleset, its rules. The cell runs
// it at start, before it serves anything, with keep naming the networks a
// machine record still holds: a claim network outlives its machines only
// when the cell ended between the two.
func (p *Placement) PruneNetworks(ctx context.Context, keep func(network string) bool) ([]string, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	var gone []string
	var errs []error
	for name, n := range p.nets {
		if keep(name) {
			continue
		}
		var failed bool
		for _, t := range n.Taps {
			if err := removeMachineLinks(ctx, p.cfg.Runner, t); err != nil {
				errs, failed = append(errs, err), true
			}
		}
		if err := removeLink(ctx, p.cfg.Runner, n.Bridge); err != nil {
			errs, failed = append(errs, err), true
		}
		if failed {
			continue
		}
		delete(p.nets, name)
		if err := os.Remove(p.statePath(name)); err != nil && !errors.Is(err, os.ErrNotExist) {
			errs = append(errs, err)
		}
		gone = append(gone, name)
	}
	if len(gone) > 0 {
		if err := p.applyLocked(ctx); err != nil {
			errs = append(errs, err)
		}
	}
	return gone, errors.Join(errs...)
}
