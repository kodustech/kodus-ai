// Package conformance is the backend conformance suite
// (docs/runtime/isolation-architecture.md "Tests"): the behaviours every
// isolation backend must keep, each named in one sentence, run against one
// Target at a time through the layer the cell itself uses (a driver's
// claim networks, sandbox machines and the guest agent inside them).
//
// Targets today: docker-gvisor on a Linux Docker with runsc
// (test/gvisoregress, KODY_E2E_GVISOR=1), firecracker on a KVM host
// (test/fcregress, KODY_E2E_FIRECRACKER=1) and the fake driver, which runs
// the real guest agent on the host and so proves the rules that live in the
// guest agent and the shared layer, not a boundary. A behaviour a target
// cannot show is skipped with the reason; one that waits on a phase is
// skipped as pending with that phase. Run ends with a table of what each
// target skipped, and a target with a boundary fails on a skip it did not
// declare (Target.MaySkip).
package conformance

import (
	"context"
	"encoding/base64"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/guest"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/reaper"
)

// Machines is the part of a driver the suite drives.
type Machines interface {
	driver.Describer
	driver.ClaimNetworker
	driver.MachineKeeper
	driver.Sandboxer
}

// Egress is the cell's egress a target's claim networks join: it takes a
// claim's allow-list for the machines at sources.
type Egress interface {
	Allow(ctx context.Context, claimID, orgID string, net driver.ClaimNetwork, sources, hosts []string) error
}

// Secrets is the cell's credential path (proxy and injector) for one
// claim: the env a machine's command gets to call host with the
// placeholder, and what host received.
type Secrets interface {
	// Grant gives the claim's machines at sources (on claim network n) a
	// placeholder of a secret whose value may go to allowed only, and
	// returns the command that sends the placeholder, read from the env
	// KODY_CONF_SECRET, in an Authorization header to a host.
	Grant(t *testing.T, claimID, orgID string, n driver.ClaimNetwork, sources []string, allowed, other string) (placeholder, value string, call func(host string) string)
	// Received is the Authorization header host got, "" when it got none.
	Received(host string) string
}

// Target is one backend under test.
type Target struct {
	Name   string
	CellID string
	Driver Machines
	// Parts are the driver's optional parts (its Parts method), as cmd/cell
	// wires them: the memory admission behaviour reads Parts.Memory.
	Parts driver.Parts
	// Boundary: the target keeps a machine's processes, memory and network
	// apart from the host (false: the fake, which runs them on the host).
	Boundary bool
	// Egress, with AllowedHost on the allow-list and DeniedHost off it
	// (both reachable from the host), checks the way out; nil: skipped.
	Egress                    Egress
	AllowedHost, DeniedHost   string
	Secrets                   Secrets
	SecretHost, NotSecretHost string
	// Leftovers is what the host still holds of a machine (containers,
	// volumes, directories); empty once it is gone.
	Leftovers func(t *testing.T, machineID string) []string
	// Snapshots is set by a backend with memory snapshots (P3); nil: the
	// snapshot behaviours are pending.
	Snapshots Snapshots
	// Reaper is the out-of-process reaper's driver on this target's cell
	// (what cmd/reaper opens); nil: the reaper behaviour is skipped.
	Reaper reaper.MachineReaper
	// ReaperOrphans is that reaper's orphan pass (cmd/reaper wires it with
	// the driver); nil: the reaper runs the hard-expiry pass alone.
	ReaperOrphans reaper.OrphanReaper
	// Orphan leaves on the host what a cell that died mid-claim leaves of
	// the machine (the cell's record of it gone, its pieces not), and
	// returns what of it is still on the host; nil: no orphan is shown.
	Orphan func(t *testing.T, ref driver.MachineRef) (left func() []string)
	// Limits are the per-sandbox disk and network rates the target's driver
	// enforces (driver.IOLimits); nil: the neighbour behaviour checks only
	// that the other sandbox keeps answering.
	Limits *driver.IOLimits
	// DownloadURL is a large file on AllowedHost (hundreds of MB): with
	// Limits, the neighbour behaviour downloads it to show the network rate
	// is the limit's; empty: no rate is measured.
	DownloadURL string
	// MachineMemory reads, from the host, the memory the machine's cgroup
	// may hold (memory.max) and the most it held since it started
	// (memory.peak), in MB; nil: the memory admission behaviour is skipped.
	MachineMemory func(t *testing.T, ref driver.MachineRef) (limitMB, peakMB int)
	// MaySkip are the behaviours (their names in Run) this target declares it
	// cannot show yet. A target with a Boundary that skips any other fails:
	// a missing tool or a harness gap must not pass as a skip.
	MaySkip []string
}

