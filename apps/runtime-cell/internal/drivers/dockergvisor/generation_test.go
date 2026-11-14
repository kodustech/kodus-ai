package dockergvisor

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/bakecatalog"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose/sandbox"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockercli"
	"golang.org/x/sys/unix"
)

func TestRestartCleansOnlyOwnedPendingCatalogFiles(t *testing.T) {
	d, docker := bakeDriver(t)
	ctx := context.Background()
	if _, err := d.catalogFor(ctx); err != nil {
		t.Fatal(err)
	}
	if err := d.Close(); err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(d.workDir(), "bake-catalog")
	for i := 0; i < 260; i++ {
		name := fmt.Sprintf("pending-%024x", i)
		if err := os.WriteFile(filepath.Join(root, name), []byte("interrupted write"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "unrelated"), []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	restarted, err := New(ctx, docker, d.cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.Close()
	if _, err := restarted.RecoverBakes(ctx); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), "pending-") {
			t.Fatal("pending manifest left behind")
		}
	}
	if raw, err := os.ReadFile(filepath.Join(root, "unrelated")); err != nil || string(raw) != "keep" {
		t.Fatal("unrelated file changed")
	}
}

func generationForTest(t *testing.T, d *Driver, id string) bakecatalog.Generation {
	t.Helper()
	c, err := d.catalogFor(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	g, ok, _ := c.Lookup(id)
	if !ok {
		t.Fatal("generation absent")
	}
	return g
}

func installGenerationForTest(t *testing.T, d *Driver, docker *memDocker) string {
	t.Helper()
	g := bakecatalog.Generation{Cell: "cell-1", Org: bakeOrg, Environment: bakeEnv, SHA: strings.Repeat("a", 40), RecipeSHA: "r", Nonce: strings.Repeat("1", 24), Images: map[string]string{}, Volumes: map[string]string{}}
	g.ID = generationID(g.Cell, g.Org, g.Environment, g.SHA, g.Nonce)
	labels := envLabels(g.Cell, g.Org, g.Environment)
	labels[labelBakeSHA], labels[labelBakeVolume], labels[labelBakeGeneration] = g.SHA, "pgdata", g.Nonce
	name := generationVolume(g, "pgdata")
	g.Volumes["pgdata"] = name
	docker.volumes[name] = memVolume{labels: labels, data: "seed", marker: g.Nonce}
	if err := d.publishGeneration(context.Background(), g); err != nil {
		t.Fatal(err)
	}
	return g.ID
}

// Repeating a setup at the same source SHA used to overwrite the seed
// behind an existing concrete image ID.
func TestSameSHABakesHaveDifferentImmutableIdentities(t *testing.T) {
	d, docker := bakeDriver(t)
	first := bakeWithData(t, d, docker, "claim-first", "first seed")
	a, err := d.Bake(context.Background(), bakeSpec(first))
	if err != nil {
		t.Fatal(err)
	}
	second := bakeWithData(t, d, docker, "claim-second", "second seed")
	b, err := d.Bake(context.Background(), bakeSpec(second))
	if err != nil {
		t.Fatal(err)
	}
	if a.ImageID == b.ImageID {
		t.Fatal("same-SHA bake replaced an existing generation")
	}
}

func TestGenerationCatalogRecoversOnlyVerifiedBakes(t *testing.T) {
	for _, fault := range []string{"none", "missing volume", "surviving holder", "corrupt catalog"} {
		t.Run(fault, func(t *testing.T) {
			d, docker := bakeDriver(t)
			setup := bakeWithData(t, d, docker, "claim-setup", "seed")
			image, err := d.Bake(context.Background(), bakeSpec(setup))
			if err != nil {
				t.Fatal(err)
			}
			g := generationForTest(t, d, image.ImageID)
			if err := d.Destroy(context.Background(), setup); err != nil {
				t.Fatal(err)
			}
			if err := d.Close(); err != nil {
				t.Fatal(err)
			}
			switch fault {
			case "missing volume":
				delete(docker.volumes, g.Volumes["pgdata"])
			case "surviving holder":
				docker.plant(dockercli.Container{Name: "old-holder", Labels: map[string]string{"kodus.cell": "cell-1", labelMachine: "old-holder"}})
			case "corrupt catalog":
				if err := os.WriteFile(filepath.Join(d.workDir(), "bake-catalog", bakecatalog.FileName), []byte(`{"version":1,"version":2}`), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			restarted, err := New(context.Background(), docker, d.cfg)
			if err != nil {
				t.Fatal(err)
			}
			defer restarted.Close()
			recovered, err := restarted.RecoverBakes(context.Background())
			if fault != "none" {
				if err == nil || len(recovered) != 0 {
					t.Fatalf("unsafe recovery: %v %v", recovered, err)
				}
				return
			}
			if err != nil || len(recovered) != 1 || recovered[0].ImageID != image.ImageID || !recovered[0].Current {
				t.Fatalf("recovered %v %v", recovered, err)
			}
			ref := machine("claim-after-restart", bakeEnv)
			ref.ImageID = image.ImageID
			if n, err := restarted.restoreData(context.Background(), ref, []string{"pgdata"}); err != nil || n != 1 {
				t.Fatalf("restored %d %v", n, err)
			}
		})
	}
}

func TestGenerationCatalogHasOnlyOneController(t *testing.T) {
	d, docker := bakeDriver(t)
	if _, err := d.catalogFor(context.Background()); err != nil {
		t.Fatal(err)
	}
	second, err := New(context.Background(), docker, d.cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	if _, err := second.RecoverBakes(context.Background()); err == nil {
		t.Fatal("two controllers opened the same catalog")
	}
	if err := d.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := second.RecoverBakes(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestLiveMachineRetainsItsGenerationAcrossSameSHABake(t *testing.T) {
	d, docker := bakeDriver(t)
	ctx := context.Background()
	setup := bakeWithData(t, d, docker, "claim-setup", "old seed")
	first, err := d.Bake(ctx, bakeSpec(setup))
	if err != nil {
		t.Fatal(err)
	}
	s := spec()
	s.EnvironmentID = bakeEnv
	s.ClaimID = "claim-held"
	s.ImageID = first.ImageID
	n, err := d.PrepareClaim(ctx, driver.ClaimNetworkSpec{CellID: s.CellID, OrgID: s.OrgID, ClaimID: s.ClaimID})
	if err != nil {
		t.Fatal(err)
	}
	s.ClaimGroupID = n.WorkloadGroupID
	ref, err := d.Create(ctx, s)
	if err != nil {
		t.Fatal(err)
	}
	next := bakeWithData(t, d, docker, "claim-setup-next", "new seed")
	second, err := d.Bake(ctx, bakeSpec(next))
	if err != nil {
		t.Fatal(err)
	}
	if second.ImageID == first.ImageID {
		t.Fatal("rebake reused identity")
	}
	if err := d.AcknowledgeBake(ctx, second.ImageID); err != nil {
		t.Fatal(err)
	}
	if n, err := d.restoreData(ctx, ref, []string{"pgdata"}); err != nil || n != 1 {
		t.Fatalf("old retained seed unavailable: %d %v", n, err)
	}
	v, _ := docker.volume(projectVolume(ref.MachineID, "pgdata"))
	if v.data != "old seed" {
		t.Fatal("new seed substituted")
	}
	if err := d.Destroy(ctx, ref); err != nil {
		t.Fatal(err)
	}
	if err := d.ReleaseClaim(ctx, n); err != nil {
		t.Fatal(err)
	}
	if err := d.pruneGenerations(ctx); err != nil {
		t.Fatal(err)
	}
	if _, _, err := d.holdGeneration(ctx, ref); !errors.Is(err, ErrBakeDataUnavailable) {
		t.Fatal("released non-current generation stayed eligible")
	}
}

type pausedGenerationCopy struct {
	*memDocker
	started, finish chan struct{}
}

func (m *pausedGenerationCopy) CopyVolumeGeneration(ctx context.Context, runtime, helper, from, to string, labels map[string]string, parent, expected, write string) error {
	if expected != "" {
		close(m.started)
		select {
		case <-m.finish:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return m.memDocker.CopyVolumeGeneration(ctx, runtime, helper, from, to, labels, parent, expected, write)
}

func TestInFlightCopyRetainsItsSourceWhileANewBakePublishes(t *testing.T) {
	d, docker := bakeDriver(t)
	ctx := context.Background()
	setup := bakeWithData(t, d, docker, "claim-setup", "old seed")
	first, err := d.Bake(ctx, bakeSpec(setup))
	if err != nil {
		t.Fatal(err)
	}
	ref := machine("claim-copy", bakeEnv)
	ref.ImageID = first.ImageID
	paused := &pausedGenerationCopy{memDocker: docker, started: make(chan struct{}), finish: make(chan struct{})}
	d.d = paused
	done := make(chan error, 1)
	go func() { _, err := d.restoreData(ctx, ref, []string{"pgdata"}); done <- err }()
	<-paused.started
	next := bakeWithData(t, d, docker, "claim-next", "new seed")
	if _, err := d.Bake(ctx, bakeSpec(next)); err != nil {
		close(paused.finish)
		t.Fatal(err)
	}
	close(paused.finish)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	v, _ := docker.volume(projectVolume(ref.MachineID, "pgdata"))
	if v.data != "old seed" {
		t.Fatal("copy used a different generation")
	}
}

func TestMissingManifestImageNeverRebuildsUnderTheSameGeneration(t *testing.T) {
	d, docker := bakeDriver(t)
	ctx := context.Background()
	setup := machine("claim-setup", bakeEnv)
	b := sandbox.Build{Service: "api", Context: project(t), Dockerfile: "Dockerfile"}
	boot(t, d, setup, b)
	if err := d.PinBakeSource(setup); err != nil {
		t.Fatal(err)
	}
	image, err := d.Bake(ctx, bakeSpec(setup))
	if err != nil {
		t.Fatal(err)
	}
	g := generationForTest(t, d, image.ImageID)
	for _, name := range g.Images {
		delete(docker.images, name)
	}
	ref := machine("claim-base", bakeEnv)
	ref.ImageID = image.ImageID
	before := len(docker.builds)
	_, _, err = d.build(ctx, ref, []sandbox.Build{b}, "net", "resolv", bakeSubnet)
	if !errors.Is(err, ErrBakeDataUnavailable) || len(docker.builds) != before {
		t.Fatalf("missing member rebuilt: builds=%d err=%v", len(docker.builds)-before, err)
	}
}

type failedGenerationPrune struct {
	*memDocker
	fail bool
}

func (d *failedGenerationPrune) VolumeRemove(ctx context.Context, names ...string) error {
	if d.fail {
		for _, name := range names {
			if strings.HasPrefix(name, "kodus-bake-") {
				return errors.New("backend unavailable")
			}
		}
	}
	return d.memDocker.VolumeRemove(ctx, names...)
}

func TestRetiredArtifactsRemainDurablyRetryable(t *testing.T) {
	d, docker := bakeDriver(t)
	ctx := context.Background()
	first := bakeWithData(t, d, docker, "claim-first", "old")
	old, err := d.Bake(ctx, bakeSpec(first))
	if err != nil {
		t.Fatal(err)
	}
	failing := &failedGenerationPrune{memDocker: docker, fail: true}
	d.d = failing
	second := bakeWithData(t, d, docker, "claim-second", "new")
	nextImage, err := d.Bake(ctx, bakeSpec(second))
	if err != nil {
		t.Fatal(err)
	}
	if err := d.AcknowledgeBake(ctx, nextImage.ImageID); err == nil {
		t.Fatal("fixture prune should fail")
	}
	c, err := d.catalogFor(ctx)
	if err != nil {
		t.Fatal(err)
	}
	_, eligible, retired := c.Lookup(old.ImageID)
	if !retired {
		t.Fatal("failed deletion lost its journal")
	}
	if eligible {
		t.Fatal("retired generation remained eligible")
	}
	failing.fail = false
	if err := d.pruneGenerations(ctx); err != nil {
		t.Fatal(err)
	}
	if _, retired, _ := c.Counts(); retired != 0 {
		t.Fatal("successful cleanup retained stale journal")
	}
}

func TestUnpublishedCrashArtifactsAreCleanupOnlyAfterRestart(t *testing.T) {
	d, docker := bakeDriver(t)
	ctx := context.Background()
	id := installGenerationForTest(t, d, docker)
	old := generationForTest(t, d, id)
	pending := old
	pending.Nonce = strings.Repeat("2", 24)
	pending.ID = generationID(pending.Cell, pending.Org, pending.Environment, pending.SHA, pending.Nonce)
	pending.Volumes = map[string]string{"pgdata": generationVolume(pending, "pgdata")}
	release, err := d.stageGeneration(ctx, pending)
	if err != nil {
		t.Fatal(err)
	}
	// The process died after journal publication, before creating artifacts.
	release()
	if err := d.Close(); err != nil {
		t.Fatal(err)
	}
	restarted, err := New(ctx, docker, d.cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.Close()
	recovered, err := restarted.RecoverBakes(ctx)
	if err != nil || len(recovered) != 1 || recovered[0].ImageID != old.ID {
		t.Fatalf("partial generation recovered: %v %v", recovered, err)
	}
	if _, retired, _ := restarted.catalog.Counts(); retired != 0 {
		t.Fatal("crash journal not drained")
	}
}

func TestCatalogRefusesFIFOAndSymlinkWithoutOpeningThem(t *testing.T) {
	for _, kind := range []string{"fifo", "symlink"} {
		t.Run(kind, func(t *testing.T) {
			d, docker := bakeDriver(t)
			ctx := context.Background()
			if _, err := d.catalogFor(ctx); err != nil {
				t.Fatal(err)
			}
			if err := d.Close(); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(d.workDir(), "bake-catalog", bakecatalog.FileName)
			if kind == "fifo" {
				if err := unix.Mkfifo(path, 0o600); err != nil {
					t.Fatal(err)
				}
			} else {
				if err := os.Symlink("lock", path); err != nil {
					t.Fatal(err)
				}
			}
			restarted, err := New(ctx, docker, d.cfg)
			if err != nil {
				t.Fatal(err)
			}
			defer restarted.Close()
			if _, err := restarted.RecoverBakes(ctx); err == nil {
				t.Fatal("unsafe catalog accepted")
			}
		})
	}
}

func TestPostRenameSyncFailurePreservesPotentiallyCommittedGeneration(t *testing.T) {
	d, docker := bakeDriver(t)
	ctx := context.Background()
	id := installGenerationForTest(t, d, docker)
	g := generationForTest(t, d, id)
	c, _ := d.catalogFor(ctx)
	d.syncCatalogDir = func(*os.File) error { return errors.New("fsync failed after rename") }
	if err := d.publishGeneration(ctx, g); !errors.Is(err, bakecatalog.ErrCommitUncertain) {
		t.Fatalf("lost commit uncertainty: %v", err)
	}
	if c.Current(g.Org, g.Environment) != id {
		t.Fatal("potential commit rolled back in memory")
	}
	if _, ok := docker.volume(g.Volumes["pgdata"]); !ok {
		t.Fatal("potentially committed artifact removed")
	}
	if err := d.Close(); err != nil {
		t.Fatal(err)
	}
	restarted, err := New(ctx, docker, d.cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.Close()
	recovered, err := restarted.RecoverBakes(ctx)
	if err != nil || len(recovered) != 1 || recovered[0].ImageID != id {
		t.Fatalf("cannot recover committed generation: %v %v", recovered, err)
	}
}

func TestFullBakeUncertaintyKeepsTheAgentsPreviousLatestUsable(t *testing.T) {
	d, docker := bakeDriver(t)
	ctx := context.Background()
	first := bakeWithData(t, d, docker, "claim-first", "old seed")
	old, err := d.Bake(ctx, bakeSpec(first))
	if err != nil {
		t.Fatal(err)
	}
	if err := d.AcknowledgeBake(ctx, old.ImageID); err != nil {
		t.Fatal(err)
	}
	syncs := 0
	d.syncCatalogDir = func(f *os.File) error {
		syncs++
		if syncs == 2 {
			return errors.New("one-shot postrename fsync failure")
		}
		return f.Sync()
	}
	next := bakeWithData(t, d, docker, "claim-next", "new seed")
	if _, err := d.Bake(ctx, bakeSpec(next)); !errors.Is(err, bakecatalog.ErrCommitUncertain) {
		t.Fatalf("expected uncertainty: %v", err)
	}
	// The agent did not receive a successful image result and still routes old.
	ref := machine("claim-after-uncertainty", bakeEnv)
	ref.ImageID = old.ImageID
	if n, err := d.restoreData(ctx, ref, []string{"pgdata"}); err != nil || n != 1 {
		t.Fatalf("old latest lost: %d %v", n, err)
	}
	v, _ := docker.volume(projectVolume(ref.MachineID, "pgdata"))
	if v.data != "old seed" {
		t.Fatal("old latest substituted")
	}
}

func TestRestartReconcilesTheAgentPointerBeforeAcknowledgement(t *testing.T) {
	d, docker := bakeDriver(t)
	ctx := context.Background()
	first := bakeWithData(t, d, docker, "claim-first", "old seed")
	old, err := d.Bake(ctx, bakeSpec(first))
	if err != nil {
		t.Fatal(err)
	}
	if err := d.AcknowledgeBake(ctx, old.ImageID); err != nil {
		t.Fatal(err)
	}
	second := bakeWithData(t, d, docker, "claim-second", "new seed")
	current, err := d.Bake(ctx, bakeSpec(second))
	if err != nil {
		t.Fatal(err)
	}
	// The agent installed current, then crashed before its acknowledgement.
	if err := d.Destroy(ctx, first); err != nil {
		t.Fatal(err)
	}
	if err := d.Destroy(ctx, second); err != nil {
		t.Fatal(err)
	}
	if err := d.Close(); err != nil {
		t.Fatal(err)
	}
	restarted, err := New(ctx, docker, d.cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.Close()
	recovered, err := restarted.RecoverBakes(ctx)
	if err != nil || len(recovered) != 1 || recovered[0].ImageID != current.ImageID || !recovered[0].Current {
		t.Fatalf("pointer not reconciled: %v %v", recovered, err)
	}
}

func TestParallelBakesKeepManifestMapsImmutableAndHoldsBounded(t *testing.T) {
	d, docker := bakeDriver(t)
	ctx := context.Background()
	var sources []driver.MachineRef
	for i := 0; i < 8; i++ {
		sources = append(sources, bakeWithData(t, d, docker, fmt.Sprintf("claim-parallel-%d", i), "seed"))
	}
	type outcome struct {
		image driver.ImageRef
		err   error
	}
	done := make(chan outcome, len(sources))
	for _, source := range sources {
		go func(source driver.MachineRef) {
			image, err := d.Bake(ctx, bakeSpec(source))
			done <- outcome{image, err}
		}(source)
	}
	ids := map[string]bool{}
	for range sources {
		result := <-done
		if result.err != nil {
			t.Fatal(result.err)
		}
		if ids[result.image.ImageID] {
			t.Fatal("duplicate generation")
		}
		ids[result.image.ImageID] = true
	}
	c, _ := d.catalogFor(ctx)
	if _, _, held := c.Counts(); held != 0 {
		t.Fatalf("finished bakes leaked %d hold counters", held)
	}
}
