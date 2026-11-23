// Package microvm is the machine driver for microVM backends
// (docs/runtime/isolation-architecture.md C3, phase P2): it composes a
// Placement that attaches a machine's network on the host (placement/hostnet:
// a bridge per claim, a tap per machine) with an IsolationBackend that makes
// each machine a microVM (isolation/firecracker), and keeps the driver's
// rules on top: claim checks, tags and ceilings, ownership, the claim's own
// network, the sweep.
//
// It runs code sandboxes (driver.Sandboxer) and environments: an
// environment VM runs the claim's compose project on its own dockerd
// (env.go, build.go), its observer is a VM of its own reached over vsock
// (env_run.go), and a setup's VM becomes the environment's template when
// the backend keeps memory (Parts: Baker, Snapshots, Sessions).
package microvm

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/buildmirror"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation/vmsnap"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/machinetrust"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/placement"
)

// Kind is the driver's name (hello.driver).
const Kind = "microvm"

// Backend is the isolation backend with the list of what it holds and the
// sweep of its snapshots.
type Backend interface {
	isolation.Backend
	Inventory(ctx context.Context) ([]isolation.Listed, error)
	SweepSnapshots(now time.Time) ([]string, error)
	// ForgetSession removes org's session snapshot (and only a session); one
	// the store does not hold is already gone.
	ForgetSession(org, id string) error
	// DataAllocated is what a machine's data disk holds on the host: its
	// high-water mark, since the guest's frees are never given back.
	DataAllocated(name string) (int64, error)
	SnapshotRound(ctx context.Context, name string) (isolation.SnapshotRef, isolation.Machine, error)
	RestoreInPlace(ctx context.Context, name string, snap isolation.SnapshotRef) (isolation.Machine, error)
	LatestTemplate(org, key string, shape isolation.Shape) (isolation.SnapshotRef, bool, error)
	ForgetClaim(org, claim string) error
	// DialVsock opens a stream to a vsock port of the machine (its observer).
	DialVsock(ctx context.Context, name string, port uint32) (net.Conn, error)
}

// Config is the driver's.
type Config struct {
	CellID  string
	Backend Backend
	// MaxUploadBytes bounds the archive of one checkout Upload sends into an
	// environment VM (DefaultMaxUploadBytes when zero).
	MaxUploadBytes int64
	Place          placement.Placement
	// Egress: the cell's egress runs and every claim network reaches it.
	Egress bool
	// MemoryMB and CPUs size a claim that asks none (2048, 2); MaxMemoryMB
	// and MaxCPUs are the most one claim may ask (the defaults when zero).
	MemoryMB, CPUs, MaxMemoryMB, MaxCPUs int
	// ObserverTLSDir holds the observers' cert.pem and key.pem (for the
	// cell's -observer-server-name) and ca.pem (the CA of the cell's client
	// certificate), laid into each observer VM.
	ObserverTLSDir string
	// ObserverMemoryMB sizes an observer VM (512 when zero).
	ObserverMemoryMB int
	// Trust are the cell's trust files (machinetrust): a claim with org
	// secrets gets them in every service of its VM.
	Trust machinetrust.Files
	// Log takes the driver's own lines (a template it could not use); slog's default when nil.
	Log *slog.Logger
	// DataCeilingGB is the cell's ceiling on an environment's data disk
	// (-firecracker-data-gb, the backend's DataGB); NeedsFile keeps each
	// environment's measured need (empty: in memory only).
	DataCeilingGB int
	NeedsFile     string
	// Mirror is the cell's mirror as the VMs reach it (buildmirror.At of
	// -firecracker-mirror): every build gets its build args, and the VM's
	// own builder pulls docker.io through it. Zero: no mirror.
	Mirror buildmirror.Mirror
	// vmData replaces the VM's data mount in the paths the cell's commands
	// name in the VM (guestinit.DataMount when empty): the tests' guest
	// agent runs on a host directory.
	vmData string
}

