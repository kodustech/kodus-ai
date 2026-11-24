package agent

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/coverage"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/evidence"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/pool"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/browser"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/clock"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/hubclient"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/kodyexec"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/metrics"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/observer"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/redact"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/tarball"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/transport"
)

// ClaimInfo is what the agent tells the egress control and the observer
// factory about a claim once its machines exist.
type ClaimInfo struct {
	ClaimID            string
	ObserverGeneration uint64 // private observer configuration, never a public frame
	Acquire            protocol.ClaimAcquireBody
	Workload           driver.MachineRef
	Observer           driver.MachineRef
	Network            driver.ClaimNetwork
	// Sources are more addresses the claim's traffic comes from (the
	// containers of a compose project the driver booted): the claim's
	// egress policy lists them with the workload's and the observer's.
	Sources []string
	// ExtraAllow is the hub's egress.policy allowlist for this claim; it
	// adds to the cell's base allowlist and replaces the previous one.
	ExtraAllow []string
	// ExtraInspect are the hub's approvals made as inspected (each host is
	// on ExtraAllow).
	ExtraInspect []policy.InspectRule
	// Running: the claim's install is done (its build, boot and recipe
	// steps); a PR or base claim then drops the recommended list's install
	// hosts (D4, docs/runtime/egress-allowlist.md §8).
	Running bool
	// GoPins are what the checkout's go.sum pins (module@version).
	GoPins []string
	// ImagePins are the Docker Hub images the checkout's Dockerfiles name.
	ImagePins []string
	// OrgSecrets are the claim's secrets with their placeholders: the
	// policy's Secrets (org_secrets.go). Never a value.
	OrgSecrets []policy.Secret
	// CellTrusted: the claim's own boot gave its machines the cell CA, so
	// TLS from them to an inspected host may end at the injector
	// (policy.ClaimPolicy.InspectSources). A pool machine booted before the
	// claim never has it.
	CellTrusted bool
	// Sealed: the claim's egress is closed for good (egress.policy sealed):
	// its policy allows nothing, whatever the lists above and the cell's say.
	Sealed bool
}

// ObserverFactory returns the client for a claim's observer machine.
type ObserverFactory func(ctx context.Context, c ClaimInfo, targets []observer.Target) (observer.Client, error)

// RepoSource gives the tarball URL of the claim's environment at its SHA.
type RepoSource func(acq protocol.ClaimAcquireBody) (string, error)

// ClaimKeyer is a transport that needs per-claim keys (SSH): it returns the
// user-data that gives the workload its keys, and forgets them on release.
type ClaimKeyer interface {
	PrepareClaim(claimID string) (userData string, err error)
	Forget(claimID string)
}

// EgressControl pushes the claim's signed policy to the proxy and resolver.
// Apply is called again for the same claim when the hub sends a new
// egress.policy; the pushed policy replaces the previous one.
type EgressControl interface {
	Apply(ctx context.Context, c ClaimInfo) error
	Remove(ctx context.Context, claimID string) error
}

// ManifestSource is a driver that knows what it booted for a claim (the
// recipe's services, the expose list it published, the seed hash):
// claim.ready carries that manifest instead of the one built from
// claim.acquire.
type ManifestSource interface {
	Manifest(claimID string) (protocol.Manifest, bool)
}

// ClaimSecretSource holds exact secret values of a claim (the SSH keys of
// the claim); the agent redacts them from all the claim sends (S-51).
type ClaimSecretSource interface {
	ClaimSecrets(claimID string) []redact.Known
}

// DeniedEgress is one request the proxy or the resolver refused for a claim.
type DeniedEgress struct {
	Host string
	Port int
	At   time.Time
	// Platform: the platform deny list refused it; no approval lifts it.
	Platform bool
}

// DeniedEgressSource remembers what egress it denied, for the failure
// bundle.
type DeniedEgressSource interface {
	Denied(claimID string) []DeniedEgress
}

