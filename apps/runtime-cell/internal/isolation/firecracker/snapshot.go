package firecracker

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/guestinit"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation/vmsnap"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/vsock"
)

// Paths of a snapshot inside a jail, as the jailed firecracker sees them.
const (
	jailSnapDir  = "/snapshot"
	jailVMState  = "/vmstate"
	jailMemory   = "/mem"
	controlWait  = 10 * time.Second
	prepareWait  = 15 * time.Second
	restoreReady = 10 * time.Second
)

// taints are the known taints of a spec, once each.
func taints(ts []isolation.Taint) []isolation.Taint {
	var out []isolation.Taint
	for _, t := range ts {
		if !slices.Contains(out, t) {
			out = append(out, t)
		}
	}
	return out
}

// Taint records why the machine may never be snapshotted. A taint the
// rules do not know is refused, so a caller's typo never reads as clean.
func (b *Backend) Taint(_ context.Context, name string, why isolation.Taint) error {
	if !vmsnap.KnownTaint(why) {
		return fmt.Errorf("firecracker: unknown taint %q", why)
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	r, ok, err := b.recordOf(name)
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("firecracker: no machine %s", name)
	}
	if slices.Contains(r.Taints, why) {
		return nil
	}
	r.Taints = append(r.Taints, why)
	return b.writeRecord(r)
}

// control sends one request to the guest's init on its control port and
// returns its answer; a dial the guest does not take yet (it is still
// coming back from a restore) is tried again until wait.
func (b *Backend) control(ctx context.Context, id string, req guestinit.ControlRequest, wait time.Duration) (guestinit.ControlReply, error) {
	ctx, cancel := context.WithTimeout(ctx, wait)
	defer cancel()
	uds := filepath.Join(b.rootDir(id), "v.sock")
	for {
		c, err := vsock.Dial(ctx, uds, guestinit.ControlPort)
		if err != nil {
			if errors.Is(err, vsock.ErrNotListening) && ctx.Err() == nil {
				time.Sleep(2 * time.Millisecond)
				continue
			}
			return guestinit.ControlReply{}, fmt.Errorf("firecracker: the guest's init on %s: %w", id, err)
		}
		if dl, ok := ctx.Deadline(); ok {
			_ = c.SetDeadline(dl)
		}
		if req.Rebirth != nil {
			req.Rebirth.UnixNano = time.Now().UnixNano()
		}
		err = guestinit.WriteControl(c, req)
		var rep guestinit.ControlReply
		if err == nil {
			err = guestinit.ReadControl(c, &rep)
		}
		_ = c.Close()
		if err != nil {
			return guestinit.ControlReply{}, fmt.Errorf("firecracker: the guest's init on %s: %w", id, err)
		}
		if !rep.OK {
			return rep, fmt.Errorf("firecracker: the guest's init on %s refused %s: %s", id, req.Op, rep.Error)
		}
		return rep, nil
	}
}