// Driver runs claims' machines as microVMs.
type Driver struct {
	cfg Config
	mu  sync.Mutex
	// expires is kodus:expires after a renew; the record keeps the tag the
	// machine was born with.
	expires map[string]time.Time
	// uploads is where each environment machine's checkout went (Upload),
	// so Up finds its project directory in the VM.
	uploads map[string]upload
	// initdb are the sql files each machine's compose file binds into
	// postgres's initdb (a seed that runs with the database's first start).
	initdb map[string]map[string]bool
	// built is the compose file each machine's project was last built and
	// brought up from (a digest of it): an Up again with the same file, the
	// one after a reset, brings it up from those images and builds nothing.
	built map[string]string
	// pinned are setup machines a bake takes (PinBakeSource); pendingNets
	// the networks of their claims released before the bake was done.
	pinned      map[string]bool
	pendingNets map[string]driver.ClaimNetwork
	// vmstatFile replaces /proc/vmstat in MachineHealth (tests).
	vmstatFile string
	// needs are each environment's data disk need (disk_need.go).
	needs map[string]int64
}

var (
	_ driver.MachineDriver    = (*Driver)(nil)
	_ driver.Sandboxer        = (*Driver)(nil)
	_ driver.Snapshotter      = (*Driver)(nil)
	_ driver.ComposeBooter    = (*Driver)(nil)
	_ driver.RecipeRunner     = (*Driver)(nil)
	_ driver.BakeSourcePinner = (*Driver)(nil)
)

// New is the driver on cfg's backend and placement.
func New(cfg Config) (*Driver, error) {
	if cfg.CellID == "" || cfg.Backend == nil || cfg.Place == nil {
		return nil, errors.New("microvm: a cell id, a backend and a placement are required")
	}
	if cfg.MemoryMB == 0 {
		cfg.MemoryMB = 2048
	}
	if cfg.CPUs == 0 {
		cfg.CPUs = 2
	}
	cfg.MaxMemoryMB = max(cfg.MaxMemoryMB, cfg.MemoryMB)
	cfg.MaxCPUs = max(cfg.MaxCPUs, cfg.CPUs)
	if cfg.ObserverMemoryMB == 0 {
		cfg.ObserverMemoryMB = 512
	}
	if cfg.Log == nil {
		cfg.Log = slog.Default()
	}
	if cfg.DataCeilingGB == 0 {
		cfg.DataCeilingGB = 40
	}
	d := &Driver{cfg: cfg, expires: map[string]time.Time{}, uploads: map[string]upload{}, initdb: map[string]map[string]bool{}, built: map[string]string{}, pinned: map[string]bool{}, pendingNets: map[string]driver.ClaimNetwork{}}
	if err := d.loadNeeds(); err != nil {
		return nil, err
	}
	return d, nil
}

func (d *Driver) Kind() string { return Kind }

// Capabilities are the backend's: the environment's compose project runs in
// its VM's own Docker when the kit has one (NestedContainers).
func (d *Driver) Capabilities() driver.Capabilities {
	b := d.cfg.Backend.Capabilities()
	host := ""
	if len(b.Arch) == 1 {
		host = b.Arch[0]
	}
	return driver.Capabilities{
		Isolation: b.Isolation, Arch: b.Arch, MaxClaimSize: driver.ClaimSize{MemoryMB: d.cfg.MaxMemoryMB, CPUs: d.cfg.MaxCPUs},
		Backends: []string{b.Backend}, KVM: b.KVM, HostArch: host, NestedContainers: b.NestedDocker,
	}
}

// Parts returns a Run's compose project and recipe in its VM, code sandboxes, the
// memory budget, the readers of a claim's VMs and the sweep, always. Memory
// snapshots only on a backend that keeps them, and the bake (a setup's VM as
// the environment's template) only there and with nested containers.
func (d *Driver) Parts() driver.Parts {
	p := driver.Parts{
		Composer: d, Recipes: d, Resetter: d, Sandboxes: d,
		Memory: d, SandboxMemory: d,
		Diagnoser: d, ServiceLogs: d, Health: d, Sweeper: d,
	}
	if d.cfg.Backend.Capabilities().SnapshotMemory {
		p.Snapshots, p.Sessions = d, d
	}
	if d.bakes() {
		p.Baker, p.BakePinner = d, d
	}
	return p
}

