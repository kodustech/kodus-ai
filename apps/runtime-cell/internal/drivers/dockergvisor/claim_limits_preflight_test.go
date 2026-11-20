package dockergvisor

import (
	"context"
	"strings"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/claimlimits"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
)

type incompatibleCgroupDocker struct {
	*memDocker
	info dockercli.CgroupDaemonInfo
}

func (d incompatibleCgroupDocker) CgroupInfo(context.Context) (dockercli.CgroupDaemonInfo, error) {
	return d.info, nil
}

func TestClaimLimitsRefuseUnsupportedDockerBeforeLaunch(t *testing.T) {
	for _, info := range []dockercli.CgroupDaemonInfo{{Version: "1", Driver: "cgroupfs"}, {Version: "2", Driver: "systemd"}, {Version: "2", Driver: "cgroupfs", Rootless: true}} {
		docker := incompatibleCgroupDocker{memDocker: newMemDocker(), info: info}
		_, err := New(context.Background(), docker, Config{CellID: "cell-1", HolderImage: "h", WorkDir: t.TempDir(), ClaimLimits: &fakeClaimLimits{}})
		if err == nil {
			t.Fatalf("unsupported daemon accepted: %+v", info)
		}
		if len(docker.containers) != 0 {
			t.Fatal("preflight launched a container")
		}
	}
}

func TestSystemdBackendPreflightRequiresExactDaemonAndRunscMode(t *testing.T) {
	info := dockercli.CgroupDaemonInfo{Version: "2", Driver: "systemd", Runtimes: map[string]dockercli.RuntimeInfo{"runsc": {Path: "/usr/bin/runsc", RuntimeArgs: []string{"--systemd-cgroup", "--oci-seccomp"}}}}
	docker := incompatibleCgroupDocker{memDocker: newMemDocker(), info: info}
	d, err := New(context.Background(), docker, Config{CellID: "cell-1", HolderImage: "h", WorkDir: t.TempDir(), ClaimLimits: &fakeClaimLimits{}, ClaimLimitBackend: "systemd"})
	if err != nil || d.cfg.ClaimLimitBackend != "systemd" {
		t.Fatalf("driver=%+v err=%v", d, err)
	}
	for _, args := range [][]string{nil, {"--systemd-cgroup=false"}, {"--systemd-cgroup=true", "--systemd-cgroup=false"}, {"--systemd-cgroup", "--root=/tmp/other"}} {
		info.Runtimes["runsc"] = dockercli.RuntimeInfo{Path: "/usr/bin/runsc", RuntimeArgs: append(append([]string{}, args...), "--oci-seccomp")}
		// An unrelated runtime flag is allowed; only missing/disabled systemd mode is refused.
		want := len(args) == 2 && args[0] == "--systemd-cgroup"
		err := ValidateClaimLimitDaemon(info, "systemd", "runsc")
		if (err == nil) != want {
			t.Fatalf("args=%v err=%v", args, err)
		}
	}
	info.Runtimes = nil
	if err := ValidateClaimLimitDaemon(info, "systemd", "runsc"); err == nil {
		t.Fatal("missing runtime config accepted")
	}
	for _, endpoint := range []string{"tcp://127.0.0.1:2375", "ssh://localhost", "unix:///a/../b", "unix:///a\n"} {
		if err := ValidateClaimLimitEndpoint(endpoint); err == nil {
			t.Fatalf("accepted endpoint %q", endpoint)
		}
	}
}

type sliceClaimLimits struct {
	fakeClaimLimits
	cell string
}

func (f *sliceClaimLimits) Ensure(key string, l claimlimits.Limits) (string, error) {
	if _, err := f.fakeClaimLimits.Ensure(key, l); err != nil {
		return "", err
	}
	return strings.TrimSuffix(claimlimits.RootSliceName(f.cell), ".slice") + "-" + key + ".slice", nil
}

func TestSystemdParentFlowsThroughDriverIntoHolder(t *testing.T) {
	m := newMemDocker()
	docker := incompatibleCgroupDocker{memDocker: m, info: dockercli.CgroupDaemonInfo{Version: "2", Driver: "systemd", Runtimes: map[string]dockercli.RuntimeInfo{"runsc": {Path: "/runsc", RuntimeArgs: []string{"--systemd-cgroup", "--oci-seccomp"}}}}}
	limits := &sliceClaimLimits{cell: "cell-1"}
	d, err := New(context.Background(), docker, Config{CellID: "cell-1", HolderImage: "holder", WorkDir: t.TempDir(), ClaimLimits: limits, ClaimLimitBackend: "systemd"})
	if err != nil {
		t.Fatal(err)
	}
	s := spec()
	n, err := d.PrepareClaim(context.Background(), driver.ClaimNetworkSpec{CellID: s.CellID, OrgID: s.OrgID, ClaimID: s.ClaimID})
	if err != nil {
		t.Fatal(err)
	}
	s.ClaimGroupID = n.WorkloadGroupID
	ref, err := d.Create(context.Background(), s)
	if err != nil {
		t.Fatal(err)
	}
	cs, err := m.Inspect(context.Background(), ref.MachineID)
	if err != nil || len(cs) != 1 || !strings.HasSuffix(cs[0].CgroupParent, ".slice") || strings.HasPrefix(cs[0].CgroupParent, "/") {
		t.Fatalf("holder=%+v err=%v", cs, err)
	}
}

// runsc ignores the container's seccomp profile without --oci-seccomp, so a
// sandbox command could unshare a user namespace (boundary probe P01): the
// cell refuses to take work on such a host, whatever the cgroup backend.
func TestRunscMustApplyTheContainersSeccompProfile(t *testing.T) {
	for _, tc := range []struct {
		args []string
		ok   bool
	}{
		{[]string{"--systemd-cgroup"}, false},
		{[]string{"--systemd-cgroup", "--oci-seccomp=false"}, false},
		{[]string{"--systemd-cgroup", "--oci-seccomp"}, true},
		{[]string{"--systemd-cgroup", "--oci-seccomp=true"}, true},
	} {
		info := dockercli.CgroupDaemonInfo{Version: "2", Driver: "systemd", Runtimes: map[string]dockercli.RuntimeInfo{"runsc": {Path: "/usr/bin/runsc", RuntimeArgs: tc.args}}}
		err := ValidateClaimLimitDaemon(info, "systemd", "runsc")
		if (err == nil) != tc.ok {
			t.Fatalf("args=%v err=%v", tc.args, err)
		}
		if !tc.ok && !strings.Contains(err.Error(), "--oci-seccomp") {
			t.Fatalf("the refusal does not name the flag: %v", err)
		}
	}
}
