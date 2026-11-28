// Package isolation is the cell's IsolationBackend port
// (docs/runtime/isolation-architecture.md C3): what makes one machine and
// keeps it apart from the host, under a Placement (internal/placement) that
// says where machines live and how their network attaches.
//
// A backend makes, starts, pauses, snapshots, restores and destroys
// machines, opens the stream to the guest agent inside one, and says what it
// can do. Everything else stays above it and is shared by every backend: the
// claims, leases and reaper, egress and the injector, the build path, the
// registry and the sandbox pool.
//
// Backends: gvisor (runsc under the docker placement, the cell's behaviour
// before the split) and firecracker (microVMs under the host-network
// placement; it refuses with ErrUnavailable on a host that lacks one of its
// prerequisites).
package isolation

import (
	"context"
	"errors"
	"fmt"
	"io"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
)

// Backend names, as hello capabilities.backends carries them.
const (
	GVisor      = "gvisor"
	Firecracker = "firecracker"
)

// Capabilities is what one backend can do.
type Capabilities struct {
	// Backend is the backend's name (GVisor, Firecracker).
	Backend string
	// Isolation is the boundary between a workload and the host.
	Isolation driver.Isolation
	// OCIRuntime is the OCI runtime the placement runs this backend's
	// containers under ("runsc"): the machines' and the cell's own helpers
	// on a claim (builder, registry, data copies, browser). Empty: the
	// backend runs no container on the host (a microVM).
	OCIRuntime string
	// Suspend is how Pause leaves a machine: "stop" (its processes end, its
	// files stay), "hibernate" (its memory is kept) or "none".
	Suspend string
	// SnapshotMemory: Snapshot and Restore keep a machine's memory.
	SnapshotMemory bool
	// NestedDocker: a workload can run containers (compose) in its machine.
	NestedDocker bool
	// Guest is how the cell reaches the guest agent: "stdio" (an exec
	// stream into the machine) or "vsock". Empty: no guest agent.
	Guest string
	// KVM: the backend's machines run on the host's KVM.
	KVM bool
	// Arch are the architectures its machines can run.
	Arch []string
}

// Shape is what a machine is for (the claim's shape).
type Shape string

const (
	// ShapeEnvironment is a Run side's or a setup's machine: the holder of a
	// compose project, or an observer.
	ShapeEnvironment Shape = "environment"
	// ShapeSandbox is a code sandbox: the tool image with the guest agent.
	ShapeSandbox Shape = "sandbox"
)

// Spec is one machine as the shared layer asks for it. Every value comes
// from the cell (its config, the claim's validated ids), never from a
// checkout.
type Spec struct {
	Shape Shape
	// Name is the machine's id (kodus-<claim>-<role>), unique on the cell.
	Name  string
	Image string
	// Network is the claim's network the machine joins; AlsoOn are more
	// networks joined before it starts (an observer's).
	Network string
	AlsoOn  []string
	// Labels are the machine's tags as the placement stores them.
	Labels map[string]string
	// Resolv is the cell's resolver file for the claim ("" with no egress).
	Resolv string
	// CgroupParent is the claim's resource group; empty: none.
	CgroupParent string
	PidsLimit    int
	// DiskSize caps the machine's writable disk; empty: none.
	DiskSize string
	// Rates are its disk and network limits (driver.IOLimits.For); zero:
	// none. Each backend enforces them its own way.
	Rates driver.IORates
	// Mounts are read-only binds of the cell's own directories; Cmd
	// replaces the image's command (an observer's server).
	Mounts []string
	Cmd    []string
	// A sandbox's own bounds: its user, memory and CPUs, and its in-memory
	// /workspace and /tmp.
	User, Memory, CPUs     string
	WorkspaceSize, TmpSize string
	// Tmpfs are more bounded in-memory directories of a sandbox (a layer
	// builder's /opt/kcli/<id>); a backend that cannot give one refuses.
	Tmpfs []Tmpfs
	// Org is the org the machine belongs to: a snapshot of it is that org's
	// and restores only into a machine of the same org. Claim is its claim:
	// a round snapshot restores only into that claim's same machine.
	Org, Claim string
	// Address is the machine's address on Network to keep (a round's
	// restore); empty: the placement's next free one.
	Address string
	// Setup: the machine of a setup claim that runs no PR code, the only
	// one that may become a template. Pool: a pooled machine, never a
	// snapshot source (it is handed to a claim later).
	Setup, Pool bool
	// Taints are why the machine may never be snapshotted, known when it is
	// made (Taint adds more later). A backend records them before the
	// machine exists.
	Taints []Taint
}

// Tmpfs is one in-memory directory of a sandbox, by path and size ("256m").
type Tmpfs struct{ Dir, Size string }

// Machine is one machine a backend made.
type Machine struct {
	Name string
	// ID is the backend's own reference (a container id, a VM id).
	ID string
	// PID is the machine's first process as the host sees it (claim limits
	// verify its cgroup); zero when the host sees none.
	PID int
	// Addresses maps each network the machine joined to its address there.
	Addresses map[string]string
}