// Snapshot keeps the machine for req.Purpose and ends it. The rules come
// first (vmsnap.Admit, on the backend's own record), then the guest's init
// (it refuses what no snapshot may hold and freezes the workload), then
// the VMM's snapshot into the jail, whose files move into the store with
// the environment's disks as they were. A failure before the VMM wrote its
// snapshot thaws and resumes the machine; after, the machine ends anyway:
// it never runs on once a snapshot of it exists
// (docs/snapshotting/snapshot-support.md, "Usage examples").
func (b *Backend) Snapshot(ctx context.Context, name string, req isolation.SnapshotRequest) (ref isolation.SnapshotRef, err error) {
	r, ok, err := b.recordOf(name)
	if err != nil {
		return isolation.SnapshotRef{}, err
	}
	if !ok {
		return isolation.SnapshotRef{}, fmt.Errorf("firecracker: no machine %s", name)
	}
	if err := vmsnap.Admit(r.facts(), req.Purpose, req.Org); err != nil {
		return isolation.SnapshotRef{}, err
	}
	if r.MemoryMB < 128 || r.VCPUs < 1 {
		return isolation.SnapshotRef{}, fmt.Errorf("firecracker: machine %s has no recorded size", name)
	}
	root := b.rootDir(r.ID)
	need := int64(r.MemoryMB) << 20
	if r.Shape == isolation.ShapeEnvironment {
		need += allocatedOf(filepath.Join(root, strings.TrimPrefix(jailRootfs, "/"))) + allocatedOf(filepath.Join(root, strings.TrimPrefix(jailData, "/")))
	}
	if _, err := b.store.Sweep(time.Now(), b.cfg.Snapshots); err != nil {
		return isolation.SnapshotRef{}, err
	}
	if err := b.store.Room(r.Org, need, b.cfg.Snapshots); err != nil {
		return isolation.SnapshotRef{}, err
	}
	if _, err := b.control(ctx, r.ID, guestinit.ControlRequest{Op: guestinit.OpPrepare, Purpose: string(req.Purpose)}, prepareWait); err != nil {
		return isolation.SnapshotRef{}, err
	}
	a := b.apiOf(r.ID)
	taken := false
	defer func() {
		if err == nil {
			return
		}
		bg := context.WithoutCancel(ctx)
		if taken {
			b.transition(r.ID, isolation.StateFailed, "snapshot: "+err.Error())
			err = errors.Join(err, b.Destroy(bg, name, isolation.DestroyOptions{}))
			return
		}
		err = errors.Join(err, a.setState(bg, "Resumed"))
		_, terr := b.control(bg, r.ID, guestinit.ControlRequest{Op: guestinit.OpThaw}, controlWait)
		err = errors.Join(err, terr)
	}()
	if err := a.setState(ctx, "Paused"); err != nil {
		return isolation.SnapshotRef{}, err
	}
	b.transition(r.ID, isolation.StatePaused, "for a "+string(req.Purpose)+" snapshot")
	snapDir := filepath.Join(root, strings.TrimPrefix(jailSnapDir, "/"))
	if err := os.Mkdir(snapDir, 0o700); err != nil {
		return isolation.SnapshotRef{}, err
	}
	if err := b.checks.Chown(snapDir, r.UID, r.UID); err != nil {
		return isolation.SnapshotRef{}, err
	}
	// sync_snapshot_files false: the VMM returns before the writeback;
	// Publish reads every file back to its digest and syncs it before the
	// manifest exists.
	body := map[string]any{
		"snapshot_type": "Full", "snapshot_path": jailSnapDir + "/" + vmsnap.FileState,
		"mem_file_path": jailSnapDir + "/" + vmsnap.FileMem, "sync_snapshot_files": false,
	}
	taken = true // from here a partial snapshot may exist: the machine never resumes
	if err := b.roomForCreate(r); err != nil {
		return isolation.SnapshotRef{}, err
	}
	if err := a.doWithin(ctx, createTimeout(r.MemoryMB), http.MethodPut, "/snapshot/create", body, nil); err != nil {
		return isolation.SnapshotRef{}, err
	}
	id, staged, err := b.store.Stage(r.Org)
	if err != nil {
		return isolation.SnapshotRef{}, err
	}
	defer func() {
		if err != nil {
			_ = os.RemoveAll(staged)
		}
	}()
	for _, f := range []string{vmsnap.FileState, vmsnap.FileMem} {
		if err := os.Rename(filepath.Join(snapDir, f), filepath.Join(staged, f)); err != nil {
			return isolation.SnapshotRef{}, err
		}
	}
	m := vmsnap.Manifest{
		ID: id, Org: r.Org, Purpose: req.Purpose, Shape: r.Shape, Created: time.Now().UTC(), Source: name,
		MemoryMB: r.MemoryMB, VCPUs: r.VCPUs, Kit: b.here.Kit, Host: b.here.Host,
	}
	switch req.Purpose {
	case isolation.PurposeTemplate:
		m.Key = req.Key
	case isolation.PurposeRound:
		m.Claim = r.Claim
	case isolation.PurposeSession:
	}
	switch r.Shape {
	case isolation.ShapeEnvironment:
		// The VMM synced its disks during the snapshot; the clones are
		// those disks at that instant.
		for f, j := range map[string]string{vmsnap.FileRoot: jailRootfs, vmsnap.FileData: jailData} {
			if err := b.checks.Reflink(filepath.Join(root, strings.TrimPrefix(j, "/")), filepath.Join(staged, f)); err != nil {
				return isolation.SnapshotRef{}, err
			}
		}
	default:
		profile := guestinit.Sandbox
		m.RootBase = b.cfg.Kit.Manifest.Rootfs[profile].SHA256
	}
	if r.Network != "" {
		m.Network = true
	}
	if _, err := b.store.Publish(staged, m); err != nil {
		return isolation.SnapshotRef{}, err
	}
	if m.Key != "" {
		// A new template of a key replaces the org's others (a new setup).
		if _, err := b.store.RetireKey(r.Org, m.Key, id); err != nil {
			return isolation.SnapshotRef{}, err
		}
	}
	b.transition(r.ID, isolation.StateSnapshotted, string(req.Purpose)+" "+id)
	if err := b.Destroy(context.WithoutCancel(ctx), name, isolation.DestroyOptions{}); err != nil {
		return isolation.SnapshotRef{}, errors.Join(err, b.store.Remove(r.Org, id))
	}
	return isolation.SnapshotRef{ID: id, Machine: name, Org: r.Org, Purpose: req.Purpose}, nil
}