// Snapshots is what a backend with memory snapshots gives the suite (P3,
// docs/runtime/isolation-p3-snapshots.md).
type Snapshots interface {
	// Snapshot keeps the machine for purpose; the machine ends.
	Snapshot(ctx context.Context, ref driver.MachineRef, purpose isolation.Purpose) (isolation.SnapshotRef, error)
	// Restore makes spec's sandbox from snap.
	Restore(ctx context.Context, spec driver.MachineSpec, snap isolation.SnapshotRef) (driver.MachineRef, error)
	Pause(ctx context.Context, ref driver.MachineRef) error
	Resume(ctx context.Context, ref driver.MachineRef) error
	// Forget removes a snapshot the suite made (its templates go with it).
	Forget(ctx context.Context, snap isolation.SnapshotRef) error
}

// SnapshotBehaviours are the behaviours that need memory snapshots (P3): a
// backend without them declares these in Target.MaySkip.
var SnapshotBehaviours = []string{
	"a restored clone gets a new entropy seed and ids",
	"a restored clone's clock is the host's",
	"two clones of one template have their own addresses and reach each other and the egress",
	"a machine handed secrets never becomes a snapshot",
	"a template never restores into another org",
	"a sandbox template refuses while a workload process runs",
	"a session restores once with its files and processes",
	"pause then resume keeps files and processes",
}

// Run runs every behaviour against the target.
func Run(t *testing.T, tg Target) {
	t.Helper()
	var skipped []string
	total, failed := 0, 0
	for _, b := range []struct {
		name string
		run  func(*testing.T, Target)
	}{
		{"off-allow-list egress is refused", offAllowListEgressIsRefused},
		{"a workspace symlink cannot read outside it", aWorkspaceSymlinkCannotReadOutsideIt},
		{"a placeholder becomes the value only for its host", aPlaceholderBecomesTheValueOnlyForItsHost},
		{"two orgs never share a machine or pooled clone", twoOrgsNeverShareAMachineOrPooledClone},
		{"a released machine is gone with its files", aReleasedMachineIsGoneWithItsFiles},
		{"memory and CPU limits hold", memoryAndCPULimitsHold},
		{"a sandbox never holds more than the cell counts it for", aSandboxNeverHoldsMoreThanTheCellCountsItFor},
		{"a restored clone gets a new entropy seed and ids", aRestoredCloneGetsANewEntropySeedAndIDs},
		{"a restored clone's clock is the host's", aRestoredClonesClockIsTheHosts},
		{"two clones of one template have their own addresses and reach each other and the egress", twoClonesHaveTheirOwnAddresses},
		{"a machine handed secrets never becomes a snapshot", aMachineHandedSecretsNeverBecomesASnapshot},
		{"a template never restores into another org", aTemplateNeverRestoresIntoAnotherOrg},
		{"a sandbox template refuses while a workload process runs", aSandboxTemplateRefusesWhileAWorkloadProcessRuns},
		{"a session restores once with its files and processes", aSessionRestoresOnceWithItsFilesAndProcesses},
		{"pause then resume keeps files and processes", pauseThenResumeKeepsFilesAndProcesses},
		{"the reaper alone ends an expired machine and an orphan", theReaperAloneEndsAnExpiredMachineAndAnOrphan},
		{"a noisy neighbour does not starve another org's sandbox", aNoisyNeighbourDoesNotStarveAnotherOrgsSandbox},
	} {
		ran := t.Run(b.name, func(t *testing.T) {
			defer func() {
				if t.Skipped() {
					skipped = append(skipped, b.name)
				}
			}()
			b.run(t, tg)
		})
		total++
		if !ran {
			failed++
		}
	}
	// The table: what this target showed and what it skipped, so a backend
	// that proves less than another is visible in the log.
	t.Logf("conformance %s: %d behaviours, %d passed, %d failed, %d skipped", tg.Name, total, total-failed-len(skipped), failed, len(skipped))
	for _, name := range skipped {
		declared := slices.Contains(tg.MaySkip, name)
		t.Logf("  skipped: %s (declared: %v)", name, declared)
		if tg.Boundary && !declared {
			t.Errorf("%s skipped %q, which it does not declare in Target.MaySkip", tg.Name, name)
		}
	}
}

// box is one sandbox machine on a claim network of its own, with a client
// to its guest agent.
type box struct {
	tg     Target
	ref    driver.MachineRef
	net    driver.ClaimNetwork
	org    string
	claim  string
	client *guest.Client
	gone   bool
}

var seq int

// newBox makes a sandbox for org, released when the test ends.
func newBox(t *testing.T, tg Target, org string, size driver.ClaimSize, role driver.Role) *box {
	t.Helper()
	return newBoxWith(t, tg, org, func(s *driver.MachineSpec) { s.ClaimSize, s.Role = size, role })
}

