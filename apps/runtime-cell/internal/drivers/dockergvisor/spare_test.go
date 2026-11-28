package dockergvisor

import (
	"context"
	"errors"
	"net/netip"
	"slices"
	"strings"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose/sandbox"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/observer"
)

func warmFork(c *Config) { c.WarmForkReset = true }

// blockAddrs are the app's and db's fixed addresses in an address block of
// the rig's claim network.
func (r *goldenRig) blockAddrs(t *testing.T, block int) map[string]string {
	t.Helper()
	r.docker.mu.Lock()
	raw := r.docker.subnets["kodus-claim-1"]
	r.docker.mu.Unlock()
	a, err := sandbox.ServiceAddressesIn([]string{"app", "db"}, netip.MustParsePrefix(raw), block)
	if err != nil {
		t.Fatal(err)
	}
	return map[string]string{"app": a["app"].String(), "db": a["db"].String()}
}

func (r *goldenRig) upReq() driver.UpRequest {
	return driver.UpRequest{Ref: r.ref, Compose: r.file, ProjectDir: r.dir}
}

// projectState is what Docker holds of one compose project: its
// containers by service, and its volumes with their data.
func (r *goldenRig) projectState(project string) (containers map[string]dockercli.Container, volumes map[string]string) {
	r.docker.mu.Lock()
	defer r.docker.mu.Unlock()
	containers, volumes = map[string]dockercli.Container{}, map[string]string{}
	for _, c := range r.docker.containers {
		if c.Labels["com.docker.compose.project"] == project {
			containers[c.Labels["com.docker.compose.service"]] = c
		}
	}
	for n, v := range r.docker.volumes {
		if v.labels["com.docker.compose.project"] == project {
			volumes[n] = v.data
		}
	}
	return containers, volumes
}

func (r *goldenRig) appTarget(t *testing.T) string {
	t.Helper()
	out, err := r.d.Targets(r.ref.MachineID, []observer.Target{{Service: "app", Port: 3000}})
	if err != nil {
		t.Fatal(err)
	}
	return out[0].Address
}

