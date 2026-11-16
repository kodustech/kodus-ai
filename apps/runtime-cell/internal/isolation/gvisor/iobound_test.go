package gvisor

import (
	"context"
	"errors"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation"
)

// shapingEngine records the bounds a container got and its network shaping.
type shapingEngine struct {
	sandboxEngine
	io     map[string]*dockercli.IOBound
	shaped map[string]int64
	fail   error
}

func (e shapingEngine) RunSandbox(ctx context.Context, s dockercli.SandboxSpec) (dockercli.Container, error) {
	e.io[s.Name] = s.IO
	return e.sandboxEngine.RunSandbox(ctx, s)
}

func (e shapingEngine) ShapeNetwork(_ context.Context, container string, bps int64) error {
	if e.fail != nil {
		return e.fail
	}
	e.shaped[container] = bps
	return nil
}

// A gVisor sandbox gets the shared policy's rates: Docker's blkio limits on
// the data root's disk and a token bucket each way on its host-side veth. A
// sandbox whose network cannot be bounded is removed and refused, never
// left running unbounded; one with no rates gets neither.
func TestAGVisorSandboxIsBoundedByTheSharedPolicy(t *testing.T) {
	e := shapingEngine{sandboxEngine: sandboxEngine{engine: newEngine("runsc"), streamed: map[string][]string{}}, io: map[string]*dockercli.IOBound{}, shaped: map[string]int64{}}
	b, err := New(context.Background(), e, "")
	if err != nil {
		t.Fatal(err)
	}
	b.BoundIOOn("/dev/nvme0n1")
	r := driver.IOLimits{DiskMBps: 50, NetMbps: 80}.For(2)
	spec := isolation.Spec{Shape: isolation.ShapeSandbox, Name: "kodus-s-workload", Image: "tool", Network: "kodus-s", User: GuestUser, Memory: "1g", CPUs: "2", Rates: r}
	if _, err := b.Create(context.Background(), spec); err != nil {
		t.Fatal(err)
	}
	io := e.io["kodus-s-workload"]
	if io == nil || io.Device != "/dev/nvme0n1" || io.WriteBps != 100_000_000 || io.ReadBps != 100_000_000 || io.WriteIOPS != 5000 {
		t.Fatalf("disk bound %+v", io)
	}
	if e.shaped["id-kodus-s-workload"] != 20_000_000 {
		t.Fatalf("network shaped %v", e.shaped)
	}
	e.fail = errors.New("tc: no such device")
	refused := shapingEngine{sandboxEngine: e.sandboxEngine, io: e.io, shaped: e.shaped, fail: e.fail}
	b2, _ := New(context.Background(), refused, "")
	spec.Name = "kodus-t-workload"
	if _, err := b2.Create(context.Background(), spec); !errors.Is(err, driver.ErrResourceEnforcement) {
		t.Fatalf("an unshaped sandbox: %v", err)
	}
	if _, ok := e.containers["kodus-t-workload"]; ok {
		t.Fatal("an unshaped sandbox is left running")
	}
	spec.Name, spec.Rates = "kodus-u-workload", driver.IORates{}
	if _, err := b.Create(context.Background(), spec); err != nil || e.io["kodus-u-workload"] != nil {
		t.Fatalf("no rates: %+v %v", e.io["kodus-u-workload"], err)
	}
}
