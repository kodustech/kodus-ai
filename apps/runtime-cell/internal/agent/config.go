package agent

import (
	"context"
	"errors"
	"fmt"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/evidence"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/pool"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/browser"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/clock"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/hubclient"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/kodyexec"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/metrics"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/observer"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/redact"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/tarball"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/transport"
	"log/slog"
	"net/http"
	"os"
	"time"
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
	// GoPins are what the checkout's go.sum pins (module@version).
	GoPins []string
	// ImagePins are the Docker Hub images the checkout's Dockerfiles name.
	ImagePins []string
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
	CellID    string
	Regions   []string
	Owner     protocol.CellOwner
	MaxClaims int
	// MaxClaimSteps bounds active exec, probe and reset work per claim.
	// Zero selects DefaultMaxClaimSteps; explicit limits are 1 through 64.
	MaxClaimSteps int

	Driver       driver.MachineDriver
	Transport    transport.Transport
	Observers    ObserverFactory
	Repo         RepoSource
	Extractor    tarball.Extractor
	Revoker      tarball.Revoker
	Egress       EgressControl
	RecipeEgress RecipeEgressValidator
	FakeSupport  bool // this driver materializes the closed recipe fake services
	SQLObservers driver.SQLObserverProvisioner
	OrgKey       func(orgID string) (string, error)
	// ClaimSecrets returns more exact values the cell knows for a claim
	// (seed passwords, test secrets it injected); they are redacted from
	// everything the claim sends, like the download token (S-51).
	ClaimSecrets func(ClaimInfo) []redact.Known

	// Optional capabilities, wired by the composition root; nil is "this
	// cell has none". The agent never discovers them by type assertion.
	Keys         ClaimKeyer          // per-claim transport keys (SSH)
	Manifests    ManifestSource      // what the driver booted
	BootTimes    driver.BootTimer    // the driver's boot and reset phases
	Diagnoser    driver.Diagnoser    // the failure bundle's service view
	Secrets      []ClaimSecretSource // more exact values to redact
	DeniedEgress DeniedEgressSource  // the failure bundle's denied egress
	// Composer boots the claim's compose project itself (docker-gvisor):
	// the agent hands it the checkout's compose file and adds the
	// containers' addresses to the claim's egress Sources.
	Composer driver.ComposeBooter
	// Recipes runs the recipe's own boot steps (setup, data.migrate,
	// data.seed) in the project Composer brought up; nil: this cell runs
	// none. Set with Composer, by the composition root.
	Recipes driver.RecipeRunner
	// BakePinner is set when the driver bakes from the setup claim's
	// machine (docker-gvisor): image.bake pins that machine's output before
	// the ack, so releasing the claim cannot take it away.
	BakePinner driver.BakeSourcePinner
	// BakeCatalog restores only verified default-branch image eligibility.
	// It does not restore pool holders, claims, credentials or leases.
	BakeCatalog driver.BakeCatalog
	// RecoveryContext is the process startup/shutdown context; recovery is
	// additionally capped at 30 seconds. Nil retains the bounded library default.
	RecoveryContext context.Context
	// Pooler keeps clean machines ready per environment (pool.target);
	// nil refuses pool.target. PoolMax bounds one environment's pool and
	// PoolTTL how long a pool machine waits (defaults 4 and 4h).
	Pooler  driver.Pooler
	PoolMax int
	PoolTTL time.Duration
	// Alerts is the injector's alert feed: an exfiltration alert makes its
	// claim a blocker and stops it (watchAlerts).
	Alerts AlertSource
	// ServiceLogs reads a claim's service logs in a probe round's window;
	// Outbound its egress there (evidence.go). EvidenceHTTP is the client
	// artifacts are uploaded with (nil: a plain one, 30 s).
	ServiceLogs  driver.ServiceLogReader
	Outbound     evidence.OutboundSource
	EvidenceHTTP *http.Client
	// Browser starts the browser runner per probe round (ADR-071,
	// browser.go); nil: a browser probe goes to the observer, which refuses
	// it with browser_unavailable.
	Browser browser.Runner
	// BrowserExplore is explicit and opt-in: only a preflight-verified native
	// explorer image may advertise this distinct, non-verdict capability.
	BrowserExplore browser.Runner

	// MemoryAllocatableMB is what the cell may commit to claims (its host
	// memory less a reserve), for a driver whose claims share it
	// (driver.MemoryBudget): a claim is taken only when it fits (ADR-070).
	// Zero, or a driver without a budget: no memory admission, free slots
	// alone, as before.
	MemoryAllocatableMB int
	// RequireMemoryAdmission refuses startup without a usable shared-host
	// budget and enforces capacity even when an older hub lacks cellMemory.
	// Required aggregate resource enforcement enables this explicitly.
	RequireMemoryAdmission bool

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
	if cfg.CellID == "" || cfg.Driver == nil || cfg.Transport == nil || cfg.Observers == nil {
		return errors.New("agent: cell id, driver, transport and observers required")
	}
	if cfg.Repo == nil || cfg.Extractor == nil || cfg.Revoker == nil || cfg.OrgKey == nil {
		return errors.New("agent: repo source, extractor, revoker and org key required")
	}
	if cfg.RequireMemoryAdmission {
		budget, ok := driver.MemoryBudgetOf(cfg.Driver)
		if !ok || cfg.MemoryAllocatableMB <= 0 {
			return fmt.Errorf("%w: agent requires a shared memory budget and positive allocatable memory", driver.ErrResourceEnforcement)
		}
		mem := budget.ClaimMemory(driver.ClaimSize{})
		if mem.BootMB <= 0 || mem.ReadyMB <= 0 || mem.ReadyMB > mem.BootMB || mem.BootMB > maxReportedMemoryMB {
			return fmt.Errorf("%w: agent requires a usable boot/ready memory budget", driver.ErrResourceEnforcement)
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
