package agent

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/admission"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/clock"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/guest"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// The cell's pool of blank sandboxes (step 2 of docs/runtime/sandbox.md): a
// sandbox.acquire takes one ready machine (network, container, guest agent
// answering) instead of making them, so it is ready in the time of an egress
// push. A blank sandbox has never run anything and holds nothing: it belongs
// to no org (SandboxPoolOrg) until a claim takes it. The claim that takes it
// owns it alone and destroys it on release; it never goes back, so no two
// claims, orgs or sessions ever share one.

// SandboxPoolOrg is the org a blank sandbox is made under (its tags).
const SandboxPoolOrg = "kodus-sandbox-pool"

const (
	// sandboxPoolCeiling is a blank sandbox's hard ceiling: past the
	// longest claim that may take it, which must end before it (the
	// machine's kodus:hard-expires never moves).
	sandboxPoolCeiling = 2 * time.Hour
	// sandboxPoolTTL is how long a blank sandbox waits before it is made
	// again, so the one a claim takes still has a claim's ceiling ahead.
	sandboxPoolTTL  = 50 * time.Minute
	sandboxPoolTick = 15 * time.Second
)

type pooledSandbox struct {
	id    string // the pool claim id it was made and counted under
	net   driver.ClaimNetwork
	ref   driver.MachineRef
	guest *guest.Client
	at    time.Time
	hard  time.Time
}

// sandboxPool keeps Target blank sandboxes of the cell's sandbox size.
type sandboxPool struct {
	Target    int
	CellID    string
	Driver    driver.MachineDriver
	Sandboxes driver.Sandboxer
	OrgKey    func(string) (string, error)
	Size      driver.MachineSize
	// ClaimSize is every blank sandbox's size (Config.SandboxSize): only a
	// claim of that size takes one, so its memory passes to the claim at
	// the size the blank was counted at.
	ClaimSize driver.ClaimSize
	Clock     clock.Clock
	Log       *slog.Logger
	Accepting func() bool
	// dial is the agent's dialGuest: the first answer proves it ready.
	dial func(ctx context.Context, ref driver.MachineRef, claimID string) (*guest.Client, error)
	// Mem is the cell's memory ledger (ADR-070), nil without memory
	// admission: each blank sandbox is counted under its pool id at MemMB
	// (its ClaimSize's memory) from before it is made until a claim takes
	// it (the claim is counted then, at the same MB) or it is destroyed.
	// One that does not fit is not made.
	Mem   *admission.Ledger
	MemMB int

	mu       sync.Mutex
	ready    []*pooledSandbox
	making   int
	nudge    chan struct{}
	disabled bool
}

