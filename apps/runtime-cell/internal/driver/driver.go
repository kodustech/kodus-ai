// Package driver is the MachineDriver contract
// (docs/runtime/isolation-architecture.md, ADR-027): the only
// thing a cell knows about the cloud or cluster it runs in.
package driver

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"sort"
	"time"
)

type Isolation string

const (
	IsolationVM                 Isolation = "vm"
	IsolationMicroVM            Isolation = "microvm"
	IsolationSandboxedContainer Isolation = "sandboxed-container"
	// IsolationNone is the dev-only local-docker driver: the workload runs on
	// the developer's Docker with no boundary at all. Never in production:
	// the agent takes it only with Config.DevAllowInsecureIsolation.
	IsolationNone Isolation = "none"
)

// ProductionIsolation reports whether a production cell may run this driver.
func ProductionIsolation(i Isolation) bool {
	switch i {
	case IsolationVM, IsolationMicroVM, IsolationSandboxedContainer:
		return true
	case IsolationNone:
		return false
	}
	return false
}

// Capabilities are the facts a driver states about its machines. What it can
// do beyond the MachineDriver core (bake, memory snapshots, sandboxes) is
// not a flag here: it is a non-nil field of its Parts.
type Capabilities struct {
	Isolation        Isolation
	NestedContainers bool
	Arch             []string
	// MaxClaimSize is the largest ClaimSize the driver grants one claim's
	// workload. Zero: it grants none, and refuses every spec that asks one.
	MaxClaimSize ClaimSize
	// DefaultClaimSize is the size a claim that asks none runs at (hello
	// capabilities.defaultSize); zero when the driver does not say.
	DefaultClaimSize ClaimSize
	// Backends are the isolation backends the driver runs machines with
	// (internal/isolation: "gvisor", "firecracker"); empty for a driver that
	// is not split into one (hello capabilities.backends).
	Backends []string
	// KVM: the cell's host gives it a usable /dev/kvm.
	KVM bool
	// HostArch is the architecture the driver's machines run on this host
	// ("x86_64", "arm64"); empty: the cell's own (hello capabilities.arch).
	HostArch string
	// SandboxCellTrust: the driver's code sandboxes take the cell's trust
	// files (SandboxRequest.CellTrust). False: it refuses a sandbox that
	// asks them, and the agent never asks.
	SandboxCellTrust bool
	// ShareBakes: the driver pushes each image of its bakes to the org's
	// registry and pulls another cell's by digest (UpRequest.SharedImages,
	// BakeSpec.Shared; docs/runtime/shared-baked-environments.md). The cell
	// names hello feature bakeShare only then.
	ShareBakes bool
	// ExecService: the driver runs a command in the container of the
	// compose service a request names (kodyexec.Request.Service). The cell
	// names hello feature execService only then.
	ExecService bool
}

// ClaimSize is the memory and CPUs a claim asked for its workload
// (claim.acquire size): what each of its builds and services gets in
// place of the driver's default. The zero value is the driver's default.
type ClaimSize struct {
	MemoryMB int
	CPUs     int
}

func (s ClaimSize) IsZero() bool { return s == ClaimSize{} }

func (s ClaimSize) String() string { return fmt.Sprintf("%d MB / %d CPUs", s.MemoryMB, s.CPUs) }

// ErrSizeUnavailable is a claim size above what the cell grants: the
// blocker is resources/size_unavailable, a smaller size or a larger cell,
// never a retry.
var ErrSizeUnavailable = errors.New("driver: the machine size is above what this cell grants")

// ErrDiskCapacity is a machine the cell's disk cannot hold at its disk
// ceiling next to the machines it already holds: the cell's capacity, never
// the claim's code.
var ErrDiskCapacity = errors.New("driver: the cell's disk cannot hold another machine")

// Within refuses a size above ceiling in memory or CPUs, or a negative one, with
// ErrSizeUnavailable. The zero size always fits.
func (s ClaimSize) Within(ceiling ClaimSize) error {
	if s.IsZero() {
		return nil
	}
	if s.MemoryMB < 0 || s.CPUs < 0 || s.MemoryMB > ceiling.MemoryMB || s.CPUs > ceiling.CPUs {
		if ceiling.IsZero() {
			return fmt.Errorf("%w: asked %s, this cell grants no machine size", ErrSizeUnavailable, s)
		}
		return fmt.Errorf("%w: asked %s, this cell grants at most %s", ErrSizeUnavailable, s, ceiling)
	}
	return nil
}