// Restore makes spec's machine from org's snapshot snap.ID, org being the
// spec's (never the ref's): the store finds the snapshot only under it.
// The machine gets its own user, tap, jail and disks as Create gives them;
// its memory is the snapshot's file, mapped private by the VMM through a
// hard link (so every machine of one template shares its pages in the
// host's cache); then the guest's init makes it its own (OpRebirth) before
// Restore returns. A session is claimed first, so it restores once, and
// removed once its machine runs.
func (b *Backend) Restore(ctx context.Context, snap isolation.SnapshotRef, spec isolation.Spec) (m isolation.Machine, err error) {
	if spec.Name == "" || spec.Org == "" {
		return isolation.Machine{}, errors.New("firecracker: a restore needs the machine's name and org")
	}
	var (
		man vmsnap.Manifest
		dir string
	)
	if snap.Purpose == isolation.PurposeSession {
		man, dir, err = b.store.Claim(spec.Org, snap.ID)
		if err == nil {
			defer func() { err = errors.Join(err, b.store.Remove(spec.Org, snap.ID)) }()
		}
	} else {
		man, dir, err = b.store.Open(spec.Org, snap.ID)
	}
	if err != nil {
		return isolation.Machine{}, err
	}
	if err := man.Restorable(b.here, spec.Shape); err != nil {
		return isolation.Machine{}, err
	}
	if man.Purpose == isolation.PurposeRound && (spec.Claim != man.Claim || spec.Name != man.Source) {
		return isolation.Machine{}, fmt.Errorf("%w: round snapshot %s restores only into machine %s of its claim", vmsnap.ErrRefused, man.ID, man.Source)
	}
	if man.Network != (spec.Network != "") {
		return isolation.Machine{}, fmt.Errorf("%w: snapshot %s network %v, machine network %q", vmsnap.ErrRefused, man.ID, man.Network, spec.Network)
	}
	id := idOf(spec.Name)
	b.mu.Lock()
	if _, err := os.Stat(b.recordPath(id)); err == nil {
		b.mu.Unlock()
		return isolation.Machine{}, fmt.Errorf("firecracker: machine %s exists", spec.Name)
	}
	data := man.Files[vmsnap.FileData].Size // a restore's data disk is its snapshot's
	err = b.diskRoom(spec.Shape, data)
	var uid int
	if err == nil {
		uid, err = b.allocUID()
	}
	if err == nil {
		err = b.writeRecord(Record{
			Name: spec.Name, ID: id, UID: uid, Shape: spec.Shape, Network: spec.Network, Labels: spec.Labels, Created: time.Now().UTC(),
			Org: spec.Org, Claim: spec.Claim, Pool: spec.Pool, Taints: taints(spec.Taints), MemoryMB: man.MemoryMB, VCPUs: man.VCPUs, Restored: man.ID, DataBytes: data,
		})
	}
	b.mu.Unlock()
	if err != nil {
		return isolation.Machine{}, err
	}
	b.transition(id, isolation.StateRestoring, string(man.Purpose)+" "+man.ID)
	defer func() {
		if err != nil {
			b.transition(id, isolation.StateFailed, err.Error())
			err = errors.Join(err, b.Destroy(context.WithoutCancel(ctx), spec.Name, isolation.DestroyOptions{}))
		}
	}()
	vm := VM{VCPUs: man.VCPUs, MemoryMB: man.MemoryMB, ReadOnlyRoot: spec.Shape == isolation.ShapeSandbox, DataDisk: spec.Shape == isolation.ShapeEnvironment, Rates: ratesOf(b.cfg.Limits, man.VCPUs)}
	reb := guestinit.Rebirth{Hostname: id}
	if reb.Seed, err = randomBytes(guestinit.SeedBytes); err != nil {
		return isolation.Machine{}, err
	}
	if reb.BootID, reb.MachineID, err = newIDs(); err != nil {
		return isolation.Machine{}, err
	}
	ip, netns := "", ""
	if spec.Network != "" {
		var want netip.Addr
		if spec.Address != "" {
			if want, err = netip.ParseAddr(spec.Address); err != nil {
				return isolation.Machine{}, fmt.Errorf("firecracker: address %q: %w", spec.Address, err)
			}
		}
		at, err := b.cfg.Network.AttachTapAt(ctx, spec.Network, spec.Name, uid, want)
		if err != nil {
			return isolation.Machine{}, err
		}
		netns = at.Netns
		vm.Net = &Net{Tap: at.Tap, MAC: at.MAC, IP: at.IP, Gateway: at.Gateway, Prefix: at.Prefix}
		reb.Net = &guestinit.NetConfig{MAC: at.MAC, IP: at.IP, Prefix: at.Prefix, Gateway: at.Gateway}
		reb.DNS = at.DNS
		ip = at.IP.String()
		if err := b.updateRecord(id, func(r *Record) { r.IP = ip }); err != nil {
			return isolation.Machine{}, err
		}
	}
	if err := b.makeRestoreJail(id, uid, dir, vm); err != nil {
		return isolation.Machine{}, err
	}
	rootBytes := man.Files[vmsnap.FileRoot].Size
	if spec.Shape == isolation.ShapeSandbox {
		rootBytes = b.cfg.Kit.Manifest.Rootfs[guestinit.Sandbox].Size
	}
	jail := Jail{
		ID: id, Exec: b.cfg.Kit.Path(b.cfg.Kit.Manifest.Firecracker), UID: uid, GID: uid,
		ChrootBase: filepath.Join(b.cfg.StateDir, "jail"), CgroupParent: b.cfg.CgroupParent, MemoryMB: man.MemoryMB, CPUs: man.VCPUs,
		FileBytes: vm.FileBytes(rootBytes, man.Files[vmsnap.FileData].Size), Restore: true, Netns: netns,
	}
	if err := b.launcher().Launch(ctx, b.cfg.Kit.Path(b.cfg.Kit.Manifest.Jailer), jail.Args()); err != nil {
		return isolation.Machine{}, fmt.Errorf("firecracker: jailer: %w", err)
	}
	b.transition(id, isolation.StateLaunched, "")
	if err := b.boundIO(id, vm.Rates); err != nil {
		return isolation.Machine{}, err
	}
	a := b.apiOf(id)
	if err := b.waitAPI(ctx, a); err != nil {
		return isolation.Machine{}, err
	}
	if err := a.do(ctx, http.MethodPut, "/logger", map[string]any{"log_path": jailLog, "level": "Warning"}, nil); err != nil {
		return isolation.Machine{}, err
	}
	load := map[string]any{
		"snapshot_path": jailVMState,
		"mem_backend":   map[string]any{"backend_type": "File", "backend_path": jailMemory},
		"resume_vm":     true,
	}
	if b.cfg.Host.Arch == "x86_64" {
		// kvmclock moves on by the time since the snapshot before a guest
		// instruction runs; init then sets the wall clock to the host's.
		load["clock_realtime"] = true
	}
	if vm.Net != nil {
		load["network_overrides"] = []map[string]any{{"iface_id": "eth0", "host_dev_name": vm.Net.Tap}}
	}
	if err := a.do(ctx, http.MethodPut, "/snapshot/load", load, nil); err != nil {
		return isolation.Machine{}, err
	}
	// A snapshot keeps the buckets it was taken with (none before limits.go):
	// the restored machine gets this cell's, as a machine booted now would.
	if err := b.limit(ctx, a, vm); err != nil {
		return isolation.Machine{}, err
	}
	rep, err := b.control(ctx, id, guestinit.ControlRequest{Op: guestinit.OpRebirth, Rebirth: &reb}, restoreReady)
	if err != nil {
		return isolation.Machine{}, err
	}
	if rep.BootID != reb.BootID {
		return isolation.Machine{}, fmt.Errorf("firecracker: machine %s reads boot id %q after its rebirth", spec.Name, rep.BootID)
	}
	b.transition(id, isolation.StateRunning, "")
	pid, _ := b.pid(id)
	m = isolation.Machine{Name: spec.Name, ID: id, PID: pid, Addresses: map[string]string{}}
	if ip != "" {
		m.Addresses[spec.Network] = ip
	}
	return m, nil
}

func (b *Backend) updateRecord(id string, f func(*Record)) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	r, err := b.readRecord(id)
	if err != nil {
		return err
	}
	f(&r)
	return b.writeRecord(r)
}

// makeRestoreJail lays a restored machine's files in its jail: the state
// file (a copy, the VMM's), the memory file (a hard link to the store's,
// read-only for everyone, so the jailed VMM maps it and changes nothing),
// the root (the kit's base for a sandbox, the snapshot's disk for an
// environment) and the data disk as Create gives them, and the log.
func (b *Backend) makeRestoreJail(id string, uid int, dir string, vm VM) error {
	root := b.rootDir(id)
	if err := os.MkdirAll(root, 0o700); err != nil {
		return err
	}
	in := func(p string) string { return filepath.Join(root, strings.TrimPrefix(p, "/")) }
	if err := copyOwned(filepath.Join(dir, vmsnap.FileState), in(jailVMState)); err != nil {
		return err
	}
	if err := os.Link(filepath.Join(dir, vmsnap.FileMem), in(jailMemory)); err != nil {
		return fmt.Errorf("firecracker: link the memory file: %w", err)
	}
	owned := []string{in(jailVMState)}
	if vm.ReadOnlyRoot {
		if err := b.checks.Reflink(b.bases[b.cfg.Kit.Manifest.Rootfs[guestinit.Sandbox].Path], in(jailRootfs)); err != nil {
			return err
		}
	} else {
		if err := b.checks.Reflink(filepath.Join(dir, vmsnap.FileRoot), in(jailRootfs)); err != nil {
			return err
		}
		if err := b.checks.Reflink(filepath.Join(dir, vmsnap.FileData), in(jailData)); err != nil {
			return err
		}
		owned = append(owned, in(jailData))
	}
	owned = append(owned, in(jailRootfs))
	if err := os.WriteFile(in(jailLog), nil, 0o600); err != nil {
		return err
	}
	owned = append(owned, in(jailLog))
	for _, p := range owned {
		if err := b.checks.Chown(p, uid, uid); err != nil {
			return err
		}
		mode := os.FileMode(0o600)
		if p == in(jailVMState) || (vm.ReadOnlyRoot && p == in(jailRootfs)) {
			mode = 0o400
		}
		if err := os.Chmod(p, mode); err != nil {
			return err
		}
	}
	return nil
}

