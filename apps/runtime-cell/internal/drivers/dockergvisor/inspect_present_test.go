package dockergvisor

import (
	"context"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockergvisor/buildstate"
)

// vanishingDocker is the daemon while a release removes a container between
// the sweep's ps and its inspect: the ps still lists it, and docker inspect
// of a list that names it fails as a whole, as the real one does.
type vanishingDocker struct {
	*memDocker
	gone string
}

func (v vanishingDocker) IDs(ctx context.Context, f dockercli.Filters) ([]string, error) {
	ids, err := v.memDocker.IDs(ctx, f)
	return append(ids, v.gone), err
}

func (v vanishingDocker) Inspect(ctx context.Context, ids ...string) ([]dockercli.Container, error) {
	for _, id := range ids {
		if id == v.gone {
			return nil, &dockercli.ExitError{Command: "docker inspect", Code: 1, Stderr: "Error response from daemon: No such container: " + id}
		}
	}
	return v.memDocker.Inspect(ctx, ids...)
}

// The sweep listed the cell's containers while a release removed one: the
// one docker inspect of all of them failed on it and the whole sweep ended
// in "No such container", three times on the dev cell (2026-11-19). A
// container removed since the ps is simply not there.
func TestTheSweepReadsTheCellWhileAContainerIsRemovedUnderIt(t *testing.T) {
	_, f := newReapFixture(t)
	rp, err := NewForReaper(vanishingDocker{memDocker: f.docker, gone: "c-removed-since-ps"}, ReaperConfig{CellID: "cell-1", WorkDir: f.work, EgressContainer: "kodus-egress"})
	if err != nil {
		t.Fatal(err)
	}
	rp.mounted = func(string) ([]buildstate.OverlayMount, error) { return nil, nil }
	refs, err := rp.List(context.Background(), map[string]string{driver.TagCell: "cell-1"})
	if err != nil {
		t.Fatalf("the sweep failed on a container removed under it: %v", err)
	}
	if len(refs) != 4 {
		t.Fatalf("listed %d machines, want the 4 of claim-1 and claim-2", len(refs))
	}
}

type failingInspect struct{}

func (failingInspect) Inspect(context.Context, ...string) ([]dockercli.Container, error) {
	return nil, &dockercli.ExitError{Command: "docker inspect", Code: 1, Stderr: "Cannot connect to the Docker daemon"}
}

// Only a container that is gone is left out: a daemon that fails is still
// an error.
func TestTheSweepsInspectStillFailsOnADaemonFailure(t *testing.T) {
	if _, err := inspectPresent(context.Background(), failingInspect{}, "a", "b"); err == nil {
		t.Fatal("a daemon failure was taken for a removed container")
	}
}