// newClaim is a claim network of org, released when the test ends.
func newClaim(t *testing.T, tg Target, org string) (string, driver.ClaimNetwork) {
	t.Helper()
	seq++
	claim := fmt.Sprintf("conf-%d-%d", time.Now().UnixNano()%1_000_000, seq)
	n, err := tg.Driver.PrepareClaim(context.Background(), driver.ClaimNetworkSpec{CellID: tg.CellID, OrgID: org, ClaimID: claim})
	if err != nil {
		t.Fatalf("prepare claim: %v", err)
	}
	t.Cleanup(func() { _ = tg.Driver.ReleaseClaim(context.Background(), n) })
	return claim, n
}

// sandboxSpec is a sandbox of org on claim's network.
func sandboxSpec(tg Target, org, claim string, n driver.ClaimNetwork, role driver.Role) driver.MachineSpec {
	now := time.Now()
	return driver.MachineSpec{
		CellID: tg.CellID, EnvironmentID: "env-conformance", Role: role, OrgID: org, ClaimID: claim,
		ImageID: "sandbox", ImageRef: "sandbox", ClaimGroupID: n.WorkloadGroupID, KMSKeyRef: "kms-" + org,
		ExpiresAt: now.Add(10 * time.Minute), HardExpiresAt: now.Add(30 * time.Minute),
	}
}

// newBoxWith makes a sandbox for org with its spec changed by mut.
func newBoxWith(t *testing.T, tg Target, org string, mut func(*driver.MachineSpec)) *box {
	t.Helper()
	claim, n := newClaim(t, tg, org)
	spec := sandboxSpec(tg, org, claim, n, driver.RoleWorkload)
	if mut != nil {
		mut(&spec)
	}
	ref, err := tg.Driver.CreateSandbox(context.Background(), driver.SandboxRequest{Spec: spec})
	if err != nil {
		t.Fatalf("create sandbox: %v", err)
	}
	b := &box{tg: tg, ref: ref, net: n, org: org, claim: claim}
	t.Cleanup(b.release)
	b.client = b.dial(t)
	return b
}

func (b *box) dial(t *testing.T) *guest.Client {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for {
		rw, err := b.tg.Driver.DialGuest(context.Background(), b.ref)
		if err == nil {
			c := guest.NewClient(rw, b.tg.CellID, b.claim)
			// The first stat answers once the guest agent is up.
			if r, err := c.Do(context.Background(), guest.NewID(), protocol.SandboxOp{Op: protocol.SandboxOpKindStat}); err == nil && r.Ok {
				return c
			}
			_ = c.Close()
		}
		if time.Now().After(deadline) {
			t.Fatalf("guest agent of %s never answered: %v", b.ref.MachineID, err)
		}
		time.Sleep(200 * time.Millisecond)
	}
}

// release destroys the machine and its network; twice is a no-op.
func (b *box) release() {
	if b.gone {
		return
	}
	b.gone = true
	if b.client != nil {
		_ = b.client.Close()
	}
	ctx := context.Background()
	_ = b.tg.Driver.Destroy(ctx, b.ref)
	_ = b.tg.Driver.ReleaseClaim(ctx, b.net)
}

func (b *box) do(t *testing.T, op protocol.SandboxOp) protocol.SandboxResult {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	r, err := b.client.Do(ctx, guest.NewID(), op)
	if err != nil {
		t.Fatalf("%s %s: %v", op.Op, b.ref.MachineID, err)
	}
	return r
}

// sh runs command in the machine and returns its result.
func (b *box) sh(t *testing.T, command string, env ...string) *protocol.SandboxExecResult {
	t.Helper()
	op := protocol.SandboxOp{Op: protocol.SandboxOpKindExec, Command: &command, TimeoutMs: ptr[int64](90_000)}
	if len(env) > 0 {
		op.Env = map[string]string{}
		for _, kv := range env {
			k, v, _ := strings.Cut(kv, "=")
			op.Env[k] = v
		}
	}
	r := b.do(t, op)
	if r.Exec == nil {
		t.Fatalf("exec %q: %+v", command, r)
	}
	return r.Exec
}

func (b *box) write(t *testing.T, path, content string) {
	t.Helper()
	c := base64.StdEncoding.EncodeToString([]byte(content))
	if r := b.do(t, protocol.SandboxOp{Op: protocol.SandboxOpKindWrite, Path: &path, Content: &c, Mkdirs: ptr(true)}); !r.Ok {
		t.Fatalf("write %s: %+v", path, r.Error)
	}
}

func (b *box) read(t *testing.T, path string) (string, *protocol.SandboxError) {
	t.Helper()
	r := b.do(t, protocol.SandboxOp{Op: protocol.SandboxOpKindRead, Path: &path})
	if !r.Ok {
		return "", r.Error
	}
	raw, err := base64.StdEncoding.DecodeString(*r.Content)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(raw), nil
}

func ptr[T any](v T) *T { return &v }

// python runs a python3 program in the machine (the tool image has it).
func (b *box) python(t *testing.T, program string) *protocol.SandboxExecResult {
	t.Helper()
	return b.sh(t, "python3 -c "+shellQuote(program))
}

func shellQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }
