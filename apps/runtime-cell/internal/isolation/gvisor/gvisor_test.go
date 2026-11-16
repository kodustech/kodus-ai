package gvisor

import (
	"context"
	"errors"
	"io"
	"net"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation"
)

// engine is a Docker that keeps state: containers by name with the runtime
// they run under, and each project's volumes.
type engine struct {
	runtimes   []string
	containers map[string]string // name -> runtime
	volumes    map[string]int    // project -> volumes
	stopped    map[string]bool
}

func newEngine(runtimes ...string) *engine {
	return &engine{runtimes: runtimes, containers: map[string]string{}, volumes: map[string]int{}, stopped: map[string]bool{}}
}

func (e *engine) Runtimes(context.Context) ([]string, error) { return e.runtimes, nil }
func (e *engine) RunHolder(_ context.Context, h dockercli.HolderSpec) (dockercli.Container, error) {
	e.containers[h.Name] = h.Runtime
	return dockercli.Container{ID: "id-" + h.Name, Name: h.Name, PID: 42, Networks: map[string]string{h.Network: "10.213.0.130"}}, nil
}

func (e *engine) Remove(_ context.Context, name string) error { delete(e.containers, name); return nil }

func (e *engine) ComposeStop(_ context.Context, p string) error {
	e.stopped[p] = true
	return nil
}

func (e *engine) ComposeStart(_ context.Context, p string) error {
	e.stopped[p] = false
	return nil
}

func (e *engine) ComposeDown(_ context.Context, p string, volumes bool) error {
	if volumes {
		delete(e.volumes, p)
	}
	return nil
}

// sandboxEngine also runs sandboxes and streams to their guest agent.
type sandboxEngine struct {
	*engine
	streamed map[string][]string // container -> user + argv
}

func (e sandboxEngine) RunSandbox(ctx context.Context, s dockercli.SandboxSpec) (dockercli.Container, error) {
	return e.RunHolder(ctx, s.HolderSpec)
}

func (e sandboxEngine) ExecStream(_ context.Context, container, user string, argv ...string) (io.ReadWriteCloser, error) {
	e.streamed[container] = append([]string{user}, argv...)
	a, _ := net.Pipe()
	return a, nil
}

func TestTheCellDoesNotStartOnADockerWithoutRunsc(t *testing.T) {
	if _, err := New(context.Background(), newEngine("runc"), ""); !errors.Is(err, ErrNoRuntime) {
		t.Fatalf("err %v, want ErrNoRuntime", err)
	}
	b, err := New(context.Background(), newEngine("runc", "runsc"), "")
	if err != nil {
		t.Fatal(err)
	}
	if c := b.Capabilities(); c.OCIRuntime != "runsc" || c.Isolation != driver.IsolationSandboxedContainer || c.SnapshotMemory {
		t.Fatalf("capabilities %+v", c)
	}
}

func TestEveryMachineRunsUnderRunscAndItsAddressIsOnItsClaimNetwork(t *testing.T) {
	e := newEngine("runsc")
	b, _ := New(context.Background(), sandboxEngine{engine: e, streamed: map[string][]string{}}, "")
	for _, shape := range []isolation.Shape{isolation.ShapeEnvironment, isolation.ShapeSandbox} {
		name := "kodus-c1-" + string(shape)
		m, err := b.Create(context.Background(), isolation.Spec{Shape: shape, Name: name, Image: "img", Network: "kodus-c1"})
		if err != nil {
			t.Fatal(err)
		}
		if e.containers[name] != "runsc" || m.IP("kodus-c1") != "10.213.0.130" || m.PID != 42 {
			t.Fatalf("%s: runtime %q, machine %+v", shape, e.containers[name], m)
		}
	}
}