// BootTiming is how long a driver's last boot or reset of a claim's
// workload took, per phase, in ms (zero when the phase did not run).
type BootTiming struct {
	Kind    string // boot | reset
	At      time.Time
	TotalMs int64
	DownMs  int64
	BuildMs int64
	UpMs    int64
	SeedMs  int64
	ReadyMs int64
	// SnapshotMs is copying the data volumes after the first ready boot,
	// RestoreMs a reset copying them back (data.reset: snapshot).
	SnapshotMs int64
	RestoreMs  int64
	// BuildSteps is where the boot's image builds spent their time; nil
	// when nothing was built or the driver does not measure it.
	BuildSteps *BuildSteps
	// Phases is the whole boot in words, slowest first, all of them (the
	// agent bounds the list to MaxPhases once it has added its own and what
	// none measured):
	// each build's base image pull, RUN, COPY and export parts, moving the
	// image into Docker, compose up and the services' first healthy answer
	// (MergePhases). Nil when the driver does not measure them.
	Phases []BootPhase
}

// MaxPhases is how many phases a boot reports.
const MaxPhases = 8

// BootPhase is one part of a boot and how long it took. Running: it had
// not ended when the boot stopped (a claim that reached its ceiling).
type BootPhase struct {
	Name    string
	Ms      int64
	Running bool
}

// MergePhases adds up phases of the same name (two services that both ran
// "yarn install", both exported their layers), slowest first, at most limit
// (limit < 0: all). Phases with no name or no time are left out.
func MergePhases(limit int, lists ...[]BootPhase) []BootPhase {
	sums := map[string]int{}
	var out []BootPhase
	for _, l := range lists {
		for _, p := range l {
			if p.Name == "" || p.Ms <= 0 {
				continue
			}
			if i, ok := sums[p.Name]; ok {
				out[i].Ms += p.Ms
				out[i].Running = out[i].Running || p.Running
				continue
			}
			sums[p.Name] = len(out)
			out = append(out, p)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Ms > out[j].Ms })
	if limit >= 0 && len(out) > limit {
		out = out[:limit]
	}
	return out
}

// BuildSteps is a boot's image builds, step by step, as BuildKit measured
// them: counts over every build, and the slowest steps that ran (not
// cached), slowest first. A step's name is its Dockerfile line, already
// redacted and bounded; no output of a step is kept.
type BuildSteps struct {
	Steps, Done, Cached, Errored int
	Slowest                      []BuildStep
	// Phases are the builds in words (BootTiming.Phases), every one of
	// them: the boot merges them with its own and keeps the slowest.
	Phases []BootPhase
}

// BuildStep is one step of one service's build.
type BuildStep struct {
	Service, Name string
	Ms            int64
}

// BootPhaser is a driver that says where a claim's last boot spent its
// time in words (BootTiming.Phases), also of a boot that failed or was
// stopped at the claim's ceiling.
type BootPhaser interface {
	BootPhases(claimID string) ([]BootPhase, bool)
}

// EvictedBuildState is an environment whose build state the cell's disk
// floor removed and no setup of its default branch made again: its builds
// run with no state until one does.
type EvictedBuildState struct {
	Org, Env string
	At       time.Time
	// Rebuild is how long the build that made the state from none took;
	// zero: not measured.
	Rebuild time.Duration
	// FreeBytes is what the volume had free when the floor removed the
	// state, FloorBytes the floor; zero: not recorded.
	FreeBytes, FloorBytes int64
}

// BuildStateReporter is a driver that keeps environments' build states and
// says which its eviction removed (docker-gvisor).
type BuildStateReporter interface {
	EvictedBuildStates() []EvictedBuildState
}

// BootTimer is a driver that measures its boot phases (local-docker).
type BootTimer interface {
	BootTiming(claimID string) (BootTiming, bool)
}

type MachineSize struct {
	CPU      int
	MemoryGB int
	DiskGB   int
}

