package claims

import (
	"context"
	"errors"
	"log/slog"
	"slices"
	"sync"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/redact"
)

type State int

const (
	// Acquiring: claim.acquire accepted, machines and code on their way.
	Acquiring State = iota
	// Ready: claim.ready sent; steps run.
	Ready
	// Failed: claim.failed sent; nothing runs.
	Failed
	// Held: a failed setup claim kept for diagnosis until its ceiling;
	// only exec runs (§11 runbook).
	Held
	// Released: the cell is tearing the claim down or has.
	Released
)

func (s State) String() string {
	return [...]string{"acquiring", "ready", "failed", "held", "released"}[s]
}

// States lists every state (metrics).
var States = []State{Acquiring, Ready, Failed, Held, Released}

// Machines are what the cell created for the claim.
type Machines struct {
	Network  driver.ClaimNetwork
	Workload driver.MachineRef
	Observer driver.MachineRef
	// Sources are more addresses the claim's traffic comes from: the
	// containers of a compose project the driver booted (ComposeBooter).
	Sources []string
	// GoPins are what the checkout's go.sum pins (module@version): the
	// claim's Go allowlist at the cell's mirror.
	GoPins []string
	// ImagePins are the Docker Hub images the checkout's Dockerfiles name:
	// the claim's image allowlist at the cell's mirror.
	ImagePins []string
}

// Claim is one claim on this cell. What claim.acquire said is fixed at
// creation; everything else changes under the claim's lock and is read
// through its methods.
type Claim struct {
	ID         string
	Acquire    protocol.ClaimAcquireBody
	Log        *slog.Logger
	AcquiredAt time.Time

	mu            sync.Mutex
	state         State
	settled       chan struct{} // closed when Acquiring ends
	prepared      chan struct{} // closed when the preparation returned
	prepareOnce   sync.Once
	failure       error
	machines      Machines
	boundAt       time.Time
	holdUntil     time.Time
	redactor      *redact.Redactor
	cancels       map[string]context.CancelFunc
	activeSteps   map[string]struct{}
	cancelPrepare context.CancelFunc
	cleaned       bool
	// composeFile and composeDir are what a ComposeBooter boots the claim
	// from, kept to bring the project up again after a reset.
	composeFile []byte
	composeDir  string
	// compromised is why the claim may run nothing more (an exfiltration
	// alert); empty while it is not.
	compromised        string
	observerGeneration uint64

	// egress.policy: allowGen counts the policies received, appliedGen is
	// the last one pushed. egressMu orders pushes and the final removal.
	allow       []string
	allowIssued time.Time
	allowGen    int
	appliedGen  int
	applied     bool
	egressMu    sync.Mutex
}

// New is a claim from its acquire. The acquire's approved hosts are its
// first allowlist, issued at the zero time: any egress.policy replaces it.
func New(id string, acq protocol.ClaimAcquireBody, log *slog.Logger, at time.Time) *Claim {
	return &Claim{
		ID: id, Acquire: acq, Log: log, AcquiredAt: at,
		settled: make(chan struct{}), prepared: make(chan struct{}), cancels: map[string]context.CancelFunc{}, activeSteps: map[string]struct{}{},
		allow: slices.Clone(acq.EgressAllow),
	}
}

func (c *Claim) State() State {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.state
}

// AdvanceObserverGeneration changes only private control configuration after
// seed/reset. It is independent of public step ids and replay round numbers.
func (c *Claim) AdvanceObserverGeneration() uint64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.observerGeneration++
	return c.observerGeneration
}

func (c *Claim) ObserverGeneration() uint64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.observerGeneration
}

// Settled is closed once the claim leaves Acquiring (ready, failed, held or
// released while acquiring).
func (c *Claim) Settled() <-chan struct{} { return c.settled }

// Prepared is closed once the preparation returned: everything it created
// is in the claim's lease.
func (c *Claim) Prepared() <-chan struct{} { return c.prepared }