type Config struct {
	CellID string
	// Host is what a microVM cell found of its KVM host (SMT, KSM, swap,
	// CPU mitigations, microcode, policy), sent in heartbeats to a hub that
	// accepts hostHardening; nil: no such report.
	Host      *protocol.HeartbeatBodyHost
	Regions   []string
	Owner     protocol.CellOwner
	MaxClaims int
	// MaxClaimSteps bounds active exec, probe and reset work per claim.
	// Zero selects DefaultMaxClaimSteps; explicit limits are 1 through 64.
	MaxClaimSteps int

	// ServiceEnv is the environment every running service gets unless its
	// compose file or the recipe sets the name: the cell mirror's addresses
	// (buildmirror.Mirror.Args), so a test that downloads a MongoDB binary or
	// a Prisma engine, or installs a package, at run time reaches the mirror
	// as the build did. Nil: CI=true only.
	ServiceEnv map[string]string

	Driver       driver.MachineDriver
	Transport    transport.Transport
	Observers    ObserverFactory
	Repo         RepoSource
	Extractor    tarball.Extractor
	Revoker      tarball.Revoker
	Egress       EgressControl
	RecipeEgress RecipeEgressValidator
	FakeSupport  bool // this driver materializes the closed recipe fake services
	// ExercisedLines: this cell names exercisedLines and answers
	// claim.exercised (exercised.go): a Run's Node services write V8
	// coverage on a driver with Parts.Coverage; other drivers answer
	// unsupported_driver. cmd/cell turns it on unless -exercised-lines=false.
	ExercisedLines bool
	// CoverageCap bounds each instrumented claim's coverage directory
	// (coverage.DirBytes, coverage.DirFiles); a claim it cannot cap is not
	// instrumented. Nil: coverage.Tmpfs, a tmpfs mounted over it.
	CoverageCap coverage.Capper
	OrgKey      func(orgID string) (string, error)
	// ClaimSecrets returns more exact values the cell knows for a claim
	// (seed passwords, test secrets it injected); they are redacted from
	// everything the claim sends, like the download token (S-51).
	ClaimSecrets func(ClaimInfo) []redact.Known

	// Parts are the driver's optional capabilities (driver.Parts: bake,
	// compose boot and recipe, pool, sandboxes, memory snapshots, memory
	// budget, diagnostics, logs, health, boot timings, observer SQL), given
	// once by the composition root from the driver's own Parts. A nil part
	// is a capability this cell does not have.
	Parts driver.Parts

	// Optional capabilities of the cell that are not the driver's, wired
	// by the composition root; nil is "this cell has none". The agent never
	// discovers a capability by type assertion.
	Keys         ClaimKeyer          // per-claim transport keys (SSH)
	Manifests    ManifestSource      // what the driver booted
	Secrets      []ClaimSecretSource // more exact values to redact
	DeniedEgress DeniedEgressSource  // the failure bundle's denied egress
	// RecoveryContext is the process startup/shutdown context; recovery is
	// additionally capped at 30 seconds. Nil retains the bounded library default.
	RecoveryContext context.Context
	// PoolMax bounds one environment's pool (Parts.Pooler; nil refuses
	// pool.target) and PoolTTL how long a pool machine waits (defaults 4
	// and 4h).
	PoolMax int
	PoolTTL time.Duration
	// Alerts is the injector's alert feed: an exfiltration alert makes its
	// claim a blocker and stops it (watchAlerts).
	Alerts AlertSource
	// DiskWatch is the free-disk watchdog of the filesystem Docker writes
	// to (disk_watch.go); nil: none.
	DiskWatch *DiskWatch
	// EgressAlerts is the proxy's alert feed: a placeholder_leak (a secret's
	// placeholder over plain HTTP) makes its claim a blocker the same way.
	EgressAlerts AlertSource
	// SecretHostDenied is the platform's deny list (netguard.DenyList.Denies):
	// a secret's host it denies is never handed to the claim, and a secret
	// left with no host is dropped (org_secrets.go). Nil denies nothing.
	SecretHostDenied func(host string) bool
	// CellTrust: the driver mounts the cell's trust files (the injector's
	// CA with the public roots, machinetrust) into the machines of a claim
	// with org secrets, or of every claim under InspectEgress, asked in
	// UpRequest.CellTrust and SandboxRequest.CellTrust (org_secrets.go; a
	// sandbox only when the driver's Capabilities.SandboxCellTrust). Such a sandbox is never a
	// blank pool one, made before the claim without them. False: no machine
	// gets them.
	CellTrust bool
	// InspectEgress: the cell inspects the hosts of the inspected tier
	// (docs/runtime/egress-allowlist.md §6), so every claim the cell boots
	// itself gets the trust files too, not only one with org secrets. Only
	// with CellTrust; a blank pool sandbox is then made trusting it too
	// (sandboxPool.Trusted), so one taken from the pool is inspected as well.
	InspectEgress bool
	// Outbound is a claim's egress in a probe round's window, next to its
	// service logs (Parts.ServiceLogs, evidence.go). EvidenceHTTP is the
	// client artifacts are uploaded with (nil: a plain one, 30 s).
	Outbound     evidence.OutboundSource
	EvidenceHTTP *http.Client
	// Browser starts the browser runner per probe round (ADR-071,
	// browser.go); nil: a browser probe goes to the observer, which refuses
	// it with browser_unavailable.
	Browser browser.Runner
	// BrowserExplore is explicit and opt-in: only a preflight-verified native
	// explorer image may advertise this distinct, non-verdict capability.
	BrowserExplore browser.Runner
	// SandboxPool is how many blank sandboxes the cell keeps ready (zero:
	// none), on a driver with code sandboxes (Parts.Sandboxes; nil: the
	// cell names no sandbox feature and refuses them).
	SandboxPool int
	// Preview serves preview URLs (feature preview, preview.go): the tunnel
	// to the edge and the upstream of a preview claim's streams. Nil: the
	// cell names no preview feature and nacks every preview frame.
	Preview *PreviewCapability
	// HostSeal seals this host before it is saved as an environment
	// template's image (cell.seal, host_seal.go). Nil: this cell is not
	// installed in fleet mode and refuses cell.seal.
	HostSeal HostSealer
	// SandboxSize is the size a sandbox that asks none runs at and is
	// counted at, and the size of every blank sandbox (hello
	// capabilities.sandboxSize). It must be within the driver's
	// MaxClaimSize. Zero: the driver's default size, for a driver that
	// grants no size (a sandbox is then counted at the default's full
	// memory, which its machine gets).
	SandboxSize driver.ClaimSize
	// GuestTraceContext sends the step's traceparent to the guest agent on
	// each sandbox.op (-sandbox-guest-trace). Off by default: a guest agent
	// built before the field refuses a frame that carries it, so turn it on
	// once the sandbox image is rebuilt from a commit whose decoder takes it.
	GuestTraceContext bool

	// MemoryAllocatableMB is what the cell may commit to claims (its host
	// memory less a reserve), for a driver whose claims share it
	// (Parts.Memory): a claim is taken only when it fits (ADR-070). Zero,
	// or a driver without a budget: no memory admission, free slots alone,
	// as before.
	MemoryAllocatableMB int
	// RequireMemoryAdmission refuses startup without a usable shared-host
	// budget and enforces capacity even when an older hub lacks cellMemory.
	// Required aggregate resource enforcement enables this explicitly.
	RequireMemoryAdmission bool

	// HubProtocolState is where the agent keeps, after every hello the hub
	// accepts, the protocol the hub chose and the cell protocols it accepts
	// (internal/hubprotocol), for `cell update` to refuse a release that hub
	// would refuse. cmd/cell: <state-dir>/hub-protocol.state. Empty: not kept.
	HubProtocolState string

	WorkDir      string
	InitialLease time.Duration // until the first claim.renew
	WorkloadSize driver.MachineSize
	ObserverSize driver.MachineSize
	// ExecLimits are the rlimits kody-exec puts on every exec (S-09, a
	// second lock under the VM's own limits); zero fields are unset.
	ExecLimits kodyexec.Limits
	// ExecGrace is how long past the step's timeoutMs the cell waits for
	// kody-exec before it calls the VM unreachable (default 30 s).
	ExecGrace time.Duration
	// ReleaseWait bounds how long a release waits for a claim still being
	// prepared to stop (default 2 min); then it tears down what exists.
	ReleaseWait time.Duration

	// DevAllowInsecureIsolation lets a developer cell run a driver with
	// isolation "none" (plain containers: local-docker, the fake driver).
	// cmd/cell sets it only behind that driver's own gate. Never set in
	// production.
	DevAllowInsecureIsolation bool

	// SettleAttempts bounds how many times a claim frame (claim.ready,
	// claim.failed, step.result) is sent until the hub acks it (default 6);
	// SettleBackoff is the first wait between attempts, doubling up to 30 s
	// (default 1 s). A nack ends the retries.
	SettleAttempts int
	SettleBackoff  time.Duration

	Clock   clock.Clock
	Log     *slog.Logger
	NewID   func() string
	Metrics *metrics.Registry
}