type BakeSpec struct {
	// CellID and OrgID tag every image and snapshot the bake makes
	// (SnapshotTags): a reset refuses a snapshot without them.
	CellID        string
	EnvironmentID string
	OrgID         string
	RecipeSHA     string
	// SHA is the default-branch commit the image is built from (S-52); a
	// bake never starts from a machine that ran a PR.
	SHA string
	// RefsDigest is the bake key of an environment of several repositories
	// (image.bake refsDigest): every repository's commit and the recipe.
	// Empty for one repository, whose key is SHA.
	RefsDigest string
	BaseImage  string
	KMSKeyRef  string
	Size       MachineSize
	// Source is the workload machine of the clean setup claim the bake was
	// asked on, when there is one: the agent checked it never ran PR code
	// (S-52). A driver that bakes from what that machine built
	// (BakeSourcePinner) needs it; one that boots its own machine ignores it.
	Source MachineRef
	// Secrets are the exact values the cell knows of the setup claim (its
	// redactor's list and its org secrets' placeholders). A driver that
	// shares its bakes (Capabilities.ShareBakes) pushes no image that
	// carries one.
	Secrets []string
	// Shared, when set, is called once, off the bake's path, with the images
	// a driver that shares its bakes pushed to the org's registry; never
	// when it pushed none. Nil: nobody listens.
	Shared func(SharedBake)
}

// SharedImage is one service image of a bake in the org's registry: the
// build fingerprint a claim matches it by and its manifest digest, the only
// name a cell pulls it by (docs/runtime/shared-baked-environments.md).
type SharedImage struct {
	Fingerprint, Digest string
}

// SharedBake is what one bake pushed (image.shared): the bake's key and its
// images.
type SharedBake struct {
	OrgID, EnvironmentID, SHA, RefsDigest, RecipeSHA string
	Images                                           []SharedImage
}

// BakeSourcePinner is a driver that bakes from what the clean setup claim's
// machine already built (docker-gvisor: the images its build sections
// produced). The agent pins the machine when it accepts image.bake, before
// the claim can be released, so the machine's Destroy leaves that output to
// the bake. Bake then consumes the pin, whether it succeeds or not.
type BakeSourcePinner interface {
	PinBakeSource(ctx context.Context, ref MachineRef) error
}

type ImageRef struct {
	ImageID   string
	DriverRef string // AMI on EC2
}

// BakeCatalog recovers only verified clean image eligibility, never machines,
// leases, execution deduplication or per-claim credentials.
type BakeCatalog interface {
	RecoverBakes(context.Context) ([]RecoveredBake, error)
	AcknowledgeBake(context.Context, string) error
}

type RecoveredBake struct {
	ImageID, OrgID, EnvironmentID, SHA string
	Current                            bool
}

type Role string

const (
	RoleWorkload Role = "workload"
	RoleObserver Role = "observer"
	RolePool     Role = "pool"
)

type MachineSpec struct {
	CellID        string
	EnvironmentID string
	Role          Role
	OrgID         string
	ClaimID       string
	ImageID       string
	ImageRef      string // driver reference of the image (AMI)
	Size          MachineSize
	// ClaimGroupID is the claim's network boundary for this machine, from
	// ClaimNetwork: a security group on EC2, a network on Docker, a network
	// policy group on Kubernetes.
	ClaimGroupID  string
	KMSKeyRef     string // the org's key (ADR-055)
	ExpiresAt     time.Time
	HardExpiresAt time.Time // absolute ceiling, never changes (reaper)
	UserData      string    // e.g. the claim's SSH public key
	// Setup marks the machine of a setup claim that runs no PR code: what it
	// builds may become the environment's (its bake, its build cache). A
	// machine without it only ever reads what the environment has.
	Setup bool
	// Secrets: the claim hands the machine the org's secrets (their
	// placeholders). A driver that keeps memory snapshots records it before
	// the machine exists, and such a machine never becomes one
	// (docs/runtime/isolation-p3-snapshots.md).
	Secrets bool
	// SeedsCache, on a Setup machine: the setup builds the default branch,
	// so each build's cache becomes the environment's as soon as the build
	// finishes, not only at a bake (a setup that fails after its build
	// leaves the next one the layers).
	SeedsCache bool
	// ClaimSize is the size the claim asked for its workload; zero is the
	// driver's default. Create refuses one above Capabilities().MaxClaimSize
	// (ValidateFor).
	ClaimSize ClaimSize
	Tags      map[string]string
}

type MachineRef struct {
	MachineID      string
	DriverRef      string
	PrivateAddress string
	// ImageID as the cloud API describes it, never as the guest reports it.
	ImageID string
	Tags    map[string]string
}