// FinishPrepare closes Prepared.
func (c *Claim) FinishPrepare() { c.prepareOnce.Do(func() { close(c.prepared) }) }

func (c *Claim) settleLocked(s State) bool {
	if c.state != Acquiring {
		return false
	}
	c.state = s
	close(c.settled)
	return true
}

// MarkReady moves an acquiring claim to Ready; false if it was released
// meanwhile.
func (c *Claim) MarkReady(at time.Time, r *redact.Redactor) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.redactor, c.boundAt = r, at
	return c.settleLocked(Ready)
}

// MarkFailed moves an acquiring claim to Failed, or to Held until holdUntil
// when that is set; false if it was released meanwhile.
func (c *Claim) MarkFailed(err error, r *redact.Redactor, holdUntil time.Time) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.redactor, c.failure = r, err
	if !holdUntil.IsZero() {
		c.holdUntil = holdUntil
		return c.settleLocked(Held)
	}
	return c.settleLocked(Failed)
}

// Release marks the claim Released, cancels its steps and its preparation,
// and reports the state it was in. Releasing twice is harmless.
func (c *Claim) Release() State {
	c.mu.Lock()
	defer c.mu.Unlock()
	prev := c.state
	if prev == Acquiring {
		close(c.settled)
	}
	c.state = Released
	for _, cancel := range c.cancels {
		cancel()
	}
	if c.cancelPrepare != nil {
		c.cancelPrepare()
	}
	return prev
}

// BeginCleanup is true exactly once: for the caller that tears the claim
// down.
func (c *Claim) BeginCleanup() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.cleaned {
		return false
	}
	c.cleaned = true
	return true
}

func (c *Claim) Failure() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.failure
}

func (c *Claim) BoundAt() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.boundAt
}

// HoldUntil is when a held claim's machines go (zero if not held).
func (c *Claim) HoldUntil() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.state != Held {
		return time.Time{}
	}
	return c.holdUntil
}

func (c *Claim) Redactor() *redact.Redactor {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.redactor
}

// SetRedactor sets the redactor before the claim settles (the failure path
// needs it for the bundle).
func (c *Claim) SetRedactor(r *redact.Redactor) {
	c.mu.Lock()
	c.redactor = r
	c.mu.Unlock()
}

func (c *Claim) Machines() Machines {
	c.mu.Lock()
	defer c.mu.Unlock()
	m := c.machines
	m.Sources = slices.Clone(m.Sources)
	return m
}

// SetSources sets the compose containers' addresses; a change makes the
// egress policy due for a push again.
// SetImagePins records the Docker Hub images the checkout's Dockerfiles
// name, for the claim's policy.
func (c *Claim) SetImagePins(pins []string) {
	c.mu.Lock()
	if !slices.Equal(c.machines.ImagePins, pins) {
		c.applied = false
	}
	c.machines.ImagePins = slices.Clone(pins)
	c.mu.Unlock()
}

// SetGoPins records what the checkout's go.sum pins, for the claim's policy.
func (c *Claim) SetGoPins(pins []string) {
	c.mu.Lock()
	if !slices.Equal(c.machines.GoPins, pins) {
		c.applied = false
	}
	c.machines.GoPins = slices.Clone(pins)
	c.mu.Unlock()
}

func (c *Claim) SetSources(s []string) {
	c.mu.Lock()
	if !slices.Equal(c.machines.Sources, s) {
		c.applied = false
	}
	c.machines.Sources = slices.Clone(s)
	c.mu.Unlock()
}

// SetCompose keeps the compose project the claim booted from.
func (c *Claim) SetCompose(file []byte, dir string) {
	c.mu.Lock()
	c.composeFile, c.composeDir = slices.Clone(file), dir
	c.mu.Unlock()
}

// Compose is the compose project the claim booted from (nil file: none).
func (c *Claim) Compose() (file []byte, dir string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return slices.Clone(c.composeFile), c.composeDir
}

