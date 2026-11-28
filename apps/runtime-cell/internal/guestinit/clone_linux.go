//go:build linux

package guestinit

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"time"
	"unsafe"

	"golang.org/x/sys/unix"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/vsock"
)

// linuxClone is the CloneKernel PID 1 runs on.
type linuxClone struct {
	// bound are the files init bound already; it lives in the machine's
	// memory, so a machine restored from a restored one knows its binds.
	bound map[string]bool
}

var _ CloneKernel = (*linuxClone)(nil)

// AddEntropy is what docs/snapshotting/random-for-clones.md asks before a
// clone's code resumes: RNDADDENTROPY with the host's bytes, credited,
// then RNDRESEEDCRNG.
func (*linuxClone) AddEntropy(b []byte) error {
	f, err := os.OpenFile("/dev/urandom", os.O_WRONLY, 0)
	if err != nil {
		return err
	}
	defer func() { _ = f.Close() }()
	// struct rand_pool_info { int entropy_count; int buf_size; __u32 buf[]; }
	info := make([]byte, 8+len(b))
	binary.NativeEndian.PutUint32(info[0:], uint32(len(b)*8)) //nolint:gosec // G115: SeedBytes, validated
	binary.NativeEndian.PutUint32(info[4:], uint32(len(b)))   //nolint:gosec // G115: SeedBytes, validated
	copy(info[8:], b)
	if _, _, e := unix.Syscall(unix.SYS_IOCTL, f.Fd(), unix.RNDADDENTROPY, uintptr(unsafe.Pointer(&info[0]))); e != 0 { //nolint:gosec // G103: the ioctl takes the kernel's struct by pointer
		return fmt.Errorf("RNDADDENTROPY: %w", e)
	}
	if _, _, e := unix.Syscall(unix.SYS_IOCTL, f.Fd(), unix.RNDRESEEDCRNG, 0); e != 0 {
		return fmt.Errorf("RNDRESEEDCRNG: %w", e)
	}
	return nil
}

func (*linuxClone) SetClock(unixNano int64) error {
	ts := unix.NsecToTimespec(unixNano)
	return unix.ClockSettime(unix.CLOCK_REALTIME, &ts)
}

func (*linuxClone) Now() int64 { return time.Now().UnixNano() }

func (*linuxClone) Sethostname(name string) error { return unix.Sethostname([]byte(name)) }

func (*linuxClone) WriteInPlace(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil { //nolint:gosec // G301: /run/kody, read by every user
		return err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o444) //nolint:gosec // G302: an id every user reads
	if err != nil {
		return err
	}
	_, err = f.Write(data)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	return err
}

func (c *linuxClone) Bind(src, dst string) error {
	if c.bound[dst] {
		return nil
	}
	if err := unix.Mount(src, dst, "", unix.MS_BIND, ""); err != nil {
		return err
	}
	if err := unix.Mount("", dst, "", unix.MS_BIND|unix.MS_REMOUNT|unix.MS_RDONLY, ""); err != nil {
		return err
	}
	c.bound[dst] = true
	return nil
}

func (*linuxClone) Exists(path string) bool { _, err := os.Lstat(path); return err == nil }

func (*linuxClone) Remove(path string) error { return os.Remove(path) }

func (*linuxClone) ReadFile(path string) ([]byte, error) {
	return os.ReadFile(path) //nolint:gosec // G304: init's own fixed paths
}

// ifreqHW is struct ifreq with ifr_hwaddr, which x/sys does not set.
type ifreqHW struct {
	Name   [unix.IFNAMSIZ]byte
	Family uint16
	Data   [14]byte
	_      [8]byte
}