// has reports whether take would hand a blank sandbox now.
func (p *sandboxPool) has(size driver.ClaimSize, hard time.Time) bool {
	if p == nil || size != p.ClaimSize {
		return false
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, m := range p.ready {
		select {
		case <-m.guest.Done():
			continue
		default:
		}
		if !hard.After(m.hard) {
			return true
		}
	}
	return false
}

// take hands the oldest blank sandbox that fits a claim of size ending at
// hard to the caller, who owns it from then on; false: make one.
func (p *sandboxPool) take(size driver.ClaimSize, hard time.Time) (pooledSandbox, bool) {
	if p == nil || size != p.ClaimSize {
		return pooledSandbox{}, false // blank sandboxes are of the sandbox size only
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	for i, m := range p.ready {
		select {
		case <-m.guest.Done():
			continue // its guest agent died; the next tick discards it
		default:
		}
		if hard.After(m.hard) {
			continue
		}
		p.ready = append(p.ready[:i:i], p.ready[i+1:]...)
		// The taking claim is counted for it now (its own admission).
		p.forget(m.id)
		p.wake()
		return *m, true
	}
	return pooledSandbox{}, false
}

func (p *sandboxPool) wake() {
	select {
	case p.nudge <- struct{}{}:
	default:
	}
}

// Ready is how many blank sandboxes are ready now.
func (p *sandboxPool) Ready() int {
	if p == nil {
		return 0
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.ready)
}

// run keeps the pool filled until ctx ends, then destroys what it holds.
func (p *sandboxPool) run(ctx context.Context) {
	p.mu.Lock()
	p.nudge = make(chan struct{}, 1)
	p.mu.Unlock()
	t := time.NewTicker(sandboxPoolTick)
	defer t.Stop()
	for {
		p.expire(ctx)
		p.fill(ctx)
		select {
		case <-ctx.Done():
			p.drain(context.WithoutCancel(ctx))
			return
		case <-t.C:
		case <-p.nudge:
		}
	}
}

// expire destroys the blank sandboxes past their TTL or whose guest died.
func (p *sandboxPool) expire(ctx context.Context) {
	now := p.Clock.Now()
	p.mu.Lock()
	var old []*pooledSandbox
	kept := p.ready[:0]
	for _, m := range p.ready {
		dead := false
		select {
		case <-m.guest.Done():
			dead = true
		default:
		}
		if dead || now.Sub(m.at) >= sandboxPoolTTL {
			old = append(old, m)
			continue
		}
		kept = append(kept, m)
	}
	p.ready = kept
	p.mu.Unlock()
	for _, m := range old {
		p.destroy(ctx, *m)
	}
}

func (p *sandboxPool) fill(ctx context.Context) {
	for {
		p.mu.Lock()
		short := p.Target - len(p.ready) - p.making
		if short <= 0 || p.disabled || (p.Accepting != nil && !p.Accepting()) {
			p.mu.Unlock()
			return
		}
		p.making++
		p.mu.Unlock()
		m, err := p.make(ctx)
		p.mu.Lock()
		p.making--
		if err == nil {
			p.ready = append(p.ready, &m)
		}
		p.mu.Unlock()
		if err != nil {
			var room *noRoomError
			if errors.As(err, &room) {
				p.Log.Info("sandbox.pool.no_memory", "needMb", room.needMB, "freeMb", room.freeMB)
			} else {
				p.Log.Warn("sandbox.pool.make_failed", "err", err)
			}
			return // the next tick tries again
		}
		p.Log.Info("sandbox.pool.made", "machine", m.ref.MachineID, "ms", p.Clock.Now().Sub(m.at).Milliseconds())
	}
}

// make builds one blank sandbox under its own pool claim id.
func (p *sandboxPool) make(ctx context.Context) (pooledSandbox, error) {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return pooledSandbox{}, err
	}
	id := "sbxpool-" + hex.EncodeToString(b[:])
	start := p.Clock.Now()
	if p.Mem != nil {
		if ok, _, free := p.Mem.Admit(id, p.MemMB, true); !ok {
			return pooledSandbox{}, &noRoomError{needMB: p.MemMB, freeMB: free}
		}
	}
	key, err := p.OrgKey(SandboxPoolOrg)
	if err != nil {
		p.forget(id)
		return pooledSandbox{}, err
	}
	net, err := p.Driver.PrepareClaim(ctx, driver.ClaimNetworkSpec{CellID: p.CellID, OrgID: SandboxPoolOrg, ClaimID: id})
	if err != nil {
		p.forget(id)
		return pooledSandbox{}, err
	}
	hard := start.Add(sandboxPoolCeiling)
	// A blank sandbox asks no trust: it is made before any claim.
	ref, err := p.Sandboxes.CreateSandbox(ctx, driver.SandboxRequest{Spec: driver.MachineSpec{
		CellID: p.CellID, EnvironmentID: protocol.SandboxEnvironmentID, Role: driver.RolePool, OrgID: SandboxPoolOrg, ClaimID: id,
		ImageID: sandboxImageID, Size: p.Size, ClaimSize: p.ClaimSize, ClaimGroupID: net.WorkloadGroupID, KMSKeyRef: key, ExpiresAt: hard, HardExpiresAt: hard,
	}})
	if err != nil {
		_ = p.Driver.ReleaseClaim(context.WithoutCancel(ctx), net)
		p.forget(id)
		return pooledSandbox{}, err
	}
	cl, err := p.dial(ctx, ref, id)
	if err != nil {
		p.destroy(ctx, pooledSandbox{id: id, net: net, ref: ref})
		return pooledSandbox{}, err
	}
	return pooledSandbox{id: id, net: net, ref: ref, guest: cl, at: start, hard: hard}, nil
}

// noRoomError: the cell's memory has no room for one more blank sandbox;
// claims come first, and the next tick tries again.
type noRoomError struct{ needMB, freeMB int }

func (e *noRoomError) Error() string {
	return fmt.Sprintf("no memory for a blank sandbox: it needs %d MB and %d are free", e.needMB, max(e.freeMB, 0))
}

// forget stops counting a blank sandbox (taken by a claim, or destroyed).
func (p *sandboxPool) forget(id string) {
	if p.Mem != nil && id != "" {
		p.Mem.Forget(id)
	}
}

func (p *sandboxPool) destroy(ctx context.Context, m pooledSandbox) {
	cctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), cleanupTimeout)
	defer cancel()
	if m.guest != nil {
		_ = m.guest.Close()
	}
	if err := p.Driver.Destroy(cctx, m.ref); err != nil {
		p.Log.Warn("sandbox.pool.destroy_failed", "machine", m.ref.MachineID, "err", err)
	}
	if err := p.Driver.ReleaseClaim(cctx, m.net); err != nil {
		p.Log.Warn("sandbox.pool.network_failed", "machine", m.ref.MachineID, "err", err)
	}
	p.forget(m.id)
}

// drain destroys every blank sandbox (the cell stops).
func (p *sandboxPool) drain(ctx context.Context) {
	p.mu.Lock()
	all := p.ready
	p.ready, p.disabled = nil, true
	p.mu.Unlock()
	for _, m := range all {
		p.destroy(ctx, *m)
	}
}