func copyOwned(src, dst string) error {
	in, err := os.Open(src) //nolint:gosec // G304: a file of the backend's snapshot store
	if err != nil {
		return err
	}
	defer func() { _ = in.Close() }()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600) //nolint:gosec // G304: a path in the machine's own jail
	if err != nil {
		return err
	}
	_, err = io.Copy(out, in)
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	return err
}

// waitAPI waits for a VMM started for a restore to answer on its API.
func (b *Backend) waitAPI(ctx context.Context, a api) error {
	deadline := time.Now().Add(15 * time.Second)
	var last error
	for time.Now().Before(deadline) {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		_, err := a.state(ctx)
		if err == nil {
			return nil
		}
		last = err
		time.Sleep(2 * time.Millisecond)
	}
	return fmt.Errorf("firecracker: the restored VMM's API never answered: %w", last)
}

func randomBytes(n int) ([]byte, error) {
	b := make([]byte, n)
	_, err := rand.Read(b)
	return b, err
}

// newIDs are a random boot id (a version 4 UUID) and machine id.
func newIDs() (bootID, machineID string, err error) {
	b, err := randomBytes(32)
	if err != nil {
		return "", "", err
	}
	u := b[:16]
	u[6] = u[6]&0x0f | 0x40
	u[8] = u[8]&0x3f | 0x80
	h := hex.EncodeToString(u)
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32], hex.EncodeToString(b[16:]), nil
}