type SnapshotRef struct {
	Kind string // compose_volumes | disk
	Ref  string
}

// SuspendMode is how a driver that suspends machines (microvm)
// keeps one: nothing in the cell suspends a machine yet, so it is no part
// of the contract until the hibernated pool (ADR-004) asks for it.
type SuspendMode string

const (
	SuspendStop      SuspendMode = "stop"
	SuspendHibernate SuspendMode = "hibernate"
)

// ExposePort is one entry of claim.acquire's expose list.
type ExposePort struct {
	Service string
	Port    int
	Kind    string
}

type ClaimNetworkSpec struct {
	CellID  string
	OrgID   string
	ClaimID string
	Expose  []ExposePort
	// ObserverPort is where the observer's API listens for the cell agent.
	ObserverPort int
}

// ClaimNetwork is the per-claim isolation: the workload accepts 22 only from
// the cell agent and the expose ports only from this claim's observer; no
// group ever references itself (S-02).
type ClaimNetwork struct {
	WorkloadGroupID string
	ObserverGroupID string
	// EgressAddress, on a claim network with no route out (docker-gvisor),
	// is where the claim reaches the cell's proxy and resolver: the
	// machines resolve through it and the resolver steers every allowed name
	// to it. Empty when the network itself routes to them.
	EgressAddress string
	// Sources are addresses the driver itself uses for the claim on this
	// network (docker-gvisor's image builder): they join the claim's policy
	// from the start, so what they fetch goes through the same allowlist.
	Sources []string
	// SourcesTrustCellCA: what runs at Sources trusts the cell CA (the
	// builder's RUN steps get the cell's trust bundle), so the claim's policy
	// inspects their TLS like a machine's instead of refusing it.
	SourcesTrustCellCA bool
}

// MachineDriver is what a cell asks of its cloud or cluster. Every driver
// keeps the same contract, and drivertest.Run checks it:
//   - Create refuses a spec ValidateFor(Capabilities()) refuses or a claim
//     id ValidateClaimID refuses, before it calls the backend, and stamps
//     AllTags on the machine.
//   - List returns only this cell's machines, whatever the selector names.
//   - SetExpiry never moves past kodus:hard-expires and never changes it.
//   - Destroy is idempotent and refuses another cell's machine with
//     ErrNotOwned; SetExpiry refuses it too; ReleaseClaim does the same for
//     networks.
//
// Anything more a driver can do is an optional part of its Parts, never a
// method every driver must stub.
type MachineDriver interface {
	Describer
	ClaimNetworker
	MachineCreator
	MachineKeeper
}

// The driver's contract, by what a caller needs of it. A package that uses
// part of a driver asks for that part (lease.Machines), not the whole.

// Describer says what the driver is and what it can do.
type Describer interface {
	Kind() string
	Capabilities() Capabilities
}

// ClaimNetworker makes and releases a claim's network.
type ClaimNetworker interface {
	PrepareClaim(ctx context.Context, spec ClaimNetworkSpec) (ClaimNetwork, error)
	ReleaseClaim(ctx context.Context, net ClaimNetwork) error
}

// MachineCreator creates a machine.
type MachineCreator interface {
	Create(ctx context.Context, spec MachineSpec) (MachineRef, error)
}

// MachineKeeper is what keeping a machine alive, finding it and ending it
// needs: the lease, the sweep and the reaper.
type MachineKeeper interface {
	Destroy(ctx context.Context, ref MachineRef) error
	List(ctx context.Context, selector map[string]string) ([]MachineRef, error)
	// SetExpiry moves kodus:expires with claim.renew. It never touches
	// kodus:hard-expires.
	SetExpiry(ctx context.Context, ref MachineRef, expiresAt time.Time) error
}

// MemorySnapshot is a machine's memory snapshot as the agent names it
// (docs/runtime/isolation-p3-snapshots.md): its id, its org and its purpose
// (template, session or round, as claim.snapshot names them).
type MemorySnapshot struct {
	ID, OrgID, Purpose string
}

// SessionForgetter removes an org's session snapshot at once (its PR
// closed): only a session, never a template or a round; one this cell does
// not hold is already gone.
type SessionForgetter interface {
	ForgetSession(ctx context.Context, orgID, snapshotID string) error
}

