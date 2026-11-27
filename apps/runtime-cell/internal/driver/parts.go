package driver

// Parts is every optional capability of a driver, beyond the MachineDriver
// core: the one place a driver says what else it can do. A nil field is a
// capability the driver does not have, and the cell asks nothing of it.
//
// Each driver package returns its Parts (Driver.Parts), cmd/cell assigns
// them once to agent.Config.Parts, and nobody looks for a capability on a
// driver value by type assertion: a wrapper (Observed) would hide it. What
// Capabilities used to declare apart (a bake, memory snapshots) is read from
// here, so the two cannot disagree.
type Parts struct {
	// Baker builds an environment image from a clean setup machine; nil:
	// the cell refuses image.bake.
	Baker Baker
	// BakePinner pins what the setup claim's machine built before
	// image.bake is acked (docker-gvisor, microvm).
	BakePinner BakeSourcePinner
	// BakeCatalog restores the verified clean bakes after a restart.
	BakeCatalog BakeCatalog
	// Resetter brings a machine back to a disk or compose-volumes snapshot
	// (machine.reset); nil: the cell refuses it with ErrUnsupported.
	Resetter MachineResetter
	// DataResetter resets only the data services of a data.reset: data-only
	// recipe and keeps the app running; nil: every reset recreates.
	DataResetter DataResetter
	// Composer boots the claim's compose project itself, and Recipes runs
	// the recipe's own boot steps in it.
	Composer ComposeBooter
	Recipes  RecipeRunner
	// Spares keeps a warm spare of a compose machine's project, so its next
	// machine.reset is a swap; nil: every reset brings the project down
	// and up again.
	Spares SpareKeeper
	// Pooler keeps clean machines ready per environment (pool.target).
	Pooler Pooler
	// Sandboxes boots code sandboxes (sandbox.acquire).
	Sandboxes Sandboxer
	// ToolLayers keeps tool layers (sandbox.acquire toolLayers and
	// layerBuild); nil: the cell announces no toolLayers feature.
	ToolLayers ToolLayers
	// Snapshots keeps machines as memory snapshots; non-nil is what hello
	// capabilities.snapshotMemory says. Sessions forgets an org's session
	// snapshot at once (snapshot.forget).
	Snapshots Snapshotter
	Sessions  SessionForgetter
	// Memory is the budget of a driver whose claims share the cell's own
	// memory (ADR-070); nil: no memory admission. SandboxMemory, on such a
	// driver, counts a code sandbox for more than its size names.
	Memory        MemoryBudget
	SandboxMemory SandboxBudget
	// ReadyMemory, on such a driver, enforces a smaller ceiling on a claim
	// once it is ready, and admission counts that instead of ReadyMB.
	ReadyMemory ReadySettler
	// Diagnoser, ServiceLogs and Health read a claim's machines for the
	// failure bundle, a probe round's logs and a step's vmHealth.
	Diagnoser   Diagnoser
	ServiceLogs ServiceLogReader
	Health      HealthReader
	// BootTimes and BootPhases say where a claim's boot spent its time.
	BootTimes  BootTimer
	BootPhases BootPhaser
	// BuildStates says which environments' build state the disk floor
	// removed (heartbeat evictedBuildStates).
	BuildStates BuildStateReporter
	// SQLObservers provisions an observer's read-only SQL account.
	SQLObservers SQLObserverProvisioner
	// Coverage flushes a Run's V8 coverage (claim.exercised); nil: the
	// cell instruments nothing and answers unsupported_driver.
	Coverage CoverageFlusher
	// Sweeper removes, on its own, this cell's machines past their ceiling;
	// nil: the reaper alone does.
	Sweeper Sweeper
	// DiskUsers says what each claim holds on Docker's disk, so the disk
	// watchdog stops the claim that fills it first; nil: it stops them all.
	DiskUsers DiskUsageReader
	// BuildCache drops build cache no live build holds, so the disk watchdog
	// gives the room back before it stops a claim; nil: it drops none.
	BuildCache BuildCachePruner
	// DiskReclaim removes the exported caches and build states the disk
	// floor orders (D7), so the watchdog gives room back before it stops a
	// claim; nil: it reclaims none.
	DiskReclaim DiskReclaimer
	// ExitedServices names the services that exited, for a probe that got no
	// answer; nil: the cell announces no serviceStates feature.
	ExitedServices ExitedServiceReader
}

// Bakes says the driver builds environment images (image.bake).
func (p Parts) Bakes() bool { return p.Baker != nil }

// SnapshotsMemory says the driver keeps and restores a machine's memory: its
// bake is a memory template (hello capabilities.snapshotMemory).
func (p Parts) SnapshotsMemory() bool { return p.Snapshots != nil }

// SandboxMemoryMB is what one code sandbox of size is counted for: the
// driver's own figure when it has a SandboxMemory part, else the size's
// memory, else the default claim's boot memory (the machine a sandbox of no
// size gets). Zero without a Memory part.
func (p Parts) SandboxMemoryMB(size ClaimSize) int {
	switch {
	case p.Memory == nil:
		return 0
	case p.SandboxMemory != nil:
		return p.SandboxMemory.SandboxMemoryMB(size)
	case size.MemoryMB > 0:
		return size.MemoryMB
	}
	return p.Memory.ClaimMemory(size).BootMB
}