// bakes: the backend keeps memory and the kit runs compose, so a setup's VM
// can become the environment's template.
func (d *Driver) bakes() bool {
	b := d.cfg.Backend.Capabilities()
	return b.SnapshotMemory && b.NestedDocker
}

func networkName(claimID string) string { return "kodus-" + strings.ToLower(claimID) }

func machineName(spec driver.MachineSpec) string {
	return fmt.Sprintf("kodus-%s-%s", strings.ToLower(spec.ClaimID), spec.Role)
}

// PrepareClaim makes the claim's network on the host and joins the egress
// to it: its address is the claim's resolver and the only way out.
func (d *Driver) PrepareClaim(ctx context.Context, spec driver.ClaimNetworkSpec) (driver.ClaimNetwork, error) {
	if err := driver.ValidateClaimID(spec.ClaimID); err != nil {
		return driver.ClaimNetwork{}, err
	}
	name := networkName(spec.ClaimID)
	labels := map[string]string{driver.TagCell: d.cfg.CellID, driver.TagOrg: spec.OrgID, driver.TagClaim: spec.ClaimID}
	if _, err := d.cfg.Place.CreateNetwork(ctx, placement.NetworkSpec{Name: name, Key: spec.ClaimID, Labels: labels}); err != nil {
		return driver.ClaimNetwork{}, err
	}
	n := driver.ClaimNetwork{WorkloadGroupID: name, ObserverGroupID: name}
	if !d.cfg.Egress {
		return n, nil
	}
	addr, err := d.cfg.Place.AttachEgress(ctx, name, "")
	if err != nil {
		return driver.ClaimNetwork{}, errors.Join(fmt.Errorf("microvm: attach egress to %s: %w", name, err), d.cfg.Place.RemoveNetwork(ctx, name))
	}
	n.EgressAddress = addr
	return n, nil
}

// ReleaseClaim removes the claim's network, only when it is this cell's.
func (d *Driver) ReleaseClaim(ctx context.Context, n driver.ClaimNetwork) error {
	if n.WorkloadGroupID == "" {
		return nil
	}
	labels, err := d.cfg.Place.NetworkLabels(ctx, n.WorkloadGroupID)
	if err != nil || labels == nil {
		return err
	}
	if labels[driver.TagCell] != d.cfg.CellID {
		return fmt.Errorf("%w: network %s", driver.ErrNotOwned, n.WorkloadGroupID)
	}
	// A bake still holds the claim's setup machine on this network: the
	// network goes when the bake is done.
	d.mu.Lock()
	for m := range d.pinned {
		if networkOfMachine(m) == n.WorkloadGroupID {
			d.pendingNets[n.WorkloadGroupID] = n
			d.mu.Unlock()
			return nil
		}
	}
	d.mu.Unlock()
	if err := d.cfg.Place.DetachEgress(ctx, n.WorkloadGroupID, ""); err != nil {
		return err
	}
	// A claim's round snapshots go with it.
	if err := d.cfg.Backend.ForgetClaim(labels[driver.TagOrg], labels[driver.TagClaim]); err != nil {
		return err
	}
	return d.cfg.Place.RemoveNetwork(ctx, n.WorkloadGroupID)
}

// checkSpec refuses a spec this driver cannot make, one of another cell,
// and one that names a network that is not its claim's.
func (d *Driver) checkSpec(spec driver.MachineSpec) error {
	if err := spec.ValidateFor(d.Capabilities()); err != nil {
		return err
	}
	if err := driver.ValidateClaimID(spec.ClaimID); err != nil {
		return err
	}
	if spec.CellID != d.cfg.CellID {
		return fmt.Errorf("%w: spec for cell %s", driver.ErrNotOwned, spec.CellID)
	}
	if spec.ClaimGroupID != networkName(spec.ClaimID) {
		return fmt.Errorf("%w: network %s is not claim %s's", driver.ErrNotOwned, spec.ClaimGroupID, spec.ClaimID)
	}
	return nil
}

