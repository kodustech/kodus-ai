// Package gvisor is the gVisor IsolationBackend on the docker placement:
// every machine is a container under runsc in the host's Docker, joined to
// its claim's network, and the cell reaches a sandbox's guest agent over a
// docker exec -i stream. It is the cell's behaviour before the
// Placement/IsolationBackend split, moved here unchanged
// (docs/runtime/isolation-architecture.md C3).
//
// An environment machine is the holder of a compose project of the same
// name, whose services the shared boot path (drivers/dockergvisor/up.go)
// runs under the same runtime: Pause, Start and Destroy act on that project
// and the holder together.
package gvisor

import (
	"context"
	"errors"
	"fmt"
	"io"
	"slices"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation"
)

// Engine is the part of the host's Docker the backend runs machines with;
// dockercli.CLI implements it.
type Engine interface {
	Runtimes(ctx context.Context) ([]string, error)
	RunHolder(ctx context.Context, h dockercli.HolderSpec) (dockercli.Container, error)
	Remove(ctx context.Context, name string) error
	ComposeStop(ctx context.Context, project string) error
	ComposeStart(ctx context.Context, project string) error
	ComposeDown(ctx context.Context, project string, volumes bool) error
}

// SandboxEngine is what a code sandbox needs beyond Engine: its own
// container and a byte stream to the guest agent inside it. An engine
// without it (the drivers' test fakes) runs no sandboxes.
type SandboxEngine interface {
	RunSandbox(ctx context.Context, s dockercli.SandboxSpec) (dockercli.Container, error)
	ExecStream(ctx context.Context, container, user string, argv ...string) (io.ReadWriteCloser, error)
}

var _ SandboxEngine = dockercli.CLI{}

// DefaultRuntime is the OCI runtime gVisor registers in Docker.
const DefaultRuntime = "runsc"

// GuestUser is the tool image's user, the guest agent's and every sandbox
// command's.
const GuestUser = "1000:1000"

// GuestCommand starts the guest agent on the stream, rooted at /workspace.
var GuestCommand = []string{"/usr/local/bin/kody-guest", "-stdio", "-root", "/workspace"}

// ErrNoRuntime means the host's Docker has no runsc: the cell does not start
// without gVisor (S-10).
var ErrNoRuntime = errors.New("gvisor: the runsc runtime is not installed in this Docker")

// ErrNoSandboxes means the engine cannot run a sandbox or stream to its guest agent.
var ErrNoSandboxes = errors.New("gvisor: this engine runs no sandboxes")

// Backend runs machines under runsc.
type Backend struct {
	engine  Engine
	runtime string
	// ioDevice is the disk Docker's data root is on, which a machine's
	// disk rates bound ("" : no disk bound).
	ioDevice string
}

// NetShaper bounds a container's network on its host-side veths.
type NetShaper interface {
	ShapeNetwork(ctx context.Context, container string, bps int64) error
}

var _ NetShaper = dockercli.CLI{}

// BoundIOOn makes a machine's disk rates bound its writes to dev (the disk
// Docker's data root is on).
func (b *Backend) BoundIOOn(dev string) { b.ioDevice = dev }

// ioOf is the container's bound of s's rates.
func (b *Backend) ioOf(s isolation.Spec) *dockercli.IOBound {
	r := s.Rates
	if r == (driver.IORates{}) {
		return nil
	}
	io := &dockercli.IOBound{NetBps: r.NetBps}
	if b.ioDevice != "" {
		io.Device, io.ReadBps, io.WriteBps, io.ReadIOPS, io.WriteIOPS = b.ioDevice, r.DiskBps, r.DiskBps, r.DiskOps, r.DiskOps
	}
	return io
}