// ConfigureNet takes iface down (Linux drops its IPv4 routes and its
// neighbours with it), sets its MAC and address, brings it up (the
// prefix's route comes back) and adds the default route.
func (*linuxClone) ConfigureNet(iface string, n NetConfig) error {
	mac, err := hexMAC(n.MAC)
	if err != nil {
		return err
	}
	fd, err := unix.Socket(unix.AF_INET, unix.SOCK_DGRAM|unix.SOCK_CLOEXEC, 0)
	if err != nil {
		return err
	}
	defer func() { _ = unix.Close(fd) }()
	setUp := func(up bool) error {
		ifr, err := unix.NewIfreq(iface)
		if err != nil {
			return err
		}
		if err := unix.IoctlIfreq(fd, unix.SIOCGIFFLAGS, ifr); err != nil {
			return err
		}
		f := ifr.Uint16() &^ unix.IFF_UP
		if up {
			f |= unix.IFF_UP
		}
		ifr.SetUint16(f)
		return unix.IoctlIfreq(fd, unix.SIOCSIFFLAGS, ifr)
	}
	if err := setUp(false); err != nil {
		return fmt.Errorf("down: %w", err)
	}
	var hw ifreqHW
	copy(hw.Name[:], iface)
	hw.Family = unix.ARPHRD_ETHER
	copy(hw.Data[:], mac[:])
	if _, _, e := unix.Syscall(unix.SYS_IOCTL, uintptr(fd), unix.SIOCSIFHWADDR, uintptr(unsafe.Pointer(&hw))); e != 0 { //nolint:gosec // G103,G115: the ioctl takes struct ifreq by pointer; fd is a socket
		return fmt.Errorf("MAC: %w", e)
	}
	// A restored machine announces its address when eth0 comes up (a
	// gratuitous ARP): a peer that kept sending to it while it was gone (the
	// observer during a round snapshot, a minute or more) holds an
	// unresolved neighbour entry, and a connection that waited on it got
	// "no route to host" once that entry failed (round 3's first probe
	// after a round). The announcement resolves the entry at once.
	if err := os.WriteFile("/proc/sys/net/ipv4/conf/"+iface+"/arp_notify", []byte("1"), 0o644); err != nil { //nolint:gosec // G306: a sysctl, not a file
		return fmt.Errorf("arp_notify: %w", err)
	}
	ip, mask := n.IP.As4(), netmaskBytes(n.Prefix)
	for _, step := range []struct {
		req uint
		v   []byte
	}{{unix.SIOCSIFADDR, ip[:]}, {unix.SIOCSIFNETMASK, mask[:]}} {
		ifr, err := unix.NewIfreq(iface)
		if err != nil {
			return err
		}
		if err := ifr.SetInet4Addr(step.v); err != nil {
			return err
		}
		if err := unix.IoctlIfreq(fd, step.req, ifr); err != nil {
			return fmt.Errorf("address: %w", err)
		}
	}
	if err := setUp(true); err != nil {
		return fmt.Errorf("up: %w", err)
	}
	ifr, err := unix.NewIfreq(iface)
	if err != nil {
		return err
	}
	if err := unix.IoctlIfreq(fd, unix.SIOCGIFINDEX, ifr); err != nil {
		return err
	}
	gw := n.Gateway.As4()
	return defaultRoute(ifr.Uint32(), gw)
}

func netmaskBytes(bits int) [4]byte {
	var b [4]byte
	for i := range bits {
		b[i/8] |= 0x80 >> (i % 8)
	}
	return b
}