// Compromise marks the claim as one that may run nothing more and cancels
// its running steps; true for the first call.
func (c *Claim) Compromise(reason string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.compromised != "" {
		return false
	}
	c.compromised = reason
	for _, cancel := range c.cancels {
		cancel()
	}
	return true
}

// Compromised is why the claim was compromised ("" when it was not).
func (c *Claim) Compromised() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.compromised
}

func (c *Claim) SetNetwork(n driver.ClaimNetwork) {
	c.mu.Lock()
	c.machines.Network = n
	c.mu.Unlock()
}

func (c *Claim) SetWorkload(r driver.MachineRef) {
	c.mu.Lock()
	c.machines.Workload = r
	c.mu.Unlock()
}

func (c *Claim) SetObserver(r driver.MachineRef) {
	c.mu.Lock()
	c.machines.Observer = r
	c.mu.Unlock()
}

// SetPrepareCancel registers how Release stops the preparation; false (and
// cancel called) when the claim is already released.
func (c *Claim) SetPrepareCancel(cancel context.CancelFunc) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.state == Released {
		cancel()
		return false
	}
	c.cancelPrepare = cancel
	return true
}

// AddStep registers a running step's cancel; false (and cancel called) when
// the claim is already released or compromised.
func (c *Claim) AddStep(stepID string, cancel context.CancelFunc) bool {
	return c.TryAddStep(stepID, cancel, 0) == nil
}

var (
	ErrStepCapacity    = errors.New("claims: active step capacity reached")
	ErrStepUnavailable = errors.New("claims: claim released or compromised")
)

// TryAddStep reserves active work and registers cancellation atomically.
// A nonpositive limit leaves admission unbounded for AddStep's callers.
func (c *Claim) TryAddStep(stepID string, cancel context.CancelFunc, limit int) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.state == Released || c.compromised != "" {
		cancel()
		return ErrStepUnavailable
	}
	if limit > 0 && len(c.activeSteps) >= limit {
		cancel()
		return ErrStepCapacity
	}
	c.cancels[stepID] = cancel
	c.activeSteps[stepID] = struct{}{}
	return nil
}

// CompleteStep releases active capacity after work ends, before result
// delivery waits for an ACK. Cancellation remains registered until removal.
func (c *Claim) CompleteStep(stepID string) {
	c.mu.Lock()
	delete(c.activeSteps, stepID)
	c.mu.Unlock()
}

func (c *Claim) RemoveStep(stepID string) {
	c.mu.Lock()
	delete(c.cancels, stepID)
	delete(c.activeSteps, stepID)
	c.mu.Unlock()
}

// CancelStep cancels a running step (exec.cancel); false if none runs.
func (c *Claim) CancelStep(stepID string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	cancel, ok := c.cancels[stepID]
	if ok {
		cancel()
	}
	return ok
}

// SetAllow stores an egress.policy allowlist; stale when an older policy
// than the one held arrives (it is dropped). It reports false when the
// claim is released.
func (c *Claim) SetAllow(allow []string, issued time.Time) (stale, ok bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.state == Released {
		return false, false
	}
	if issued.Before(c.allowIssued) {
		return true, true
	}
	c.allow, c.allowIssued = slices.Clone(allow), issued
	c.allowGen++
	return false, true
}

// EgressLock orders pushes of the claim's policy and its final removal.
func (c *Claim) EgressLock() func() {
	c.egressMu.Lock()
	return c.egressMu.Unlock
}

// PendingAllow is the allowlist to push and its generation; ok is false
// when the claim is released or the latest is already pushed.
func (c *Claim) PendingAllow() (allow []string, gen int, ok bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.state == Released || c.applied && c.appliedGen == c.allowGen {
		return nil, 0, false
	}
	return slices.Clone(c.allow), c.allowGen, true
}

func (c *Claim) MarkAllowApplied(gen int) {
	c.mu.Lock()
	c.applied, c.appliedGen = true, gen
	c.mu.Unlock()
}
