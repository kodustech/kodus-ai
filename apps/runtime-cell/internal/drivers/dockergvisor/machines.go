package dockergvisor

import (
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
)

// machineState is what the driver knows of one machine beyond what Docker
// keeps (labels never change, and a compose project has no place for the
// rest). Create makes it, Up fills what a boot learns, Destroy drops all of
// it at once: nothing of one claim's machine reaches the next one that
// takes the same name. A machine the cell did not create in this run (a
// restart) gets one the first time it is touched, as an empty one.
//
// Two holds deliberately live outside it, because they outlive the
// machine: a bake's pin (Driver.pinned) and a claim's adoption of a pool
// network (Driver.adopted).
type machineState struct {
	// expires is kodus:expires, which moves (SetExpiry); zero: never set.
	expires time.Time
	// size is what the machine's claim asked (MachineSpec.ClaimSize);
	// zero: the cell's default.
	size driver.ClaimSize
	// setup marks a setup claim's machine (MachineSpec.Setup): only its
	// builds write a cache a bake can make the environment's. seeds marks
	// the setup of the default branch, whose builds make it the
	// environment's as each finishes (MachineSpec.SeedsCache); it counts
	// only together with setup.
	setup, seeds bool
	// output is what the machine holds beyond its containers, made on its
	// first boot (machineOutput); nil before that and once a bake pinned it.
	output *output
	// services are the compose services of its last Up and their fixed
	// addresses on the claim network (Targets).
	services map[string]string
	// exec is where its exec steps run, its public service's container;
	// nil when the last Up named none (Exec).
	exec *execTarget
	// targets are the containers of its last Up by compose service, where a
	// recipe step that names a service runs (RunRecipe).
	targets map[string]execTarget
	// observerSQLGeneration invalidates credential allocations that were in
	// flight when cleanup forgot the account, even before it was installed.
	observerSQLGeneration uint64
	// restoredData: the last Up gave every data volume the environment's
	// baked copy (data.reset: snapshot), which holds the seed already.
	restoredData bool
	// seedAtInit: the project binds the recipe's seed file into postgres's
	// initdb directory, so every new data volume is seeded at its start.
	seedAtInit bool
	// seedInData: the last Up's data holds the recipe's data.seed already
	// (the golden copy's, or the first boot seeded before the app).
	seedInData bool
	// golden is the copy of the first boot's data its resets start from;
	// goldenOff says the machine has none and will not try again (golden.go).
	golden    *golden
	goldenOff bool
	// boot is its last boot, per phase, under the claim it booted for
	// (BootTiming).
	boot *claimBoot
	// reset is the down of a reset whose Up has not come yet: that Up
	// reports itself as the reset, from this down on.
	reset *pendingReset
}

type pendingReset struct {
	at     time.Time
	downMs int64
}

type claimBoot struct {
	claim  string
	timing driver.BootTiming
}

// machineLocked is the machine's state, made empty when there is none.
// The caller holds d.mu.
func (d *Driver) machineLocked(id string) *machineState {
	m := d.machines[id]
	if m == nil {
		m = &machineState{}
		d.machines[id] = m
	}
	return m
}

// peek is a copy of the machine's state (zero when there is none), for a
// reader that must not make one.
func (d *Driver) peek(id string) machineState {
	d.mu.Lock()
	defer d.mu.Unlock()
	if m := d.machines[id]; m != nil {
		return *m
	}
	return machineState{}
}

// forget drops everything the driver knows of the machine (Destroy).
func (d *Driver) forget(id string) {
	d.mu.Lock()
	delete(d.machines, id)
	d.mu.Unlock()
	d.ForgetObserverSQL(id)
}