// shape bounds the started container's network to s's rate; a container
// that cannot be bounded is removed, never left running unbounded.
func (b *Backend) shape(ctx context.Context, s isolation.Spec, c dockercli.Container) error {
	if s.Rates.NetBps <= 0 {
		return nil
	}
	n, ok := b.engine.(NetShaper)
	if !ok {
		return errors.Join(driver.ErrResourceEnforcement, errors.New("gvisor: this engine shapes no network"), b.engine.Remove(context.WithoutCancel(ctx), s.Name))
	}
	if err := n.ShapeNetwork(ctx, c.ID, s.Rates.NetBps); err != nil {
		return errors.Join(driver.ErrResourceEnforcement, err, b.engine.Remove(context.WithoutCancel(ctx), s.Name))
	}
	return nil
}

var _ isolation.Backend = (*Backend)(nil)

// New is the backend on engine, refusing a Docker where runtime ("runsc"
// when empty) is not registered.
func New(ctx context.Context, engine Engine, runtime string) (*Backend, error) {
	if runtime == "" {
		runtime = DefaultRuntime
	}
	rts, err := engine.Runtimes(ctx)
	if err != nil {
		return nil, err
	}
	if !slices.Contains(rts, runtime) {
		return nil, ErrNoRuntime
	}
	return &Backend{engine: engine, runtime: runtime}, nil
}

// Sandboxes reports whether the engine runs code sandboxes.
func (b *Backend) Sandboxes() bool {
	_, ok := b.engine.(SandboxEngine)
	return ok
}

func (b *Backend) Capabilities() isolation.Capabilities {
	c := isolation.Capabilities{
		Backend: isolation.GVisor, Isolation: driver.IsolationSandboxedContainer, OCIRuntime: b.runtime,
		Suspend: "stop", NestedDocker: true, Arch: []string{"x86_64", "arm64"},
	}
	if b.Sandboxes() {
		c.Guest = "stdio"
	}
	return c
}

func (b *Backend) holderSpec(s isolation.Spec) dockercli.HolderSpec {
	h := holderSpec(s, b.runtime)
	h.IO = b.ioOf(s)
	return h
}

func holderSpec(s isolation.Spec, runtime string) dockercli.HolderSpec {
	return dockercli.HolderSpec{
		Name: s.Name, Image: s.Image, Network: s.Network, Runtime: runtime,
		PidsLimit: s.PidsLimit, Labels: s.Labels, Resolv: s.Resolv, CgroupParent: s.CgroupParent, DiskSize: s.DiskSize,
		Mounts: s.Mounts, Cmd: s.Cmd, AlsoOn: s.AlsoOn,
	}
}

func machineOf(name string, c dockercli.Container) isolation.Machine {
	return isolation.Machine{Name: name, ID: c.ID, PID: c.PID, Addresses: c.Networks}
}

// Create runs the machine's container under runsc: an environment
// machine's holder, or a sandbox's tool container with its user, limits and
// in-memory /workspace and /tmp.
func (b *Backend) Create(ctx context.Context, s isolation.Spec) (isolation.Machine, error) {
	switch s.Shape {
	case isolation.ShapeEnvironment:
		c, err := b.engine.RunHolder(ctx, b.holderSpec(s))
		if err != nil {
			return isolation.Machine{}, err
		}
		if err := b.shape(ctx, s, c); err != nil {
			return isolation.Machine{}, err
		}
		return machineOf(s.Name, c), nil
	case isolation.ShapeSandbox:
		run, ok := b.engine.(SandboxEngine)
		if !ok {
			return isolation.Machine{}, ErrNoSandboxes
		}
		c, err := run.RunSandbox(ctx, dockercli.SandboxSpec{
			HolderSpec: b.holderSpec(s),
			User:       s.User, Memory: s.Memory, CPUs: s.CPUs,
			WorkspaceSize: s.WorkspaceSize, TmpSize: s.TmpSize, Tmpfs: tmpfsOf(s.Tmpfs),
		})
		if err != nil {
			return isolation.Machine{}, err
		}
		if err := b.shape(ctx, s, c); err != nil {
			return isolation.Machine{}, err
		}
		return machineOf(s.Name, c), nil
	}
	return isolation.Machine{}, fmt.Errorf("gvisor: unknown machine shape %q", s.Shape)
}