func (d *Driver) size(s driver.ClaimSize) (mem, cpus string) {
	m, c := d.cfg.MemoryMB, d.cfg.CPUs
	if s.MemoryMB > 0 {
		m = s.MemoryMB
	}
	if s.CPUs > 0 {
		c = s.CPUs
	}
	return strconv.Itoa(m) + "m", strconv.Itoa(c)
}

// specOf is the backend's spec of a machine: its name, network, tags and
// size, and what the snapshot rules read (its org, whether it is a setup's
// or a pool's, and its taints, recorded before it exists).
func (d *Driver) specOf(spec driver.MachineSpec, shape isolation.Shape) isolation.Spec {
	tags := spec.AllTags()
	tags["kodus:image"] = spec.ImageID
	mem, cpus := d.size(spec.ClaimSize)
	is := isolation.Spec{
		Shape: shape, Name: machineName(spec), Image: spec.ImageRef, Network: spec.ClaimGroupID, Labels: tags, Memory: mem, CPUs: cpus,
		Org: spec.OrgID, Claim: spec.ClaimID, Setup: spec.Setup && spec.Role == driver.RoleWorkload, Pool: spec.Role == driver.RolePool,
	}
	if shape == isolation.ShapeEnvironment {
		is.DiskSize = d.diskSizeOf(spec.OrgID, spec.EnvironmentID)
	}
	if spec.Secrets {
		is.Taints = append(is.Taints, isolation.TaintSecrets)
	}
	if spec.UserData != "" {
		is.Taints = append(is.Taints, isolation.TaintCredentials)
	}
	if shape == isolation.ShapeSandbox {
		mb, _ := strconv.Atoi(strings.TrimSuffix(mem, "m"))
		is.WorkspaceSize, is.TmpSize = strconv.Itoa(mb/2)+"m", "512m"
	}
	return is
}

func refOf(spec driver.MachineSpec, is isolation.Spec, m isolation.Machine) driver.MachineRef {
	return driver.MachineRef{MachineID: is.Name, DriverRef: m.ID, PrivateAddress: m.IP(spec.ClaimGroupID), ImageID: spec.ImageID, Tags: is.Labels}
}

func (d *Driver) create(ctx context.Context, spec driver.MachineSpec, shape isolation.Shape) (driver.MachineRef, error) {
	if err := d.checkSpec(spec); err != nil {
		return driver.MachineRef{}, err
	}
	is := d.specOf(spec, shape)
	m, err := d.cfg.Backend.Create(ctx, is)
	if err != nil {
		return driver.MachineRef{}, err
	}
	return refOf(spec, is, m), nil
}

// Snapshot keeps this cell's machine for purpose and ends it. The org is
// the one the machine was born with; the backend checks it against its own
// record and refuses a machine its rules keep from it.
func (d *Driver) Snapshot(ctx context.Context, ref driver.MachineRef, purpose isolation.Purpose) (isolation.SnapshotRef, error) {
	return d.snapshot(ctx, ref, purpose, "")
}

func (d *Driver) snapshot(ctx context.Context, ref driver.MachineRef, purpose isolation.Purpose, key string) (isolation.SnapshotRef, error) {
	m, ok, err := d.find(ctx, ref.MachineID)
	if err != nil {
		return isolation.SnapshotRef{}, err
	}
	if !ok {
		return isolation.SnapshotRef{}, fmt.Errorf("microvm: no machine %s", ref.MachineID)
	}
	snap, err := d.cfg.Backend.Snapshot(ctx, ref.MachineID, isolation.SnapshotRequest{Purpose: purpose, Org: m.Labels[driver.TagOrg], Key: key})
	if err != nil {
		return isolation.SnapshotRef{}, err
	}
	d.mu.Lock()
	delete(d.expires, ref.MachineID)
	d.mu.Unlock()
	return snap, nil
}