// With a ready spare, a round's reset is a swap: the spare boots from the
// first boot's golden data beside the project, in the claim network's other
// address block, while the round runs; taking it makes its services the
// machine's (the observer's targets, exec, the egress sources) and ends the
// copy the round used, containers and volumes. Nothing of what the round
// wrote reaches the spare.
func TestAResetWithAReadySpareIsASwap(t *testing.T) {
	r := newGoldenRig(t, goldenCompose, goldenRecipe, warmFork)
	ctx := context.Background()
	r.up(t)
	machine := r.ref.MachineID
	spareName := machine + "-w"
	first, second := r.blockAddrs(t, 0), r.blockAddrs(t, 1)
	if got := r.appTarget(t); got != first["app"]+":3000" {
		t.Fatalf("app target %s before any spare", got)
	}
	r.write(t, "+round1")

	var told []string
	if err := r.d.BootSpare(ctx, r.upReq(), func(sources []string) error {
		// Before any spare container starts: nothing of it is up yet.
		if cs, _ := r.projectState(spareName); len(cs) > 0 {
			t.Error("the spare's containers started before its addresses were told")
		}
		told = slices.Clone(sources)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	slices.Sort(told)
	if want := []string{second["app"], second["db"]}; !slices.Equal(told, sortedCopy(want)) {
		t.Fatalf("the spare told %v, want its block's %v", told, want)
	}
	spare, spareVols := r.projectState(spareName)
	if spare["app"].Networks["kodus-claim-1"] != second["app"] || spare["db"].Networks["kodus-claim-1"] != second["db"] {
		t.Fatalf("spare containers %+v", spare)
	}
	for name, data := range spareVols {
		if strings.Contains(data, "+round1") {
			t.Fatalf("the spare's volume %s holds the used copy's round: %q", name, data)
		}
	}
	if got := r.appTarget(t); got != first["app"]+":3000" {
		t.Fatalf("a booting spare moved the app's target to %s", got)
	}
	if spare["app"].Labels[labelProjectOf] != machine || spare["db"].Labels[labelProjectOf] != machine {
		t.Fatalf("spare containers carry no machine label: %v", spare["app"].Labels)
	}

	sources, ok, err := r.d.TakeSpare(ctx, r.ref)
	if err != nil || !ok {
		t.Fatalf("take: ok %v err %v", ok, err)
	}
	slices.Sort(sources)
	if !slices.Equal(sources, told) {
		t.Fatalf("sources after the swap %v, want the spare's %v", sources, told)
	}
	if got := r.appTarget(t); got != second["app"]+":3000" {
		t.Fatalf("the observer still reaches %s", got)
	}
	// Killed at the swap, then down with its volumes off the reset's path.
	if !slices.Contains(r.docker.kills, machine) {
		t.Fatalf("the used copy was not killed: %v", r.docker.kills)
	}
	<-r.d.peek(machine).draining
	if used, vols := r.projectState(machine); len(used) > 0 || len(vols) > 0 {
		t.Fatalf("the used copy outlived the swap: %v %v", used, vols)
	}
	if ex := r.d.peek(machine).exec; ex == nil || ex.container != spare["app"].ID {
		t.Fatalf("exec goes to %+v, not the spare's app", ex)
	}
	if tm, ok := r.d.BootTiming(r.ref.Tags[driver.TagClaim]); !ok || tm.Kind != "reset" {
		t.Fatalf("the swap reported %+v", tm)
	}
}

func sortedCopy(s []string) []string {
	out := slices.Clone(s)
	slices.Sort(out)
	return out
}

// The next spare takes the block and the name the used copy left, with
// new volumes; with none ready, a reset is today's: the project running now
// (the spare's name since the swap) goes down and comes up again in its own
// block.
func TestSparesAlternateAndAResetWithoutOneIsTodays(t *testing.T) {
	r := newGoldenRig(t, goldenCompose, goldenRecipe, warmFork)
	ctx := context.Background()
	r.up(t)
	machine := r.ref.MachineID
	if _, ok, err := r.d.TakeSpare(ctx, r.ref); ok || err != nil {
		t.Fatalf("a take with no spare: ok %v err %v", ok, err)
	}
	if cs, _ := r.projectState(machine); len(cs) != 2 {
		t.Fatal("a take with no spare touched the project")
	}
	for round, block := range []int{1, 0, 1} {
		if err := r.d.BootSpare(ctx, r.upReq(), func([]string) error { return nil }); err != nil {
			t.Fatalf("spare %d: %v", round, err)
		}
		if _, ok, err := r.d.TakeSpare(ctx, r.ref); !ok || err != nil {
			t.Fatalf("take %d: ok %v err %v", round, ok, err)
		}
		if got, want := r.appTarget(t), r.blockAddrs(t, block)["app"]+":3000"; got != want {
			t.Fatalf("round %d: app at %s, want %s", round, got, want)
		}
	}
	// Now on the spare's name, in block 1: a reset with no spare downs it
	// and brings it back there.
	r.write(t, "+round")
	r.reset(t)
	cs, _ := r.projectState(machine + "-w")
	if cs["app"].Networks["kodus-claim-1"] != r.blockAddrs(t, 1)["app"] {
		t.Fatalf("today's reset after a swap: %+v", cs)
	}
	if _, data := r.dbData(t); strings.Contains(data, "+round") {
		t.Fatalf("today's reset kept the round's data: %q", data)
	}
}

// currentProject is the compose project the machine runs now.
func (r *goldenRig) currentProject() string {
	name, _ := r.d.projectOf(r.ref.MachineID)
	return name
}

// A spare that fails turns the machine's spares off: nothing of it is
// left, the next take finds none and the next boot is refused, while the
// project its rounds use is untouched.
func TestASpareThatFailsTurnsSparesOffForTheMachine(t *testing.T) {
	r := newGoldenRig(t, goldenCompose, goldenRecipe, warmFork)
	ctx := context.Background()
	r.up(t)
	machine := r.ref.MachineID
	r.docker.upErr = map[string]error{machine + "-w": errors.New("compose up failed")}
	if err := r.d.BootSpare(ctx, r.upReq(), func([]string) error { return nil }); err == nil {
		t.Fatal("a failed spare boot answered ok")
	}
	if cs, vols := r.projectState(machine + "-w"); len(cs) > 0 || len(vols) > 0 {
		t.Fatalf("the failed spare left %v %v", cs, vols)
	}
	if _, ok, err := r.d.TakeSpare(ctx, r.ref); ok || err != nil {
		t.Fatalf("take after a failed spare: ok %v err %v", ok, err)
	}
	r.docker.upErr = nil
	if err := r.d.BootSpare(ctx, r.upReq(), func([]string) error { return nil }); !errors.Is(err, ErrSparesOff) {
		t.Fatalf("a second spare after a failure: %v", err)
	}
	if cs, _ := r.projectState(machine); len(cs) != 2 {
		t.Fatal("the failed spare touched the project")
	}
	// A refusal to list the spare's addresses fails it the same way.
	r2 := newGoldenRig(t, goldenCompose, goldenRecipe, warmFork)
	r2.up(t)
	if err := r2.d.BootSpare(ctx, r2.upReq(), func([]string) error { return errors.New("egress push failed") }); err == nil {
		t.Fatal("a spare whose addresses the policy could not take booted")
	}
	if cs, _ := r2.projectState(r2.ref.MachineID + "-w"); len(cs) > 0 {
		t.Fatal("a spare started with no egress for its addresses")
	}
}

// A dropped spare (a claim needs its memory) is gone, containers and
// volumes, without turning spares off; Destroy and the reaper take a
// machine's spare with it, and the reaper sees the spare as part of its
// machine, not a machine of its own.
func TestDestroyTheSweepAndTheReaperTakeTheSpare(t *testing.T) {
	r := newGoldenRig(t, goldenCompose, goldenRecipe, warmFork)
	ctx := context.Background()
	r.up(t)
	machine := r.ref.MachineID
	if err := r.d.BootSpare(ctx, r.upReq(), func([]string) error { return nil }); err != nil {
		t.Fatal(err)
	}
	if dropped, err := r.d.DropSpare(ctx, r.ref); !dropped || err != nil {
		t.Fatalf("drop: %v %v", dropped, err)
	}
	if cs, vols := r.projectState(machine + "-w"); len(cs) > 0 || len(vols) > 0 {
		t.Fatalf("the dropped spare left %v %v", cs, vols)
	}
	if dropped, _ := r.d.DropSpare(ctx, r.ref); dropped {
		t.Fatal("a second drop dropped something")
	}
	if err := r.d.BootSpare(ctx, r.upReq(), func([]string) error { return nil }); err != nil {
		t.Fatalf("a drop turned spares off: %v", err)
	}

	rp, err := NewForReaper(r.docker, ReaperConfig{CellID: "cell-1", WorkDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	refs, err := rp.List(ctx, map[string]string{driver.TagCell: "cell-1"})
	if err != nil {
		t.Fatal(err)
	}
	var ids []string
	for _, ref := range refs {
		ids = append(ids, ref.MachineID)
	}
	if !slices.Equal(ids, []string{machine}) {
		t.Fatalf("the reaper lists %v, want the machine alone", ids)
	}
	if err := rp.Destroy(ctx, refs[0]); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{machine, machine + "-w"} {
		if cs, vols := r.projectState(p); len(cs) > 0 || len(vols) > 0 {
			t.Fatalf("the reaper left %s: %v %v", p, cs, vols)
		}
	}

	// The cell's own Destroy, after one swap (the project runs under the
	// spare's name) or two, with the next spare ready in the other name.
	for _, swaps := range []int{1, 2} {
		r2 := newGoldenRig(t, goldenCompose, goldenRecipe, warmFork)
		r2.up(t)
		for range swaps {
			if err := r2.d.BootSpare(ctx, r2.upReq(), func([]string) error { return nil }); err != nil {
				t.Fatal(err)
			}
			if _, ok, err := r2.d.TakeSpare(ctx, r2.ref); !ok || err != nil {
				t.Fatal(ok, err)
			}
		}
		if err := r2.d.BootSpare(ctx, r2.upReq(), func([]string) error { return nil }); err != nil {
			t.Fatal(err)
		}
		if err := r2.d.Destroy(ctx, r2.ref); err != nil {
			t.Fatal(err)
		}
		for _, p := range []string{r2.ref.MachineID, r2.ref.MachineID + "-w"} {
			if cs, vols := r2.projectState(p); len(cs) > 0 || len(vols) > 0 {
				t.Fatalf("destroy after %d swaps left %s: %v %v", swaps, p, cs, vols)
			}
		}
	}
}

// A spare costs the claim's memory again, inside the claim's own ceiling
// under claim limits: the cell refuses the two together rather than let a
// spare push the claim into its OOM killer.
func TestWarmForkResetRefusesClaimLimits(t *testing.T) {
	_, err := New(context.Background(), newMemDocker(), Config{
		CellID: "cell-1", HolderImage: "kodus/holder@sha256:abc", WorkDir: t.TempDir(), WarmForkReset: true, ClaimLimits: &fakeClaimLimits{},
	})
	if err == nil || !strings.Contains(err.Error(), "warm fork") {
		t.Fatalf("warm fork with claim limits: %v", err)
	}
}