// SweepSnapshots removes the snapshots the policy no longer keeps.
// A round whose claim no longer has a machine here goes too, whatever its
// age past OrphanGrace: nothing of a PR's machine outlives the claim.
func (b *Backend) SweepSnapshots(now time.Time) ([]string, error) {
	rs, err := b.Machines()
	if err != nil {
		return nil, err
	}
	live := map[string]bool{}
	for i := range rs {
		live[rs[i].Org+"\x00"+rs[i].Claim] = true
	}
	p := b.cfg.Snapshots
	p.LiveClaim = func(org, claim string) bool { return live[org+"\x00"+claim] }
	return b.store.Sweep(now, p)
}

// ForgetSession removes org's session id now (its PR closed or merged);
// a template or a round is refused, and one the store does not hold is
// already gone.
func (b *Backend) ForgetSession(org, id string) error {
	man, _, err := b.store.Open(org, id)
	if err != nil {
		if errors.Is(err, vmsnap.ErrRefused) {
			return nil // not held here (or not this org's): nothing of it to remove
		}
		return err
	}
	if man.Purpose != isolation.PurposeSession {
		return fmt.Errorf("%w: snapshot %s is a %s, not a session", vmsnap.ErrRefused, id, man.Purpose)
	}
	return b.store.Remove(org, id)
}

// DataAllocated is what a machine's data disk holds on the host: its
// high-water mark, the guest never giving freed blocks back.
func (b *Backend) DataAllocated(name string) (int64, error) {
	r, ok, err := b.recordOf(name)
	if err != nil {
		return 0, err
	}
	if !ok {
		return 0, fmt.Errorf("firecracker: no machine %s", name)
	}
	return allocatedOf(filepath.Join(b.rootDir(r.ID), strings.TrimPrefix(jailData, "/"))), nil
}

// Store is the backend's snapshot store (tests and the audit read it).
func (b *Backend) Store() *vmsnap.Store { return b.store }

// allocatedOf is the disk a file takes (its blocks: a data disk is sparse).
func allocatedOf(p string) int64 {
	fi, err := os.Stat(p)
	if err != nil {
		return 0
	}
	if st, ok := fi.Sys().(*syscall.Stat_t); ok {
		return st.Blocks * 512
	}
	return fi.Size()
}

// specOf is the spec of the machine a record holds, at its address: what
// it is restored as when it is restored into its own place.
func (r Record) specOf() isolation.Spec {
	return isolation.Spec{
		Shape: r.Shape, Name: r.Name, Network: r.Network, Labels: r.Labels, Org: r.Org, Claim: r.Claim,
		Pool: r.Pool, Taints: r.Taints, Address: r.IP,
	}
}

// SnapshotRound keeps the machine as its claim's round snapshot and brings
// it back at once from it, in its own place (its name and address), reborn:
// the claim's first round runs on a restored machine like every later one.
func (b *Backend) SnapshotRound(ctx context.Context, name string) (isolation.SnapshotRef, isolation.Machine, error) {
	r, ok, err := b.recordOf(name)
	if err != nil {
		return isolation.SnapshotRef{}, isolation.Machine{}, err
	}
	if !ok {
		return isolation.SnapshotRef{}, isolation.Machine{}, fmt.Errorf("firecracker: no machine %s", name)
	}
	snap, err := b.Snapshot(ctx, name, isolation.SnapshotRequest{Purpose: isolation.PurposeRound, Org: r.Org})
	if err != nil {
		return isolation.SnapshotRef{}, isolation.Machine{}, err
	}
	m, err := b.Restore(ctx, snap, r.specOf())
	return snap, m, err
}