// Snapshotter is a driver that keeps machines as memory snapshots. The
// rules of what may become one (a machine handed secrets never does, but
// for its own claim's round) are the driver's backend's, read from what it
// recorded when it made the machine.
type Snapshotter interface {
	// SnapshotMachine keeps this cell's machine for purpose, key being a
	// template's key in its org. A template or a session ends the machine;
	// a round brings it back at once in its place and returns it.
	SnapshotMachine(ctx context.Context, ref MachineRef, purpose, key string) (MemorySnapshot, MachineRef, error)
	// LatestTemplate is org's newest template of key this cell can restore
	// into a sandbox; ok false when it holds none.
	LatestTemplate(ctx context.Context, orgID, key string) (MemorySnapshot, bool, error)
	// CreateSandboxFromSnapshot makes req.Spec's sandbox from a template or
	// a session of its org.
	CreateSandboxFromSnapshot(ctx context.Context, req SandboxRequest, snap MemorySnapshot) (MachineRef, error)
	// ResetToSnapshot ends the machine and restores it in its place from its
	// claim's round snapshot (machine.reset kind memory).
	ResetToSnapshot(ctx context.Context, ref MachineRef, snap MemorySnapshot) (MachineRef, error)
}

// MachineResetter brings a machine back to a snapshot between rounds.
type MachineResetter interface {
	Reset(ctx context.Context, ref MachineRef, snap SnapshotRef) error
}

// Baker makes an environment image.
type Baker interface {
	Bake(ctx context.Context, spec BakeSpec) (ImageRef, error)
}

const (
	TagCell        = "kodus:cell"
	TagEnv         = "kodus:env"
	TagOrg         = "kodus:org"
	TagClaim       = "kodus:claim"
	TagRole        = "kodus:role"
	TagExpires     = "kodus:expires"
	TagHardExpires = "kodus:hard-expires"
)

// ReservedTags are the tags only a driver writes, from the spec.
var ReservedTags = []string{TagCell, TagEnv, TagOrg, TagClaim, TagRole, TagExpires, TagHardExpires}

// ErrUnsupported is a driver asked for something it does not offer (a
// sandbox with the cell's trust on a driver whose SandboxCellTrust is false,
// a reset kind it has no snapshot of).
// The agent tells it from a failure: it is a fact about the driver, not a
// fault to retry.
var ErrUnsupported = errors.New("driver: not supported by this driver")

// ErrWorkloadBoot marks a boot that failed in the checkout's own project
// (its build, its containers, its seed, its health check), not on the cell:
// the claim's blocker is then the repository's (toolchain, compose_up), so
// the product reads the services' logs for the cause instead of offering a
// retry as if Kodus had failed. errors.Is finds it; the message is the
// failure's own.
var ErrWorkloadBoot = errors.New("driver: the workload's own project did not come up")

// ErrOutOfMemory marks a build or service the sandbox killed for passing
// its memory limit (exit 137): the blocker is resources/out_of_memory, a
// machine size to raise or a build to trim, never a retry.
var ErrOutOfMemory = errors.New("driver: the workload ran out of memory")

// ErrBuilderFailed marks an image build whose builder ended without BuildKit
// saying a step of the build failed: docker could not run the builder (exit
// 125 to 127), or the builder died while steps were still running. The
// project's code did not fail, so the blocker is the platform's, never the
// recipe's.
var ErrBuilderFailed = errors.New("driver: the image builder failed outside the build's steps")

// ErrImageLoad marks a built image the cell could not take: the builder's
// output was not exactly the one image it was asked for, or the host's
// Docker did not load it. The blocker is the platform's.
var ErrImageLoad = errors.New("driver: the built image was refused or did not load")

// ErrImageTooLarge marks a build whose output passed the cell's bound on
// what one build may leave on its disk: resources, an image to trim.
var ErrImageTooLarge = errors.New("driver: the built image is larger than this cell allows")

// ErrWorkloadRecipe marks a boot refused because of the checkout's recipe
// (it does not parse, or holds what a recipe never may): the repository's
// recipe_outdated, as on a driver that loads the recipe in the agent.
var ErrWorkloadRecipe = errors.New("driver: the checkout's recipe is refused")

type workloadError struct{ mark, err error }

func (e workloadError) Error() string        { return e.err.Error() }
func (e workloadError) Unwrap() error        { return e.err }
func (e workloadError) Is(target error) bool { return target == e.mark }

