package dockergvisor

import (
	"context"
	"testing"
	"time"
)

type deadlineCopyDocker struct {
	*memDocker
	deadlines []time.Time
}

func (d *deadlineCopyDocker) CopyVolumeGeneration(ctx context.Context, runtime, helper, from, to string, labels map[string]string, parent, expected, write string) error {
	return d.memDocker.copyGeneration(from, to, expected, write, func() error { return d.CopyVolumeBound(ctx, runtime, helper, from, to, labels, parent) })
}

func (d *deadlineCopyDocker) CopyVolumeBound(ctx context.Context, runtime, helper, from, to string, labels map[string]string, parent string) error {
	at, ok := ctx.Deadline()
	if !ok {
		d.deadlines = append(d.deadlines, time.Time{})
	} else {
		d.deadlines = append(d.deadlines, at)
	}
	return d.memDocker.CopyVolumeBound(ctx, runtime, helper, from, to, labels, parent)
}
func TestClaimLimitsBakeCopyCannotOutliveSourceHardCeiling(t *testing.T) {
	docker := &deadlineCopyDocker{memDocker: newMemDocker()}
	d, err := New(context.Background(), docker, Config{CellID: "cell-1", HolderImage: "holder", WorkDir: t.TempDir(), ClaimLimits: &fakeClaimLimits{}})
	if err != nil {
		t.Fatal(err)
	}
	_, ref := makeLimitedClaim(t, d, "claim-deadline")
	d.machineOutput(ref.MachineID).volumes = []string{"pgdata"}
	docker.plantVolume(ref.MachineID, "pgdata", "seed")
	if err = d.PinBakeSource(ref); err != nil {
		t.Fatal(err)
	}
	if _, err = d.Bake(context.Background(), bakeSpec(ref)); err != nil {
		t.Fatal(err)
	}
	if len(docker.deadlines) != 1 || !docker.deadlines[0].Equal(spec().HardExpiresAt) {
		t.Fatalf("unbounded copy deadline: %v", docker.deadlines)
	}
}