// RestoreInPlace ends the machine and restores it from its claim's round
// snapshot snap, in its own place and reborn (machine.reset kind memory).
func (b *Backend) RestoreInPlace(ctx context.Context, name string, snap isolation.SnapshotRef) (isolation.Machine, error) {
	r, ok, err := b.recordOf(name)
	if err != nil {
		return isolation.Machine{}, err
	}
	if !ok {
		return isolation.Machine{}, fmt.Errorf("firecracker: no machine %s", name)
	}
	if snap.Purpose != isolation.PurposeRound {
		return isolation.Machine{}, fmt.Errorf("%w: only a round snapshot restores a machine in its place", vmsnap.ErrRefused)
	}
	// The snapshot is checked before the machine ends: a refusal leaves the
	// claim its machine.
	man, _, err := b.store.Open(r.Org, snap.ID)
	if err != nil {
		return isolation.Machine{}, err
	}
	if man.Purpose != isolation.PurposeRound || man.Claim != r.Claim || man.Source != name {
		return isolation.Machine{}, fmt.Errorf("%w: snapshot %s is not machine %s's round", vmsnap.ErrRefused, snap.ID, name)
	}
	if err := b.Destroy(ctx, name, isolation.DestroyOptions{}); err != nil {
		return isolation.Machine{}, err
	}
	return b.Restore(ctx, snap, r.specOf())
}

// LatestTemplate is org's newest template of key this host restores into a
// machine of shape; ok false when there is none.
func (b *Backend) LatestTemplate(org, key string, shape isolation.Shape) (isolation.SnapshotRef, bool, error) {
	m, ok, err := b.store.Latest(org, key, b.here, shape)
	if err != nil || !ok {
		return isolation.SnapshotRef{}, false, err
	}
	return isolation.SnapshotRef{ID: m.ID, Machine: m.Source, Org: m.Org, Purpose: m.Purpose}, true, nil
}

// ForgetClaim removes org's claim's round snapshots: they go with the claim.
func (b *Backend) ForgetClaim(org, claim string) error {
	_, err := b.store.RemoveClaim(org, claim)
	return err
}

// roomForCreate gives a paused VMM room in its cgroup for the whole memory
// file its create writes. The file goes through the host's page cache,
// charged to the VMM's cgroup, and with the guest's memory touched only
// vmmCacheMB was left for it: on a state disk that writes back slowly (the
// KVM host's direct-I/O loop) a 1 GiB setup VM's VMM was OOM-killed by its
// cgroup halfway through its template's create (anon 994 MB, the rest file
// pages, against 1664 MiB). It is only lifted once the machine will never
// run its guest again (taken), so the guest cannot use the room; the
// machine is destroyed or replaced right after. A cgroup that is not there
// (no VMM) or has no limit is left as it is.
func (b *Backend) roomForCreate(r Record) error {
	p := filepath.Join(b.cgroupDir(r.ID), "memory.max")
	raw, err := os.ReadFile(p) //nolint:gosec // G304: the machine's own cgroup file
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	cur := strings.TrimSpace(string(raw))
	if cur == "max" {
		return nil
	}
	n, err := strconv.ParseInt(cur, 10, 64)
	if err != nil {
		return fmt.Errorf("firecracker: %s reads %q: %w", p, cur, err)
	}
	return os.WriteFile(p, []byte(strconv.FormatInt(n+int64(r.MemoryMB)<<20, 10)), 0o600)
}

// limit sets a running machine's drive and NIC token buckets to vm.Rates.
func (b *Backend) limit(ctx context.Context, a api, vm VM) error {
	if l := vm.Rates.driveLimiter(); l != nil {
		drives := []string{"rootfs"}
		if vm.DataDisk {
			drives = append(drives, "data")
		}
		for _, d := range drives {
			if err := a.do(ctx, http.MethodPatch, "/drives/"+d, map[string]any{"drive_id": d, "rate_limiter": l}, nil); err != nil {
				return fmt.Errorf("firecracker: limit drive %s: %w", d, err)
			}
		}
	}
	if l := vm.Rates.netLimiter(); l != nil && vm.Net != nil {
		if err := a.do(ctx, http.MethodPatch, "/network-interfaces/eth0", map[string]any{"iface_id": "eth0", "rx_rate_limiter": l, "tx_rate_limiter": l}, nil); err != nil {
			return fmt.Errorf("firecracker: limit eth0: %w", err)
		}
	}
	return nil
}