// CreateSandboxFrom makes a code sandbox of spec from a snapshot of its
// org; CreateFrom an environment machine. A snapshot of another org is
// refused here, and the backend finds it only under the spec's org anyway.
func (d *Driver) CreateSandboxFrom(ctx context.Context, spec driver.MachineSpec, snap isolation.SnapshotRef) (driver.MachineRef, error) {
	if spec.Role != driver.RolePool {
		spec.Role = driver.RoleWorkload
	}
	spec.ImageID, spec.ImageRef = "sandbox", "sandbox"
	return d.restore(ctx, spec, snap, isolation.ShapeSandbox)
}

// CreateFrom makes an environment machine of spec from a snapshot of its org.
func (d *Driver) CreateFrom(ctx context.Context, spec driver.MachineSpec, snap isolation.SnapshotRef) (driver.MachineRef, error) {
	return d.restore(ctx, spec, snap, isolation.ShapeEnvironment)
}

func (d *Driver) restore(ctx context.Context, spec driver.MachineSpec, snap isolation.SnapshotRef, shape isolation.Shape) (driver.MachineRef, error) {
	if err := d.checkSpec(spec); err != nil {
		return driver.MachineRef{}, err
	}
	if snap.Org != spec.OrgID {
		return driver.MachineRef{}, fmt.Errorf("%w: snapshot %s is not org %s's", driver.ErrNotOwned, snap.ID, spec.OrgID)
	}
	is := d.specOf(spec, shape)
	is.Setup = false // a restored machine never makes a template
	m, err := d.cfg.Backend.Restore(ctx, snap, is)
	if err != nil {
		return driver.MachineRef{}, err
	}
	return refOf(spec, is, m), nil
}

// SnapshotMachine is driver.Snapshotter's: a round restores the machine in
// its place at once; a template or a session ends it.
func (d *Driver) SnapshotMachine(ctx context.Context, ref driver.MachineRef, purpose, key string) (driver.MemorySnapshot, driver.MachineRef, error) {
	p := isolation.Purpose(purpose)
	switch p {
	case isolation.PurposeTemplate, isolation.PurposeSession:
		snap, err := d.snapshot(ctx, ref, p, key)
		if err != nil {
			return driver.MemorySnapshot{}, driver.MachineRef{}, err
		}
		return driver.MemorySnapshot{ID: snap.ID, OrgID: snap.Org, Purpose: purpose}, driver.MachineRef{}, nil
	case isolation.PurposeRound:
		if _, ok, err := d.find(ctx, ref.MachineID); err != nil || !ok {
			return driver.MemorySnapshot{}, driver.MachineRef{}, errors.Join(err, notFound(ok, ref))
		}
		snap, m, err := d.cfg.Backend.SnapshotRound(ctx, ref.MachineID)
		if err != nil {
			return driver.MemorySnapshot{}, driver.MachineRef{}, err
		}
		return driver.MemorySnapshot{ID: snap.ID, OrgID: snap.Org, Purpose: purpose}, d.sameRef(ref, m), nil
	}
	return driver.MemorySnapshot{}, driver.MachineRef{}, fmt.Errorf("microvm: unknown snapshot purpose %q", purpose)
}

// sameRef is ref after its machine came back in its place.
func (d *Driver) sameRef(ref driver.MachineRef, m isolation.Machine) driver.MachineRef {
	ref.DriverRef = m.ID
	if ip := m.IP(networkName(ref.Tags[driver.TagClaim])); ip != "" {
		ref.PrivateAddress = ip
	}
	return ref
}

// LatestTemplate is driver.Snapshotter's.
func (d *Driver) LatestTemplate(_ context.Context, orgID, key string) (driver.MemorySnapshot, bool, error) {
	snap, ok, err := d.cfg.Backend.LatestTemplate(orgID, key, isolation.ShapeSandbox)
	if err != nil || !ok {
		return driver.MemorySnapshot{}, false, err
	}
	return driver.MemorySnapshot{ID: snap.ID, OrgID: snap.Org, Purpose: string(snap.Purpose)}, true, nil
}