// WorkloadBootFailed marks err as ErrWorkloadBoot; nil stays nil.
func WorkloadBootFailed(err error) error {
	if err == nil {
		return nil
	}
	return workloadError{ErrWorkloadBoot, err}
}

// WorkloadRecipeRefused marks err as ErrWorkloadRecipe; nil stays nil.
func WorkloadRecipeRefused(err error) error {
	if err == nil {
		return nil
	}
	return workloadError{ErrWorkloadRecipe, err}
}

// ErrHardExpiresImmutable is returned by any attempt to change the ceiling.
var ErrHardExpiresImmutable = errors.New("kodus:hard-expires is written at creation and never changes")

// FormatTime is how expiry tags are written: RFC 3339, UTC, seconds.
func FormatTime(t time.Time) string { return t.UTC().Format(time.RFC3339) }

// A machine's life has two ends, read only through the functions below.
//
// kodus:hard-expires is the ceiling: written once at creation
// (MachineSpec.AllTags), never moved. Every sweep honors it whatever
// renewed the machine: the lease manager's, a driver's (Sweeper) and the
// reaper's. A machine whose ceiling is missing or does not parse is already
// past it: a machine nobody can date is a machine nobody owns.
//
// kodus:expires is the lease's end, which claim.renew moves under the
// ceiling. Only the lease manager destroys at it (LeaseLapsed), since only
// it knows which claims the hub still renews. A driver's sweep and the
// reaper never read it: some drivers keep it only in the cell's memory,
// which a restart loses.

// ErrNoCeiling is a machine whose backend carries no kodus:hard-expires that
// parses: it cannot be renewed, and every sweep takes it.
var ErrNoCeiling = errors.New("driver: the machine carries no ceiling (kodus:hard-expires)")

// Ceiling is the machine's kodus:hard-expires; false when it is missing or
// does not parse, which every caller treats as already passed.
func Ceiling(tags map[string]string) (time.Time, bool) {
	return parseTag(tags, TagHardExpires)
}

// Expired says the machine is past its ceiling at now, or has none.
func Expired(tags map[string]string, now time.Time) bool {
	ceiling, ok := Ceiling(tags)
	return !ok || !now.Before(ceiling)
}

// ClampToCeiling is at, held at the ceiling backendTags carry. backendTags
// are what the driver read from its backend, never a caller's ref, which can
// say any ceiling. ErrNoCeiling when the backend carries none.
func ClampToCeiling(at time.Time, backendTags map[string]string) (time.Time, error) {
	ceiling, ok := Ceiling(backendTags)
	if !ok {
		return time.Time{}, ErrNoCeiling
	}
	if at.After(ceiling) {
		return ceiling, nil
	}
	return at, nil
}

// LeaseEnd is the machine's kodus:expires; false when it is missing or does
// not parse.
func LeaseEnd(tags map[string]string) (time.Time, bool) {
	return parseTag(tags, TagExpires)
}

// LeaseLapsed says the machine's kodus:expires passed at now, or it has none
// that parses. Only the lease manager destroys at it (see above).
func LeaseLapsed(tags map[string]string, now time.Time) bool {
	end, ok := LeaseEnd(tags)
	return !ok || !now.Before(end)
}

func parseTag(tags map[string]string, key string) (time.Time, bool) {
	t, err := time.Parse(time.RFC3339, tags[key])
	if err != nil {
		return time.Time{}, false
	}
	return t, true
}

// Sweeper is a driver that removes, on its own, this cell's machines past
// their ceiling (Expired): what a crashed or killed cell left. cmd/cell runs
// it at start and every minute. It returns the machines it destroyed.
type Sweeper interface {
	Sweep(ctx context.Context, now time.Time) ([]string, error)
}

// SnapshotTags are the tags of every image or disk snapshot a bake makes:
// whose cell and org it is. A reset takes only a snapshot of this cell and
// of the machine's org (a driver's Reset refuses any other).
func SnapshotTags(spec BakeSpec) map[string]string {
	return map[string]string{TagCell: spec.CellID, TagOrg: spec.OrgID, TagEnv: spec.EnvironmentID}
}

