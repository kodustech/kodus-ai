package driver

import (
	"context"
	"io"
)

// Sandboxer is a driver that boots code sandboxes (docs/runtime/sandbox.md):
// one tool machine on a claim's network, under the driver's isolation, with
// the guest agent (internal/guest) inside it and an empty /workspace. No
// compose, no observer, no Run. The machine is a workload machine like any
// other: it carries the claim's tags and ceiling, joins the claim's lease,
// and Destroy, the sweep and the reaper end it.
type Sandboxer interface {
	// CreateSandbox makes the machine for req.Spec (role workload, or pool
	// for a blank sandbox no claim holds yet; the driver's tool image
	// whatever Spec.ImageID says).
	CreateSandbox(ctx context.Context, req SandboxRequest) (MachineRef, error)
	// DialGuest opens a byte stream to the guest agent inside the machine:
	// docker exec's stdio on docker-gvisor today, vsock on a microVM. The
	// caller closes it; it ends by itself when the machine goes.
	DialGuest(ctx context.Context, ref MachineRef) (io.ReadWriteCloser, error)
}
