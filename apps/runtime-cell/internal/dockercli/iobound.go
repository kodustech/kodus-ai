package dockercli

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// IOBound is a container's share of the host's disk and network
// (driver.IOLimits for docker-gvisor): Docker's blkio limits on the disk
// its writes reach (the cgroup's io.max), and the token bucket filters the
// cell puts on its host-side veth (ShapeNetwork). Zero is no limit.
type IOBound struct {
	// Device is the whole disk Docker's data root is on ("/dev/nvme0n1"):
	// what a gVisor container writes outside its memory reaches it through
	// its gofer, in the container's cgroup.
	Device              string
	ReadBps, WriteBps   int64
	ReadIOPS, WriteIOPS int64
	// NetBps is the network bandwidth each way, bytes per second.
	NetBps int64
}

var (
	devicePath = regexp.MustCompile(`^/dev/[a-z0-9][a-z0-9_-]*$`)
	// peerIndex is a veth's peer index in `ip -o link` ("2: eth0@if151:").
	peerIndex = regexp.MustCompile(`(?m)^\d+: eth\d+@if(\d+):`)
)

// args are the docker run flags of the disk part.
func (b *IOBound) args() ([]string, error) {
	if b == nil || b.Device == "" {
		return nil, nil
	}
	if !devicePath.MatchString(b.Device) {
		return nil, fmt.Errorf("dockercli: %q is not a block device path", b.Device)
	}
	var out []string
	for _, f := range []struct {
		flag string
		n    int64
	}{{"--device-read-bps", b.ReadBps}, {"--device-write-bps", b.WriteBps}, {"--device-read-iops", b.ReadIOPS}, {"--device-write-iops", b.WriteIOPS}} {
		if f.n > 0 {
			out = append(out, f.flag, b.Device+":"+strconv.FormatInt(f.n, 10))
		}
	}
	return out, nil
}

// DataRootDisk is the whole disk ("/dev/<name>") dir's file system is on,
// a partition naming its disk; "" when it is on none (tmpfs, overlay).
func DataRootDisk(dir string) string {
	raw, err := os.ReadFile("/proc/self/mountinfo")
	if err != nil {
		return ""
	}
	// The longest mount point under which dir is: its major:minor (field 3).
	best, dev := "", ""
	for _, l := range strings.Split(string(raw), "\n") {
		f := strings.Fields(l)
		if len(f) < 5 {
			continue
		}
		mp := f[4]
		if (dir == mp || strings.HasPrefix(dir, strings.TrimSuffix(mp, "/")+"/")) && len(mp) >= len(best) {
			best, dev = mp, f[2]
		}
	}
	if dev == "" {
		return ""
	}
	sys := "/sys/dev/block/" + dev
	if _, err := os.Stat(sys + "/partition"); err == nil { //nolint:gosec // G703: sysfs, the major:minor mountinfo names
		sys += "/.."
	} else if _, err := os.Stat(sys); err != nil { //nolint:gosec // G703: sysfs, the major:minor mountinfo names
		return ""
	}
	link, err := filepath.EvalSymlinks(sys)
	if err != nil {
		return ""
	}
	return "/dev/" + filepath.Base(link)
}

// HostVeths are the host-side ends of the container's interfaces: each
// interface of its network namespace (Docker's sandbox key) names its
// peer's index (iflink).
func (c CLI) HostVeths(ctx context.Context, container string) ([]string, error) {
	out, err := c.run(ctx, nil, "inspect", "--type", "container", "--format", "{{.NetworkSettings.SandboxKey}}", container)
	if err != nil {
		return nil, err
	}
	key := strings.TrimSpace(string(out))
	if !strings.HasPrefix(key, "/var/run/docker/netns/") && !strings.HasPrefix(key, "/run/docker/netns/") {
		return nil, fmt.Errorf("dockercli: %s has no network namespace (%q)", container, key)
	}
	// Netlink in the namespace (its /sys would still be the host's): each
	// "N: eth0@ifM:" names its peer's index M.
	raw, err := exec.CommandContext(ctx, "nsenter", "--net="+key, "ip", "-o", "link", "show").Output() //nolint:gosec // G204: the container's own namespace path, fixed arguments
	if err != nil {
		return nil, fmt.Errorf("dockercli: the interfaces of %s: %w", container, err)
	}
	var peers []string
	for _, m := range peerIndex.FindAllStringSubmatch(string(raw), -1) {
		peers = append(peers, m[1])
	}
	byIndex := map[string]string{}
	ents, _ := os.ReadDir("/sys/class/net")
	for _, e := range ents {
		if idx, err := os.ReadFile("/sys/class/net/" + e.Name() + "/ifindex"); err == nil {
			byIndex[strings.TrimSpace(string(idx))] = e.Name()
		}
	}
	var veths []string
	for _, idx := range peers {
		name, ok := byIndex[idx]
		if !ok {
			return nil, fmt.Errorf("dockercli: no host link of index %s for %s", idx, container)
		}
		veths = append(veths, name)
	}
	if len(veths) == 0 {
		return nil, errors.New("dockercli: the container has no interface")
	}
	return veths, nil
}

// shapeCommands bound a host veth both ways at bps: toward the container
// with a token bucket filter on the veth's egress, from it with a policer
// on its ingress.
func shapeCommands(veth string, bps int64) [][]string {
	rate := strconv.FormatInt(bps*8, 10) + "bit"
	// A burst of 10 ms at the rate, at least 64 KiB (tbf needs a burst over
	// one MTU per timer tick).
	burst := strconv.FormatInt(max(bps/100, 64<<10), 10)
	return [][]string{
		{"tc", "qdisc", "replace", "dev", veth, "root", "tbf", "rate", rate, "burst", burst, "latency", "50ms"},
		{"tc", "qdisc", "replace", "dev", veth, "handle", "ffff:", "ingress"},
		{"tc", "filter", "replace", "dev", veth, "parent", "ffff:", "prio", "1", "matchall", "action", "police", "rate", rate, "burst", burst, "conform-exceed", "drop"},
	}
}

// ShapeNetwork bounds the container's network to bps each way on every
// host-side veth it has.
func (c CLI) ShapeNetwork(ctx context.Context, container string, bps int64) error {
	if bps <= 0 {
		return nil
	}
	veths, err := c.HostVeths(ctx, container)
	if err != nil {
		return err
	}
	for _, v := range veths {
		for _, cmd := range shapeCommands(v, bps) {
			if out, err := exec.CommandContext(ctx, cmd[0], cmd[1:]...).CombinedOutput(); err != nil { //nolint:gosec // G204: tc with the cell's own arguments
				return fmt.Errorf("dockercli: %s: %w: %s", strings.Join(cmd, " "), err, strings.TrimSpace(string(out)))
			}
		}
	}
	return nil
}

// DataRoot is Docker's data root directory (docker info DockerRootDir).
func (c CLI) DataRoot(ctx context.Context) (string, error) {
	out, err := c.run(ctx, nil, "info", "--format", "{{.DockerRootDir}}")
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}