func TestAnEngineThatCannotStreamRunsNoSandboxes(t *testing.T) {
	b, _ := New(context.Background(), newEngine("runsc"), "")
	if b.Sandboxes() || b.Capabilities().Guest != "" {
		t.Fatal("a plain engine says it runs sandboxes")
	}
	if _, err := b.Create(context.Background(), isolation.Spec{Shape: isolation.ShapeSandbox, Name: "s"}); !errors.Is(err, ErrNoSandboxes) {
		t.Fatalf("sandbox create: %v", err)
	}
	if _, err := b.DialGuest(context.Background(), "s"); !errors.Is(err, ErrNoSandboxes) {
		t.Fatalf("dial: %v", err)
	}
}

func TestTheGuestAgentRunsAsTheToolUserRootedAtTheWorkspace(t *testing.T) {
	s := sandboxEngine{engine: newEngine("runsc"), streamed: map[string][]string{}}
	b, _ := New(context.Background(), s, "")
	rw, err := b.DialGuest(context.Background(), "kodus-c1-workload")
	if err != nil {
		t.Fatal(err)
	}
	_ = rw.Close()
	got := s.streamed["kodus-c1-workload"]
	if len(got) < 5 || got[0] != "1000:1000" || got[1] != "/usr/local/bin/kody-guest" || got[3] != "-root" || got[4] != "/workspace" {
		t.Fatalf("streamed %v", got)
	}
}

func TestDestroyEndsTheMachineAndItsVolumesUnlessABakeKeepsThem(t *testing.T) {
	e := newEngine("runsc")
	b, _ := New(context.Background(), e, "")
	for _, keep := range []bool{false, true} {
		name := "kodus-c1-workload"
		_, _ = b.Create(context.Background(), isolation.Spec{Shape: isolation.ShapeEnvironment, Name: name, Network: "n"})
		e.volumes[name] = 2
		if err := b.Destroy(context.Background(), name, isolation.DestroyOptions{KeepData: keep}); err != nil {
			t.Fatal(err)
		}
		if _, ok := e.containers[name]; ok {
			t.Fatal("the machine's container survived Destroy")
		}
		if _, kept := e.volumes[name]; kept != keep {
			t.Fatalf("keep %v: volumes kept %v", keep, kept)
		}
	}
}

// The reaper's ending-only backend takes a machine and its volumes down on a
// Docker that no longer lists runsc, where New would refuse to start.
func TestTheReapersEnderEndsAMachineWhateverRuntimesTheHostListsNow(t *testing.T) {
	e := newEngine()
	name := "kodus-c1-workload"
	e.containers[name], e.volumes[name] = "runsc", 2
	if err := NewEnder(e).Destroy(context.Background(), name, isolation.DestroyOptions{}); err != nil {
		t.Fatal(err)
	}
	if _, ok := e.containers[name]; ok {
		t.Fatal("the machine's container survived")
	}
	if _, ok := e.volumes[name]; ok {
		t.Fatal("the machine's volumes survived")
	}
}

func TestPauseStopsTheMachinesProcessesAndStartRunsThemAgain(t *testing.T) {
	e := newEngine("runsc")
	b, _ := New(context.Background(), e, "")
	_ = b.Pause(context.Background(), "m")
	if !e.stopped["m"] {
		t.Fatal("paused machine still runs")
	}
	_ = b.Start(context.Background(), "m")
	if e.stopped["m"] {
		t.Fatal("started machine still stopped")
	}
}

func TestGVisorKeepsNoMemorySnapshotUntilP3(t *testing.T) {
	b, _ := New(context.Background(), newEngine("runsc"), "")
	if _, err := b.Snapshot(context.Background(), "m", isolation.SnapshotRequest{Purpose: isolation.PurposeTemplate}); !errors.Is(err, driver.ErrUnsupported) {
		t.Fatalf("snapshot: %v", err)
	}
	if _, err := b.Restore(context.Background(), isolation.SnapshotRef{}, isolation.Spec{}); !errors.Is(err, driver.ErrUnsupported) {
		t.Fatalf("restore: %v", err)
	}
}