// Discard removes the machine's own container.
func (b *Backend) Discard(ctx context.Context, name string) error {
	return b.engine.Remove(ctx, name)
}

// Start starts the machine's project again.
func (b *Backend) Start(ctx context.Context, name string) error {
	return b.engine.ComposeStart(ctx, name)
}

// Pause stops the machine's project; its files and volumes stay.
func (b *Backend) Pause(ctx context.Context, name string) error {
	return b.engine.ComposeStop(ctx, name)
}

// Snapshot is P3 (runsc checkpoint): unsupported until then.
func (b *Backend) Snapshot(context.Context, string, isolation.SnapshotRequest) (isolation.SnapshotRef, error) {
	return isolation.SnapshotRef{}, fmt.Errorf("%w: gvisor keeps no memory snapshot yet", driver.ErrUnsupported)
}

// Taint keeps nothing: this backend takes no memory snapshot, so there is
// no snapshot a taint must stop. A gvisor snapshot (runsc checkpoint) must
// record taints before it is built.
func (b *Backend) Taint(context.Context, string, isolation.Taint) error { return nil }

// Restore is P3 (runsc restore): unsupported until then.
func (b *Backend) Restore(context.Context, isolation.SnapshotRef, isolation.Spec) (isolation.Machine, error) {
	return isolation.Machine{}, fmt.Errorf("%w: gvisor restores no memory snapshot yet", driver.ErrUnsupported)
}

// Destroy takes the machine's project down (its volumes too, unless a bake
// keeps them) and removes its container.
func (b *Backend) Destroy(ctx context.Context, name string, opts isolation.DestroyOptions) error {
	return destroy(ctx, b.engine, name, opts)
}

// EndingEngine is the part of the host's Docker that ends machines.
type EndingEngine interface {
	Remove(ctx context.Context, name string) error
	ComposeDown(ctx context.Context, project string, volumes bool) error
}

// Ender ends gVisor machines and does nothing else: the independent reaper's
// view of the backend (cmd/reaper). Unlike New it does not ask the host's
// Docker for runsc: a machine past its ceiling goes whatever runtimes the
// host registers now.
type Ender struct{ engine EndingEngine }

// NewEnder is the ending-only backend on engine.
func NewEnder(engine EndingEngine) Ender { return Ender{engine: engine} }

// Destroy is Backend.Destroy.
func (e Ender) Destroy(ctx context.Context, name string, opts isolation.DestroyOptions) error {
	return destroy(ctx, e.engine, name, opts)
}

func destroy(ctx context.Context, engine EndingEngine, name string, opts isolation.DestroyOptions) error {
	err := engine.ComposeDown(ctx, name, !opts.KeepData)
	if rerr := engine.Remove(ctx, name); rerr != nil {
		err = errors.Join(err, rerr)
	}
	return err
}

func tmpfsOf(in []isolation.Tmpfs) []dockercli.Tmpfs {
	var out []dockercli.Tmpfs
	for _, t := range in {
		out = append(out, dockercli.Tmpfs{Dir: t.Dir, Size: t.Size})
	}
	return out
}

// ExecStream runs argv in the machine as its user with stdin and stdout as a
// byte stream (docker exec -i): how the cell reads a builder's layer out,
// with no shell on the host. The caller closes it.
func (b *Backend) ExecStream(ctx context.Context, name string, argv ...string) (io.ReadWriteCloser, error) {
	run, ok := b.engine.(SandboxEngine)
	if !ok {
		return nil, ErrNoSandboxes
	}
	return run.ExecStream(ctx, name, GuestUser, argv...)
}

// DialGuest starts the guest agent in the machine on a docker exec -i stream.
func (b *Backend) DialGuest(ctx context.Context, name string) (io.ReadWriteCloser, error) {
	run, ok := b.engine.(SandboxEngine)
	if !ok {
		return nil, ErrNoSandboxes
	}
	return run.ExecStream(ctx, name, GuestUser, GuestCommand...)
}