// IP is the machine's address on network, or its only address when network
// is empty.
func (m Machine) IP(network string) string {
	if network != "" {
		return m.Addresses[network]
	}
	if len(m.Addresses) == 1 {
		for _, ip := range m.Addresses {
			return ip
		}
	}
	return ""
}

// Listed is one machine a backend holds, as it keeps it: its name, its own
// reference, the labels it was made with and its addresses.
type Listed struct {
	Name      string
	ID        string
	Labels    map[string]string
	Addresses map[string]string
}

// SnapshotRef names a machine snapshot the backend made. Restore never
// trusts its Org: it looks the snapshot up under the org of the machine it
// makes.
type SnapshotRef struct {
	ID      string
	Machine string
	Org     string
	Purpose Purpose
	// Key, on a restore, is the template key the snapshot must carry (its
	// environment's): a template of another environment of the org is
	// refused. Empty: any key.
	Key string
}

// Purpose is what a snapshot is for (docs/runtime/isolation-p3-snapshots.md).
type Purpose string

const (
	// PurposeTemplate is a setup's machine kept so that many machines of
	// its org start from it. Its source never runs again.
	PurposeTemplate Purpose = "template"
	// PurposeSession is one machine set aside and brought back once: it
	// restores a single time, then it is gone.
	PurposeSession Purpose = "session"
	// PurposeRound is a claim's own machine at its first ready state,
	// restored into that claim's same machine on every reset and removed
	// with the claim: never a template, never another claim's.
	PurposeRound Purpose = "round"
)

// Taint is why a machine may never be snapshotted: something entered it
// that every machine restored from the snapshot would hold too.
type Taint string

const (
	// TaintSecrets: the org's secrets (their placeholders) were handed to
	// the machine.
	TaintSecrets Taint = "secrets"
	// TaintCredentials: a credential of the claim (its keys, a token).
	TaintCredentials Taint = "credentials"
	// TaintCanaries: a Run's canaries were planted in it.
	TaintCanaries Taint = "canaries"
	// TaintPRCode: a PR's code ran in it; it may set itself aside
	// (session), never become a template.
	TaintPRCode Taint = "pr_code"
)

// SnapshotRequest is what the shared layer asks of a snapshot.
type SnapshotRequest struct {
	Purpose Purpose
	// Org is the org the caller believes the machine is of; the backend
	// refuses when its own record says otherwise.
	Org string
	// Key is a template's key in its org (a repository, a tool set): the
	// newest template of a key replaces the others.
	Key string
}

// DestroyOptions says what Destroy keeps.
type DestroyOptions struct {
	// KeepData leaves the machine's data volumes for a bake that copies
	// them; the bake removes them when it is done.
	KeepData bool
}

// Backend makes and ends machines. Every method acts only on a machine the
// shared layer checked is this cell's.
type Backend interface {
	Capabilities() Capabilities
	// Create makes and boots the machine for spec.
	Create(ctx context.Context, spec Spec) (Machine, error)
	// Discard removes a machine Create made whose workload never ran (the
	// undo of a create that failed a check).
	Discard(ctx context.Context, name string) error
	// Start runs a paused machine's processes again.
	Start(ctx context.Context, name string) error
	// Pause stops the machine's processes as Capabilities().Suspend says.
	Pause(ctx context.Context, name string) error
	// Snapshot and Restore keep and bring back a machine's memory and files;
	// a backend without SnapshotMemory fails both with driver.ErrUnsupported.
	// A snapshot ends its source machine, whatever its purpose: a machine
	// that ran on after its snapshot would share what the restored ones
	// hold (docs/runtime/isolation-p3-snapshots.md).
	Snapshot(ctx context.Context, name string, req SnapshotRequest) (SnapshotRef, error)
	Restore(ctx context.Context, snap SnapshotRef, spec Spec) (Machine, error)
	// Taint records why the machine may never be snapshotted. It is
	// called before the thing it names is handed to the machine; a backend
	// that cannot record it fails, and the caller does not hand it over.
	Taint(ctx context.Context, name string, why Taint) error
	// Destroy ends the machine and everything it ran.
	Destroy(ctx context.Context, name string, opts DestroyOptions) error
	// DialGuest opens a byte stream to the guest agent in the machine
	// (internal/guest); the caller closes it.
	DialGuest(ctx context.Context, name string) (io.ReadWriteCloser, error)
}

// ErrUnavailable is a backend this host cannot run (no /dev/kvm, a missing
// kit, a backend not built yet). The cell refuses to start with it rather
// than run claims under another isolation.
var ErrUnavailable = errors.New("isolation: backend not available on this host")

// UnavailableError says which backend and why; errors.Is finds ErrUnavailable.
type UnavailableError struct {
	Backend string
	Reason  string
}

func (e *UnavailableError) Error() string {
	return fmt.Sprintf("isolation: %s is not available on this host: %s", e.Backend, e.Reason)
}

func (e *UnavailableError) Is(target error) bool { return target == ErrUnavailable }