// Validate refuses a spec that would create a machine nobody can reap.
func (s MachineSpec) Validate() error {
	switch {
	case s.CellID == "":
		return errors.New("machine spec: cellId required")
	case s.OrgID == "" || s.ClaimID == "":
		return errors.New("machine spec: orgId and claimId required")
	case s.Role != RoleWorkload && s.Role != RoleObserver && s.Role != RolePool:
		return fmt.Errorf("machine spec: bad role %q", s.Role)
	case s.HardExpiresAt.IsZero():
		return errors.New("machine spec: hardExpiresAt required")
	case s.ExpiresAt.IsZero() || s.ExpiresAt.After(s.HardExpiresAt):
		return errors.New("machine spec: expiresAt must be set and not after hardExpiresAt")
	case s.ClaimGroupID == "":
		return errors.New("machine spec: per-claim group required")
	case s.KMSKeyRef == "":
		return errors.New("machine spec: org KMS key required")
	}
	for k := range s.Tags {
		if slices.Contains(ReservedTags, k) {
			return fmt.Errorf("machine spec: tag %s is reserved", k)
		}
	}
	return nil
}

// ValidateFor is Validate plus what the driver's capabilities bound: a
// claim size above MaxClaimSize is refused before anything is created.
func (s MachineSpec) ValidateFor(c Capabilities) error {
	if err := s.Validate(); err != nil {
		return err
	}
	return s.ClaimSize.Within(c.MaxClaimSize)
}

// AllTags is every tag a machine is born with, reserved ones last so a
// caller's tag can never overwrite them.
func (s MachineSpec) AllTags() map[string]string {
	out := map[string]string{}
	for k, v := range s.Tags {
		out[k] = v
	}
	out[TagCell] = s.CellID
	out[TagEnv] = s.EnvironmentID
	out[TagOrg] = s.OrgID
	out[TagClaim] = s.ClaimID
	out[TagRole] = string(s.Role)
	out[TagExpires] = FormatTime(s.ExpiresAt)
	out[TagHardExpires] = FormatTime(s.HardExpiresAt)
	return out
}

// Matches reports whether tags carry every key/value of the selector.
func Matches(tags, selector map[string]string) bool {
	for k, v := range selector {
		if tags[k] != v {
			return false
		}
	}
	return true
}

// DiskUsageReader says how many bytes each claim holds on the disk the
// cell's Docker writes (its volumes and its containers' writable layers),
// by claim ID. It may be slow (it measures every volume): the watchdog asks
// only with the disk under its margin.
type DiskUsageReader interface {
	ClaimDiskUsage(ctx context.Context) (map[string]int64, error)
}

// BuildCachePruner drops the host's build cache that no live build holds
// (BuildKit never removes a record a running build uses), the records not used
// for olderThan or longer; zero drops all of them. It returns the bytes freed.
// The disk watchdog calls it oldest first before it stops a claim.
type BuildCachePruner interface {
	PruneBuildCache(ctx context.Context, olderThan time.Duration) (int64, error)
}

// Diagnoser is a driver that can tell why a setup failed when its blocker
// does not explain it: service states, the last log
// lines of each service, the exposed ports and the disk. The agent redacts
// what it returns before it leaves the cell.
type Diagnoser interface {
	Diagnose(ctx context.Context, claimID string, ref MachineRef, expose []ExposePort) (Diagnostics, error)
}

// HealthReader reads a workload machine's health for a step's result
// (step.result vmHealth): whether it still runs, and how many processes its
// kernel has killed for memory since it booted (a counter, compared around
// a step). Only this cell's machines.
type HealthReader interface {
	MachineHealth(ctx context.Context, ref MachineRef) (MachineHealth, error)
}

// MachineHealth is HealthReader's answer.
type MachineHealth struct {
	Running  bool
	OOMKills uint64
}

// CoverageFlusher has a Run's instrumented services write the V8 coverage
// they have so far (SIGUSR2 to the preload NODE_OPTIONS requires) without
// stopping them, for claim.exercised (feature exercisedLines): only
// services, the ones UpRequest.Coverage named. Only this cell's workload
// machines.
//
// CoverageServices are the services the machine's last Up instrumented:
// UpRequest.Coverage.Services and the built ones the driver found running
// Node (nil: none, or no coverage asked).
type CoverageFlusher interface {
	FlushCoverage(ctx context.Context, ref MachineRef, services []string) error
	CoverageServices(ref MachineRef) []string
}