// CreateSandboxFromSnapshot is driver.Snapshotter's.
func (d *Driver) CreateSandboxFromSnapshot(ctx context.Context, req driver.SandboxRequest, snap driver.MemorySnapshot) (driver.MachineRef, error) {
	if err := refuseSandboxTrust(req); err != nil {
		return driver.MachineRef{}, err
	}
	spec := req.Spec
	p := isolation.Purpose(snap.Purpose)
	if p != isolation.PurposeTemplate && p != isolation.PurposeSession {
		return driver.MachineRef{}, fmt.Errorf("%w: a sandbox starts from a template or a session, not a %s", driver.ErrUnsupported, snap.Purpose)
	}
	return d.CreateSandboxFrom(ctx, spec, isolation.SnapshotRef{ID: snap.ID, Org: snap.OrgID, Purpose: p})
}

// ResetToSnapshot is driver.Snapshotter's: the claim's machine restored in
// its place from its round.
func (d *Driver) ResetToSnapshot(ctx context.Context, ref driver.MachineRef, snap driver.MemorySnapshot) (driver.MachineRef, error) {
	m, ok, err := d.find(ctx, ref.MachineID)
	if err != nil || !ok {
		return driver.MachineRef{}, errors.Join(err, notFound(ok, ref))
	}
	if snap.OrgID != m.Labels[driver.TagOrg] {
		return driver.MachineRef{}, fmt.Errorf("%w: snapshot %s is not the machine's org's", driver.ErrNotOwned, snap.ID)
	}
	got, err := d.cfg.Backend.RestoreInPlace(ctx, ref.MachineID, isolation.SnapshotRef{ID: snap.ID, Org: snap.OrgID, Purpose: isolation.Purpose(snap.Purpose)})
	if err != nil {
		return driver.MachineRef{}, err
	}
	return d.sameRef(ref, got), nil
}

// Taint records, before the thing is handed over, why this cell's machine
// may never be snapshotted.
func (d *Driver) Taint(ctx context.Context, ref driver.MachineRef, why isolation.Taint) error {
	if _, ok, err := d.find(ctx, ref.MachineID); err != nil || !ok {
		return errors.Join(err, notFound(ok, ref))
	}
	return d.cfg.Backend.Taint(ctx, ref.MachineID, why)
}

// Create makes a claim's machine. A workload is an environment microVM (the
// kit's environment base, Docker inside, a data disk), restored from the
// environment's template when its image is one; an observer is a small
// microVM of the sandbox base running the guest agent's observer mode,
// reached over its vsock only.
func (d *Driver) Create(ctx context.Context, spec driver.MachineSpec) (driver.MachineRef, error) {
	if spec.Role == driver.RoleObserver {
		spec.ImageID, spec.ImageRef = "observer", "observer"
		spec.ClaimSize = driver.ClaimSize{MemoryMB: d.cfg.ObserverMemoryMB, CPUs: 1}
		ref, err := d.create(ctx, spec, isolation.ShapeSandbox)
		if err != nil {
			return driver.MachineRef{}, err
		}
		if err := d.startObserver(ctx, ref); err != nil {
			return driver.MachineRef{}, errors.Join(err, d.Destroy(context.WithoutCancel(ctx), ref))
		}
		return ref, nil
	}
	if vmsnap.ValidID(spec.ImageID) && spec.EnvironmentID == "" {
		// A claim that names no environment cannot show the template is its
		// environment's (the hub is untrusted): it boots cold (N5).
		d.cfg.Log.Warn("microvm.template.unavailable", "image", spec.ImageID, "claim", spec.ClaimID, "reason", "the claim names no environment")
	} else if vmsnap.ValidID(spec.ImageID) {
		// Only a template, and only of the claim's environment (F2-03).
		snap := isolation.SnapshotRef{ID: spec.ImageID, Org: spec.OrgID, Purpose: isolation.PurposeTemplate, Key: TemplateKey(spec.EnvironmentID)}
		ref, err := d.restore(ctx, spec, snap, isolation.ShapeEnvironment)
		// A template is restored only where it was made, on the same kit and
		// host (Manifest.Restorable): one this cell does not hold, or holds
		// from another kit or host, is no image here, and the machine boots
		// cold from the claim's checkout, as a bake made on another cell does
		// on a container cell. Nothing of the template is read.
		// A restore that failed for another reason (the VMM, a disk) boots
		// cold too: the backend destroyed the half-made machine, and a
		// template is an accelerator, never a dependency. A tampered or
		// changed template is a refusal (vmsnap.Store.Open). A claim
		// cancelled meanwhile fails.
		switch {
		case err == nil:
			return ref, nil
		case ctx.Err() != nil:
			return ref, err
		case errors.Is(err, vmsnap.ErrRefused):
			d.cfg.Log.Warn("microvm.template.unavailable", "image", spec.ImageID, "claim", spec.ClaimID, "reason", err.Error())
		default:
			d.cfg.Log.Warn("microvm.template.restore_failed", "image", spec.ImageID, "claim", spec.ClaimID, "err", err.Error())
		}
	}
	return d.create(ctx, spec, isolation.ShapeEnvironment)
}