// complete checks what the agent cannot run without and fills the defaults
// of what was left unset.
func (cfg *Config) complete() error {
	if cfg.CoverageCap == nil {
		cfg.CoverageCap = coverage.Tmpfs{}
	}
	if cfg.CellID == "" || cfg.Driver == nil || cfg.Transport == nil || cfg.Observers == nil {
		return errors.New("agent: cell id, driver, transport and observers required")
	}
	if cfg.Preview != nil && (cfg.Preview.Service == nil || cfg.Preview.Upstreams == nil) {
		return errors.New("agent: preview needs its service and its upstreams")
	}
	if cfg.Repo == nil || cfg.Extractor == nil || cfg.Revoker == nil || cfg.OrgKey == nil {
		return errors.New("agent: repo source, extractor, revoker and org key required")
	}
	if cfg.RequireMemoryAdmission {
		budget := cfg.Parts.Memory
		if budget == nil || cfg.MemoryAllocatableMB <= 0 {
			return fmt.Errorf("%w: agent requires a shared memory budget and positive allocatable memory", driver.ErrResourceEnforcement)
		}
		mem := budget.ClaimMemory(driver.ClaimSize{})
		if mem.BootMB <= 0 || mem.ReadyMB <= 0 || mem.ReadyMB > mem.BootMB || mem.BootMB > maxReportedMemoryMB {
			return fmt.Errorf("%w: agent requires a usable boot/ready memory budget", driver.ErrResourceEnforcement)
		}
	}
	if !cfg.SandboxSize.IsZero() {
		if cfg.SandboxSize.MemoryMB <= 0 || cfg.SandboxSize.CPUs <= 0 {
			return fmt.Errorf("agent: the sandbox size %s needs both memory and CPUs", cfg.SandboxSize)
		}
		if err := cfg.SandboxSize.Within(cfg.Driver.Capabilities().MaxClaimSize); err != nil {
			return fmt.Errorf("agent: the sandbox size: %w", err)
		}
	}
	if cfg.Log == nil {
		cfg.Log = slog.Default()
	}
	if iso := cfg.Driver.Capabilities().Isolation; !driver.ProductionIsolation(iso) {
		if !cfg.DevAllowInsecureIsolation || iso != driver.IsolationNone {
			return fmt.Errorf("agent: isolation %q is not allowed (ADR-027)", iso)
		}
		cfg.Log.Warn("INSECURE ISOLATION: workloads run with isolation \"none\"; development only, never production (ADR-027)",
			"isolation", iso, "driver", cfg.Driver.Kind())
	}
	cfg.Clock = clock.Or(cfg.Clock)
	if cfg.NewID == nil {
		cfg.NewID = hubclient.NewID
	}
	if cfg.Owner == "" {
		cfg.Owner = protocol.CellOwnerKodus
	}
	if cfg.MaxClaims == 0 {
		cfg.MaxClaims = 20
	}
	if cfg.MaxClaimSteps == 0 {
		cfg.MaxClaimSteps = DefaultMaxClaimSteps
	}
	if cfg.MaxClaimSteps < 1 || cfg.MaxClaimSteps > MaxClaimStepsLimit {
		return fmt.Errorf("agent: max claim steps must be 1..%d", MaxClaimStepsLimit)
	}
	if cfg.PoolMax == 0 {
		cfg.PoolMax = pool.DefaultMax
	}
	if cfg.PoolTTL == 0 {
		cfg.PoolTTL = pool.DefaultTTL
	}
	if cfg.InitialLease == 0 {
		cfg.InitialLease = 5 * time.Minute
	}
	if cfg.ExecGrace == 0 {
		cfg.ExecGrace = 30 * time.Second
	}
	if cfg.ReleaseWait == 0 {
		cfg.ReleaseWait = 2 * time.Minute
	}
	if cfg.WorkloadSize.CPU == 0 {
		cfg.WorkloadSize = driver.MachineSize{CPU: 4, MemoryGB: 16, DiskGB: 60}
	}
	if cfg.ObserverSize.CPU == 0 {
		cfg.ObserverSize = driver.MachineSize{CPU: 2, MemoryGB: 4, DiskGB: 20}
	}
	if cfg.WorkDir == "" {
		cfg.WorkDir = os.TempDir()
	}
	return nil
}