// defaultRoute adds (or replaces) the IPv4 default route through gw on the
// interface of index ifindex, over rtnetlink.
func defaultRoute(ifindex uint32, gw [4]byte) error {
	s, err := unix.Socket(unix.AF_NETLINK, unix.SOCK_RAW|unix.SOCK_CLOEXEC, unix.NETLINK_ROUTE)
	if err != nil {
		return err
	}
	defer func() { _ = unix.Close(s) }()
	attr := func(typ uint16, v []byte) []byte {
		b := make([]byte, unix.SizeofRtAttr+len(v))
		binary.NativeEndian.PutUint16(b[0:], uint16(len(b))) //nolint:gosec // G115: a few bytes
		binary.NativeEndian.PutUint16(b[2:], typ)
		copy(b[4:], v)
		return b
	}
	oif := make([]byte, 4)
	binary.NativeEndian.PutUint32(oif, ifindex)
	body := []byte{unix.AF_INET, 0, 0, 0, unix.RT_TABLE_MAIN, unix.RTPROT_BOOT, unix.RT_SCOPE_UNIVERSE, unix.RTN_UNICAST, 0, 0, 0, 0}
	body = append(body, attr(unix.RTA_GATEWAY, gw[:])...)
	body = append(body, attr(unix.RTA_OIF, oif)...)
	msg := make([]byte, unix.SizeofNlMsghdr, unix.SizeofNlMsghdr+len(body))
	binary.NativeEndian.PutUint32(msg[0:], uint32(unix.SizeofNlMsghdr+len(body))) //nolint:gosec // G115: a few bytes
	binary.NativeEndian.PutUint16(msg[4:], unix.RTM_NEWROUTE)
	binary.NativeEndian.PutUint16(msg[6:], unix.NLM_F_REQUEST|unix.NLM_F_ACK|unix.NLM_F_CREATE|unix.NLM_F_REPLACE)
	binary.NativeEndian.PutUint32(msg[8:], 1)
	msg = append(msg, body...)
	if err := unix.Sendto(s, msg, 0, &unix.SockaddrNetlink{Family: unix.AF_NETLINK}); err != nil {
		return err
	}
	buf := make([]byte, 4096)
	n, _, err := unix.Recvfrom(s, buf, 0)
	if err != nil {
		return err
	}
	if n < unix.SizeofNlMsghdr+4 || binary.NativeEndian.Uint16(buf[4:]) != unix.NLMSG_ERROR {
		return errors.New("route: no acknowledgement")
	}
	if code := int32(binary.NativeEndian.Uint32(buf[unix.SizeofNlMsghdr:])); code != 0 { //nolint:gosec // G115: the kernel's errno, negated
		return fmt.Errorf("route: %w", unix.Errno(-code)) //nolint:gosec // G115: the kernel's errno, small and positive once negated
	}
	return nil
}

// Freeze writes the cgroup's freeze and waits for its events to say so.
func (*linuxClone) Freeze(cgroup string, frozen bool) error {
	dir := filepath.Join(CgroupRoot, cgroup)
	v, want := "0", "frozen 0"
	if frozen {
		v, want = "1", "frozen 1"
	}
	if err := os.WriteFile(filepath.Join(dir, "cgroup.freeze"), []byte(v), 0o644); err != nil { //nolint:gosec // G306: a cgroup control file
		return err
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		ev, err := os.ReadFile(filepath.Join(dir, "cgroup.events")) //nolint:gosec // G304: the workload's cgroup
		if err != nil {
			return err
		}
		if bytes.Contains(ev, []byte(want)) {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("%s is not %q after 5 s", cgroup, want)
		}
		time.Sleep(time.Millisecond)
	}
}

// Processes reads every process's pid, parent and name from /proc.
func (*linuxClone) Processes() ([]Proc, error) {
	ents, err := os.ReadDir("/proc")
	if err != nil {
		return nil, err
	}
	var out []Proc
	for _, e := range ents {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		raw, err := os.ReadFile(filepath.Join("/proc/"+e.Name(), "stat"))
		if err != nil {
			continue // gone since the listing
		}
		p, ok := parseStat(pid, string(raw))
		if ok {
			out = append(out, p)
		}
	}
	return out, nil
}

// serveControl answers the host's control requests on ControlPort for as
// long as the machine runs: one request per connection, from the host only.
func serveControl(c *Clone) {
	l, err := vsock.Listen(ControlPort)
	if err != nil {
		fmt.Fprintln(os.Stderr, "kody-guest: control port:", err)
		return
	}
	for {
		conn, cid, err := l.AcceptFrom()
		if err != nil {
			time.Sleep(10 * time.Millisecond)
			continue
		}
		if cid != HostCID {
			_ = conn.Close()
			continue
		}
		go func() {
			defer func() { _ = conn.Close() }()
			t := time.AfterFunc(30*time.Second, func() { _ = conn.Close() })
			defer t.Stop()
			var req ControlRequest
			if err := ReadControl(conn, &req); err != nil {
				_ = WriteControl(conn, ControlReply{Error: clip(err.Error())})
				return
			}
			_ = WriteControl(conn, c.Handle(req, time.Now()))
		}()
	}
}