// CreateSandbox makes a code sandbox: a microVM of the kit's sandbox base,
// read-only, the guest agent as its user 1000.
func (d *Driver) CreateSandbox(ctx context.Context, req driver.SandboxRequest) (driver.MachineRef, error) {
	if err := refuseSandboxTrust(req); err != nil {
		return driver.MachineRef{}, err
	}
	spec := req.Spec
	if spec.Role != driver.RolePool {
		spec.Role = driver.RoleWorkload
	}
	spec.ImageID, spec.ImageRef = "sandbox", "sandbox"
	return d.create(ctx, spec, isolation.ShapeSandbox)
}

// refuseSandboxTrust refuses a sandbox that must trust the cell CA: a
// sandbox VM's root is read-only and nothing mounts the cell's files into
// it yet (Capabilities SandboxCellTrust false). It used to be made without
// them while the agent counted it trusted.
func refuseSandboxTrust(req driver.SandboxRequest) error {
	if req.CellTrust {
		return fmt.Errorf("%w: microvm sandboxes take no cell trust files", driver.ErrUnsupported)
	}
	return nil
}

// find is this cell's machine of that name; ok false when the backend
// holds none, ErrNotOwned when it holds another cell's.
func (d *Driver) find(ctx context.Context, name string) (isolation.Listed, bool, error) {
	all, err := d.cfg.Backend.Inventory(ctx)
	if err != nil {
		return isolation.Listed{}, false, err
	}
	for _, m := range all {
		if m.Name != name {
			continue
		}
		if m.Labels[driver.TagCell] != d.cfg.CellID {
			return isolation.Listed{}, false, fmt.Errorf("%w: machine %s", driver.ErrNotOwned, name)
		}
		return m, true, nil
	}
	return isolation.Listed{}, false, nil
}

// DialGuest opens the stream to the guest agent of this cell's machine.
func (d *Driver) DialGuest(ctx context.Context, ref driver.MachineRef) (io.ReadWriteCloser, error) {
	_, ok, err := d.find(ctx, ref.MachineID)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, fmt.Errorf("microvm: machine %s is gone", ref.MachineID)
	}
	return d.cfg.Backend.DialGuest(ctx, ref.MachineID)
}

// Destroy ends this cell's machine; one already gone is fine. A setup's
// machine a bake pinned waits for the bake, which ends it.
func (d *Driver) Destroy(ctx context.Context, ref driver.MachineRef) error {
	_, ok, err := d.find(ctx, ref.MachineID)
	if err != nil || !ok {
		return err
	}
	d.mu.Lock()
	pinned := d.pinned[ref.MachineID]
	d.mu.Unlock()
	if pinned {
		return nil
	}
	if err := d.cfg.Backend.Destroy(ctx, ref.MachineID, isolation.DestroyOptions{}); err != nil {
		return err
	}
	d.mu.Lock()
	delete(d.expires, ref.MachineID)
	delete(d.uploads, ref.MachineID)
	delete(d.built, ref.MachineID)
	delete(d.initdb, ref.MachineID)
	d.mu.Unlock()
	return nil
}