// ServiceLogReader reads what a claim's services logged in a window, each
// line with the daemon's timestamp (compose logs --timestamps --since
// --until): a probe round's service logs (EVIDENCE-CAPTURE-DESIGN). Raw
// lines from untrusted code: the agent redacts and caps them before any
// leaves the cell. Only this cell's machines.
type ServiceLogReader interface {
	ServiceLogs(ctx context.Context, claimID string, ref MachineRef, since, until time.Time, maxLines int) ([]ServiceLogLine, error)
}

// ServiceLogLine is one line a service logged, as the daemon timed it.
type ServiceLogLine struct {
	Service string
	At      time.Time
	Text    string
}

type Diagnostics struct {
	Services []ServiceDiagnostics
	Ports    []PortDiagnostics
	Disk     []DiskDiagnostics
}

type ServiceDiagnostics struct {
	Name  string
	State string
	// Log is the tail of the service's log, oldest first.
	Log []string
}

type PortDiagnostics struct {
	Service   string
	Port      int
	Listening bool
}

type DiskDiagnostics struct {
	Path       string
	TotalBytes int64
	FreeBytes  int64
}

// PoolSpec is one clean machine to keep ready for an environment: made
// from the environment's bake (ImageID), never from a claim (S-52).
type PoolSpec struct {
	CellID        string
	OrgID         string
	EnvironmentID string
	ImageID       string
	KMSKeyRef     string
	Size          MachineSize
	// ClaimSize is the environment's machine size (pool.target
	// machineSize), made as MachineSpec.ClaimSize is; zero is the default.
	ClaimSize ClaimSize
	// ExpiresAt and HardExpiresAt bound the pool machine; a claim adopts
	// it only when its own ceiling is not later than HardExpiresAt.
	ExpiresAt     time.Time
	HardExpiresAt time.Time
}

// PoolMachine is a ready machine and the network it lives on.
type PoolMachine struct {
	Network       ClaimNetwork
	Workload      MachineRef
	OrgID         string
	EnvironmentID string
	ImageID       string
	HardExpiresAt time.Time
	// ClaimSize is the size the driver made the machine at: only a claim of
	// that size adopts it. A driver that leaves it zero made a default one.
	ClaimSize ClaimSize
}

// Pooler is a driver that keeps clean machines ready (docker-gvisor). A
// pool machine is used once: the claim that adopts it destroys it on
// release, and it never goes back to the pool.
type Pooler interface {
	PoolCreate(ctx context.Context, spec PoolSpec) (PoolMachine, error)
	// Adopt hands the pool machine to claimID: from then on the claim's
	// network is the machine's, and Create accepts it for the claim's
	// other machines. The machine keeps its pool tags; the cell keeps the
	// claim -> machine binding.
	Adopt(ctx context.Context, p PoolMachine, claimID string) error
}

// ReadySettler is, on a driver with a MemoryBudget, what enforces a smaller ceiling
// once a claim is ready: SettleReady lowers what the claim of ref may use to what
// it holds plus room and returns that, in MB, for admission to count from
// then on (0: nothing lowered, count ClaimMemory's ReadyMB). The enforced
// ceiling is lowered before it returns, never after; on an error the claim
// stays counted as it was.
type ReadySettler interface {
	SettleReady(ctx context.Context, ref MachineRef) (mb int, err error)
}

// ClaimMemory is what one claim is counted for on a cell that shares its
// host memory between claims (ADR-070), in MB: BootMB while it boots (its
// builds run then, each with the claim's memory limit), ReadyMB once it is
// ready (its services only). Counts, not limits: no container gets less.
type ClaimMemory struct {
	BootMB  int
	ReadyMB int
}

// MemoryBudget is a driver whose claims share the cell's own memory
// (docker-gvisor, microvm): the agent admits a claim only when its memory
// fits, and tells the hub (heartbeat memory). A driver whose claims are
// machines of their own has none.
type MemoryBudget interface {
	// ClaimMemory is what a claim of this size (zero: the cell's default)
	// is counted for.
	ClaimMemory(size ClaimSize) ClaimMemory
}

// SandboxBudget is a MemoryBudget whose code sandbox is counted for more
// than the memory its size names: a microVM's VMM and page cache come on
// top of its guest's memory, and a sandbox has no observer machine.
type SandboxBudget interface {
	// SandboxMemoryMB is what one sandbox of this size (zero: the
	// driver's default) is counted for, from its boot to its release.
	SandboxMemoryMB(size ClaimSize) int
}
