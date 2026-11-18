package firecracker

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/placement/hostnet"
)

func statesOf(l isolation.MachineLog) []string {
	out := make([]string, 0, len(l.Transitions))
	for _, t := range l.Transitions {
		out = append(out, t.State)
	}
	return out
}

// A machine whose VMM fails leaves nothing of itself behind but what it
// said: its jail goes, and its VMM's log (token-shaped strings masked) and
// the states it went through, each timed, are still there for its claim,
// and for no other claim.
func TestAFailedMachinesLogAndStatesOutliveItsJail(t *testing.T) {
	vmm := &fakeVMM{
		t: t, state: map[string]string{}, args: map[string][]string{}, fail: true,
		logs: "[anonymous-instance:main] Running Firecracker\nAuthorization: Bearer abcdefgh12345678\n[anonymous-instance:main] Error creating the vm: KvmCreateVm\n",
	}
	b := newBackend(t, vmm, &fakeNet{taps: map[string]hostnet.Attachment{}})
	spec := isolation.Spec{Shape: isolation.ShapeSandbox, Name: "kodus-f-workload", Network: "kodus-f", Org: "org-1", Claim: "claim-f"}
	before := time.Now().UTC()
	if _, err := b.Create(context.Background(), spec); err == nil {
		t.Fatal("created")
	}
	if left := b.Remains(spec.Name); len(left) > 0 {
		t.Fatalf("left %v", left)
	}
	logs, err := b.MachineLogs("org-1", "claim-f")
	if err != nil || len(logs) != 1 {
		t.Fatalf("logs %+v %v", logs, err)
	}
	l := logs[0]
	if l.Name != spec.Name || l.Kept.IsZero() {
		t.Fatalf("kept %+v", l)
	}
	if got := strings.Join(statesOf(l), ","); got != "created,failed,destroyed" {
		t.Fatalf("states %s", got)
	}
	if at := l.Transitions[0].At; at.Before(before.Add(-time.Second)) || at.After(time.Now().Add(time.Second)) {
		t.Fatalf("a state's time %v", at)
	}
	if !strings.Contains(l.Transitions[1].Detail, "jailer: exit status 1") {
		t.Fatalf("the failure is not named: %+v", l.Transitions[1])
	}
	if !strings.Contains(l.VMMLog, "KvmCreateVm") || strings.Contains(l.VMMLog, "abcdefgh12345678") || !strings.Contains(l.VMMLog, "[redacted:generic-bearer]") {
		t.Fatalf("vmm log %q", l.VMMLog)
	}
	raw, err := os.ReadDir(b.keptDir())
	if err != nil || len(raw) != 1 {
		t.Fatalf("kept dir %v %v", raw, err)
	}
	if fi, _ := raw[0].Info(); fi.Mode().Perm() != 0o600 {
		t.Fatalf("a kept log is %v", fi.Mode())
	}
	for _, other := range [][2]string{{"org-1", "claim-g"}, {"org-2", "claim-f"}} {
		if got, err := b.MachineLogs(other[0], other[1]); err != nil || len(got) != 0 {
			t.Fatalf("%v sees %+v %v", other, got, err)
		}
	}
}

// A machine that ran is read live while it runs, and kept with every state
// it went through once destroyed; a log past the bound keeps its newest
// bytes and says so.
func TestAMachinesStatesAreTimedLiveAndKeptAfterDestroy(t *testing.T) {
	vmm := &fakeVMM{t: t, state: map[string]string{}, args: map[string][]string{}, logs: strings.Repeat("x", keptLogBytes) + "\nthe newest line\n"}
	b := newBackend(t, vmm, &fakeNet{taps: map[string]hostnet.Attachment{}})
	ctx := context.Background()
	spec := isolation.Spec{Shape: isolation.ShapeSandbox, Name: "kodus-r-workload", Network: "kodus-r", Org: "org-1", Claim: "claim-r"}
	if _, err := b.Create(ctx, spec); err != nil {
		t.Fatal(err)
	}
	if err := b.Pause(ctx, spec.Name); err != nil {
		t.Fatal(err)
	}
	if err := b.Start(ctx, spec.Name); err != nil {
		t.Fatal(err)
	}
	live, err := b.MachineLogs("org-1", "claim-r")
	if err != nil || len(live) != 1 || !live[0].Kept.IsZero() {
		t.Fatalf("live %+v %v", live, err)
	}
	if got := strings.Join(statesOf(live[0]), ","); got != "created,launched,running,paused,running" {
		t.Fatalf("live states %s", got)
	}
	vmm.close()
	if err := b.Destroy(ctx, spec.Name, isolation.DestroyOptions{}); err != nil {
		t.Fatal(err)
	}
	if left := b.Remains(spec.Name); len(left) > 0 {
		t.Fatalf("left %v", left)
	}
	kept, err := b.MachineLogs("org-1", "claim-r")
	if err != nil || len(kept) != 1 || kept[0].Kept.IsZero() {
		t.Fatalf("kept %+v %v", kept, err)
	}
	states := statesOf(kept[0])
	if !strings.HasPrefix(strings.Join(states, ","), "created,launched,running,paused,running") || states[len(states)-1] != isolation.StateDestroyed {
		t.Fatalf("kept states %v", states)
	}
	if !kept[0].Truncated || len(kept[0].VMMLog) > keptLogBytes || !strings.HasSuffix(kept[0].VMMLog, "the newest line\n") {
		t.Fatalf("a long log: truncated %v, %d bytes", kept[0].Truncated, len(kept[0].VMMLog))
	}
}

// The kept logs are bounded: none older than keptFor, at most keptMachines.
func TestKeptLogsAreBoundedInCountAndAge(t *testing.T) {
	b := newBackend(t, &fakeVMM{t: t, state: map[string]string{}, args: map[string][]string{}}, &fakeNet{taps: map[string]hostnet.Attachment{}})
	now := time.Now()
	if err := os.MkdirAll(b.keptDir(), 0o700); err != nil {
		t.Fatal(err)
	}
	put := func(at time.Time, id string) string {
		n := strconv.FormatInt(at.UnixNano(), 10) + "-" + id + ".json"
		if err := os.WriteFile(filepath.Join(b.keptDir(), n), []byte(`{"org":"o","claim":"c"}`), 0o600); err != nil {
			t.Fatal(err)
		}
		return n
	}
	stale := put(now.Add(-keptFor-time.Hour), "stale")
	var fresh []string
	for i := range keptMachines + 3 {
		fresh = append(fresh, put(now.Add(-time.Duration(keptMachines+3-i)*time.Second), "m"+strconv.Itoa(i)))
	}
	b.pruneKept(now)
	left := b.keptFiles()
	if len(left) != keptMachines || left[0] != fresh[3] || left[len(left)-1] != fresh[len(fresh)-1] {
		t.Fatalf("left %d, first %s", len(left), left[0])
	}
	for _, n := range left {
		if n == stale {
			t.Fatal("a log older than keptFor is kept")
		}
	}
}