// List is this cell's machines whose tags match selector.
func (d *Driver) List(ctx context.Context, selector map[string]string) ([]driver.MachineRef, error) {
	if cell, ok := selector[driver.TagCell]; ok && cell != d.cfg.CellID {
		return nil, nil
	}
	all, err := d.cfg.Backend.Inventory(ctx)
	if err != nil {
		return nil, err
	}
	var out []driver.MachineRef
	for _, m := range all {
		if m.Labels[driver.TagCell] != d.cfg.CellID {
			continue
		}
		tags := make(map[string]string, len(m.Labels))
		for k, v := range m.Labels {
			tags[k] = v
		}
		d.mu.Lock()
		if e, ok := d.expires[m.Name]; ok {
			tags[driver.TagExpires] = driver.FormatTime(e)
		}
		d.mu.Unlock()
		if !driver.Matches(tags, selector) {
			continue
		}
		out = append(out, driver.MachineRef{MachineID: m.Name, DriverRef: m.ID, PrivateAddress: m.Addresses[networkName(tags[driver.TagClaim])], ImageID: tags["kodus:image"], Tags: tags})
	}
	return out, nil
}

// SetExpiry moves kodus:expires, held under the machine's ceiling.
func (d *Driver) SetExpiry(ctx context.Context, ref driver.MachineRef, at time.Time) error {
	m, ok, err := d.find(ctx, ref.MachineID)
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("%w: machine %s", driver.ErrNotOwned, ref.MachineID)
	}
	at, err = driver.ClampToCeiling(at, m.Labels)
	if err != nil {
		return fmt.Errorf("microvm: machine %s: %w", ref.MachineID, err)
	}
	d.mu.Lock()
	d.expires[ref.MachineID] = at
	d.mu.Unlock()
	return nil
}

func (d *Driver) Suspend(ctx context.Context, ref driver.MachineRef, _ driver.SuspendMode) error {
	if _, ok, err := d.find(ctx, ref.MachineID); err != nil || !ok {
		return errors.Join(err, notFound(ok, ref))
	}
	return d.cfg.Backend.Pause(ctx, ref.MachineID)
}

func (d *Driver) Resume(ctx context.Context, ref driver.MachineRef) error {
	if _, ok, err := d.find(ctx, ref.MachineID); err != nil || !ok {
		return errors.Join(err, notFound(ok, ref))
	}
	return d.cfg.Backend.Start(ctx, ref.MachineID)
}

func notFound(ok bool, ref driver.MachineRef) error {
	if ok {
		return nil
	}
	return fmt.Errorf("microvm: no machine %s", ref.MachineID)
}

// Sweep destroys this cell's machines past their ceiling (driver.Expired),
// and the snapshots the backend's policy no longer keeps. A lease nobody
// renewed is the lease manager's to end.
func (d *Driver) Sweep(ctx context.Context, now time.Time) ([]string, error) {
	refs, err := d.List(ctx, nil)
	if err != nil {
		return nil, err
	}
	var gone []string
	var errs []error
	if _, err := d.cfg.Backend.SweepSnapshots(now); err != nil {
		errs = append(errs, err)
	}
	for _, r := range refs {
		if !driver.Expired(r.Tags, now) {
			continue
		}
		if err := d.Destroy(ctx, r); err != nil {
			errs = append(errs, err)
			continue
		}
		gone = append(gone, r.MachineID)
	}
	return gone, errors.Join(errs...)
}

// RunsEnvironments says whether -isolation-backend auto may pick a microvm
// cell for environments (Runs and setups) as well as code sandboxes. The
// compose boot inside a VM is wired (P3, docs/runtime/isolation-p3-snapshots.md),
// but auto stays on gVisor until the P3 security review chooses otherwise;
// -isolation-backend firecracker picks it explicitly.
const RunsEnvironments = false

// ForgetSession is driver.SessionForgetter: the org's session goes now
// (its PR closed or merged); a template or a round is refused.
func (d *Driver) ForgetSession(_ context.Context, orgID, snapshotID string) error {
	if !vmsnap.ValidID(snapshotID) {
		return fmt.Errorf("microvm: %q is not a snapshot id", snapshotID)
	}
	return d.cfg.Backend.ForgetSession(orgID, snapshotID)
}

var _ driver.SessionForgetter = (*Driver)(nil)
