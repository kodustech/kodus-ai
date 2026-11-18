package dockercli

import (
	"slices"
	"strings"
	"testing"
)

// The disk bound is Docker's blkio flags on a block device path only, and
// the network bound a tbf toward the container and a policer from it, at
// the same rate in bits.
func TestAContainersIOBoundIsDockersBlkioAndTwoTCRules(t *testing.T) {
	b := &IOBound{Device: "/dev/nvme0n1", ReadBps: 1000, WriteBps: 2000, WriteIOPS: 30}
	got, err := b.args()
	if err != nil || !slices.Equal(got, []string{"--device-read-bps", "/dev/nvme0n1:1000", "--device-write-bps", "/dev/nvme0n1:2000", "--device-write-iops", "/dev/nvme0n1:30"}) {
		t.Fatalf("%v %v", got, err)
	}
	if _, err := (&IOBound{Device: "/dev/../etc", WriteBps: 1}).args(); err == nil {
		t.Fatal("a path that is no device")
	}
	if got, _ := (*IOBound)(nil).args(); got != nil {
		t.Fatal("no bound, no flags")
	}
	cmds := shapeCommands("veth1a2b", 12_500_000)
	if len(cmds) != 3 || !strings.Contains(strings.Join(cmds[0], " "), "tbf rate 100000000bit") || !strings.Contains(strings.Join(cmds[2], " "), "police rate 100000000bit") {
		t.Fatalf("%v", cmds)
	}
}

// A container's interfaces name their host peers' indexes as netlink shows
// them in its namespace ("eth0@if151"); its /sys is the host's.
func TestAContainersVethPeersAreReadFromNetlink(t *testing.T) {
	out := "1: lo: <LOOPBACK,UP> mtu 65536\\    link/loopback 00:00\n2: eth0@if151: <BROADCAST,UP> mtu 1500\\    link/ether 02:09\n3: eth1@if7: <BROADCAST,UP> mtu 1500\n"
	var got []string
	for _, m := range peerIndex.FindAllStringSubmatch(out, -1) {
		got = append(got, m[1])
	}
	if !slices.Equal(got, []string{"151", "7"}) {
		t.Fatalf("%v", got)
	}
}
