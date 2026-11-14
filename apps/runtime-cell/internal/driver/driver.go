// Package driver is the MachineDriver contract (docs §4b, ADR-027): the only
// thing a cell knows about the cloud or cluster it runs in.
package driver

import (
	"context"
	"errors"
	"fmt"
	"slices"
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
	}
	return false
}

type Capabilities struct {
	Isolation        Isolation
	NestedContainers bool
	Suspend          string // "hibernate" | "stop" | "none"
	Arch             []string
	// Bake says the driver builds an image from a clean setup machine. A
	// cell whose driver cannot refuses image.bake when it arrives, instead
	// of accepting it and failing in the background.
	Bake bool
	// MaxClaimSize is the largest ClaimSize the driver grants one claim's
	// workload. Zero: it grants none, and refuses every spec that asks one.
	MaxClaimSize ClaimSize
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

// Within refuses a size above max in memory or CPUs, or a negative one, with
// ErrSizeUnavailable. The zero size always fits.
func (s ClaimSize) Within(max ClaimSize) error {
	if s.IsZero() {
		return nil
	}
	if s.MemoryMB < 0 || s.CPUs < 0 || s.MemoryMB > max.MemoryMB || s.CPUs > max.CPUs {
		if max.IsZero() {
			return fmt.Errorf("%w: asked %s, this cell grants no machine size", ErrSizeUnavailable, s)
		}
		return fmt.Errorf("%w: asked %s, this cell grants at most %s", ErrSizeUnavailable, s, max)
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
}

// BuildSteps is a boot's image builds, step by step, as BuildKit measured
// them: counts over every build, and the slowest steps that ran (not
// cached), slowest first. A step's name is its Dockerfile line, already
// redacted and bounded; no output of a step is kept.
type BuildSteps struct {
	Steps, Done, Cached, Errored int
	Slowest                      []BuildStep
}

// BuildStep is one step of one service's build.
type BuildStep struct {
	Service, Name string
	Ms            int64
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
	SHA       string
	BaseImage string
	KMSKeyRef string
	Size      MachineSize
	// Source is the workload machine of the clean setup claim the bake was
	// asked on, when there is one: the agent checked it never ran PR code
	// (S-52). A driver that bakes from what that machine built
	// (BakeSourcePinner) needs it; one that boots its own machine ignores it.
	Source MachineRef
}

// BakeSourcePinner is a driver that bakes from what the clean setup claim's
// machine already built (docker-gvisor: the images its build sections
// produced). The agent pins the machine when it accepts image.bake, before
// the claim can be released, so the machine's Destroy leaves that output to
// the bake. Bake then consumes the pin, whether it succeeds or not.
type BakeSourcePinner interface {
	PinBakeSource(ref MachineRef) error
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
	// to it. Empty when the network itself routes to them (aws-ec2, k8s).
	EgressAddress string
	// Sources are addresses the driver itself uses for the claim on this
	// network (docker-gvisor's image builder): they join the claim's policy
	// from the start, so what they fetch goes through the same allowlist.
	Sources []string
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
//   - What Capabilities says the driver cannot do fails with ErrUnsupported.
type MachineDriver interface {
	Describer
	ClaimNetworker
	MachineCreator
	MachineKeeper
	MachinePauser
	MachineResetter
	Baker
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

// MachinePauser suspends and resumes a machine. Nothing in the cell calls it
// yet: the hibernated pool (ADR-004) will.
type MachinePauser interface {
	Suspend(ctx context.Context, ref MachineRef, mode SuspendMode) error
	Resume(ctx context.Context, ref MachineRef) error
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

// ErrUnsupported is a driver asked for something its Capabilities do not
// offer (suspend on a driver that only destroys, a bake on local-docker).
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

// ParseExpiry reads an expiry tag. A missing or bad tag is "already expired":
// a machine nobody can date is a machine nobody owns.
func ParseExpiry(tags map[string]string, key string) time.Time {
	t, err := time.Parse(time.RFC3339, tags[key])
	if err != nil {
		return time.Time{}
	}
	return t
}

// SnapshotTags are the tags of every image or disk snapshot a bake makes:
// whose cell and org it is. A reset takes only a snapshot of this cell and
// of the machine's org (awsec2 Reset refuses any other).
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

// Diagnoser is a driver that can tell why a setup failed (§11 runbook
// "Setup falha e o Blocker não explica"): service states, the last log
// lines of each service, the exposed ports and the disk. The agent redacts
// what it returns before it leaves the cell.
type Diagnoser interface {
	Diagnose(ctx context.Context, claimID string, ref MachineRef, expose []ExposePort) (Diagnostics, error)
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

// ClaimMemory is what one claim is counted for on a cell that shares its
// host memory between claims (ADR-070), in MB: BootMB while it boots (its
// builds run then, each with the claim's memory limit), ReadyMB once it is
// ready (its services only). Counts, not limits: no container gets less.
type ClaimMemory struct {
	BootMB  int
	ReadyMB int
}

// MemoryBudgetOf is d's MemoryBudget, looking through wrappers (Observed)
// that hide it: a bare type assertion on a wrapped driver turned memory
// admission off without a word on cell-dev-1 (ADR-070).
func MemoryBudgetOf(d MachineDriver) (MemoryBudget, bool) {
	for d != nil {
		if b, ok := d.(MemoryBudget); ok {
			return b, true
		}
		u, ok := d.(interface{ Unwrap() MachineDriver })
		if !ok {
			return nil, false
		}
		d = u.Unwrap()
	}
	return nil, false
}

// MemoryBudget is a driver whose claims share the cell's own memory
// (docker-gvisor): the agent admits a claim only when its memory fits, and
// tells the hub (heartbeat memory). A driver whose claims are machines of
// their own (aws-ec2) has none.
type MemoryBudget interface {
	// ClaimMemory is what a claim of this size (zero: the cell's default)
	// is counted for.
	ClaimMemory(size ClaimSize) ClaimMemory
}
