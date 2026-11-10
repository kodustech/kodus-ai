package dockergvisor

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockercli"
)

// A newer bake used to replace the data behind a machine's older image pin.
func TestPinnedRestoreRefusesAnotherBakesData(t *testing.T) {
	d, docker := bakeDriver(t)
	ctx := context.Background()
	setup := bakeWithData(t, d, docker, "claim-setup", "old seed")
	image, err := d.Bake(ctx, bakeSpec(setup))
	if err != nil {
		t.Fatal(err)
	}
	next := bakeWithData(t, d, docker, "claim-setup-next", "new seed")
	spec := bakeSpec(next)
	spec.SHA = strings.Repeat("b", 40)
	nextImage, err := d.Bake(ctx, spec)
	if err != nil {
		t.Fatal(err)
	}
	if err := d.AcknowledgeBake(ctx, nextImage.ImageID); err != nil {
		t.Fatal(err)
	}
	ref := machine("claim-base", bakeEnv)
	ref.ImageID = image.ImageID
	if n, err := d.restoreData(ctx, ref, []string{"pgdata"}); err == nil || n != 0 {
		t.Fatalf("missing pinned seed accepted: restored=%d err=%v", n, err)
	}
	if _, exists := docker.volume(projectVolume(ref.MachineID, "pgdata")); exists {
		t.Fatal("a different bake's data reached the claim")
	}
}

// Docker may retain multiple generations after a prune failure. Selection
// used to depend on map/list order instead of the machine's image pin.
func TestPinnedRestoreSelectsItsSHAAndScope(t *testing.T) {
	for _, scope := range []string{"matching", "other environment", "other cell", "malformed"} {
		t.Run(scope, func(t *testing.T) {
			d, docker := bakeDriver(t)
			sha := strings.Repeat("a", 40)
			labels := envLabels("cell-1", bakeOrg, bakeEnv)
			labels[labelBakeVolume], labels[labelBakeSHA] = "pgdata", sha
			docker.volumes[bakeVolume("cell-1", bakeOrg, bakeEnv, "pgdata", sha)] = memVolume{labels: labels, data: "pinned seed"}
			otherLabels := envLabels("cell-1", bakeOrg, bakeEnv)
			otherLabels[labelBakeVolume], otherLabels[labelBakeSHA] = "pgdata", strings.Repeat("b", 40)
			docker.volumes[bakeVolume("cell-1", bakeOrg, bakeEnv, "pgdata", strings.Repeat("b", 40))] = memVolume{labels: otherLabels, data: "another generation"}
			ref := machine("claim-base", bakeEnv)
			ref.ImageID = bakeImageID("cell-1", bakeOrg, bakeEnv, sha)
			switch scope {
			case "other environment":
				ref.ImageID = bakeImageID("cell-1", bakeOrg, "env-other", sha)
			case "other cell":
				ref.ImageID = bakeImageID("cell-other", bakeOrg, bakeEnv, sha)
			case "malformed":
				ref.ImageID = "kodus-bake/broken@" + sha
			}
			n, err := d.restoreData(context.Background(), ref, []string{"pgdata"})
			if scope != "matching" {
				if err == nil || n != 0 {
					t.Fatalf("invalid scope restored=%d err=%v", n, err)
				}
				return
			}
			v, ok := docker.volume(projectVolume(ref.MachineID, "pgdata"))
			if err != nil || n != 1 || !ok || v.data != "pinned seed" {
				t.Fatalf("restored=%d data=%q err=%v", n, v.data, err)
			}
		})
	}
}

type countingComposeDocker struct {
	*limitsPathDocker
	ups int
}

// The fixture supplies Docker Compose's expanded form for dataCompose;
// the stateful fake otherwise returns the unexpanded YAML volume syntax.
func (d *countingComposeDocker) ComposeConfig(ctx context.Context, p dockercli.ComposeProject) ([]byte, error) {
	raw, err := d.limitsPathDocker.ComposeConfig(ctx, p)
	if err != nil {
		return nil, err
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, err
	}
	doc["volumes"] = map[string]any{
		"pgdata": map[string]any{"name": p.Name + "_pgdata"},
		"cache":  map[string]any{"name": p.Name + "_cache"},
	}
	doc["services"].(map[string]any)["db"].(map[string]any)["volumes"] = []any{
		map[string]any{"type": "volume", "source": "pgdata", "target": "/var/lib/postgresql/data"},
	}
	return json.Marshal(doc)
}

func (d *countingComposeDocker) ComposeUp(context.Context, dockercli.ComposeProject) error {
	d.ups++
	return nil
}

func TestUpStopsBeforeComposeWhenPinnedSeedIsUnavailable(t *testing.T) {
	d, docker, _ := limitedPathsDriver(t)
	ctx := context.Background()
	n, ref := makeLimitedClaim(t, d, "claim-missing-seed")
	ref.ImageID = bakeImageID("cell-1", bakeOrg, bakeEnv, strings.Repeat("a", 40))
	counter := &countingComposeDocker{limitsPathDocker: docker}
	d.d = counter
	if _, err := d.Up(ctx, ref, []byte(dataCompose), recipeDir(t, "snapshot")); !errors.Is(err, ErrBakeDataUnavailable) {
		t.Fatalf("boot did not retain seed refusal: %v", err)
	}
	if counter.ups != 0 {
		t.Fatal("compose started without the pinned seed")
	}
	if err := d.Destroy(ctx, ref); err != nil {
		t.Fatal(err)
	}
	if err := d.ReleaseClaim(ctx, n); err != nil {
		t.Fatal(err)
	}
}

// A successful cleanup used to turn a failed copy into a successful empty
// restore, allowing Compose to boot and seed a different state.
func TestPinnedRestorePropagatesCopyFailureAfterCleanup(t *testing.T) {
	d, docker := bakeDriver(t)
	setup := bakeWithData(t, d, docker, "claim-setup", "seed")
	d.pinned[setup.MachineID].volumes = []string{"a", "pgdata"}
	docker.plantVolume(setup.MachineID, "a", "seed a")
	image, err := d.Bake(context.Background(), bakeSpec(setup))
	if err != nil {
		t.Fatal(err)
	}
	ref := machine("claim-base", bakeEnv)
	ref.ImageID = image.ImageID
	d.d = &failSecond{memDocker: docker}
	if n, err := d.restoreData(context.Background(), ref, []string{"a", "pgdata"}); n != 0 || !errors.Is(err, os.ErrDeadlineExceeded) {
		t.Fatalf("copy failure lost: restored=%d err=%v", n, err)
	}
	for _, k := range []string{"a", "pgdata"} {
		if _, ok := docker.volume(projectVolume(ref.MachineID, k)); ok {
			t.Fatal("partial restore left a volume")
		}
	}
}

// A pinned snapshot must be complete before the first copy starts.
func TestPinnedRestoreRefusesMissingOrAmbiguousVolumes(t *testing.T) {
	for _, defect := range []string{"missing", "wrong name", "duplicate"} {
		t.Run(defect, func(t *testing.T) {
			d, docker := bakeDriver(t)
			setup := bakeWithData(t, d, docker, "claim-setup", "seed")
			image, err := d.Bake(context.Background(), bakeSpec(setup))
			if err != nil {
				t.Fatal(err)
			}
			name := generationForTest(t, d, image.ImageID).Volumes["pgdata"]
			v := docker.volumes[name]
			switch defect {
			case "wrong name":
				delete(docker.volumes, name)
				docker.volumes["unrelated-volume"] = v
			case "duplicate":
				docker.volumes["duplicate-volume"] = v
			}
			ref := machine("claim-base", bakeEnv)
			ref.ImageID = image.ImageID
			keys := []string{"pgdata"}
			if defect == "missing" {
				keys = append(keys, "absent")
			}
			before := len(docker.copies)
			if n, err := d.restoreData(context.Background(), ref, keys); n != 0 || err == nil {
				t.Fatalf("incomplete pin restored=%d err=%v", n, err)
			}
			if len(docker.copies) != before {
				t.Fatal("copied data before validating the complete selection")
			}
		})
	}
}

// Clean setup must migrate and seed from scratch; an unresolved image never
// authorizes reading the environment's previous data.
func TestSetupAndUnpinnedClaimsNeverReadAnEnvironmentBake(t *testing.T) {
	for _, kind := range []string{"setup", "latest", "ordinary image", "empty"} {
		t.Run(kind, func(t *testing.T) {
			d, docker := bakeDriver(t)
			setup := bakeWithData(t, d, docker, "claim-setup", "old seed")
			image, err := d.Bake(context.Background(), bakeSpec(setup))
			if err != nil {
				t.Fatal(err)
			}
			ref := machine("claim-new", bakeEnv)
			switch kind {
			case "setup":
				ref.ImageID = image.ImageID
				d.machineLocked(ref.MachineID).setup = true
			case "latest":
				ref.ImageID = "latest"
			case "ordinary image":
				ref.ImageID = "base-image"
			}
			before := len(docker.copies)
			if n, err := d.restoreData(context.Background(), ref, []string{"pgdata"}); err != nil || n != 0 {
				t.Fatalf("untrusted seed restored=%d err=%v", n, err)
			}
			if len(docker.copies) != before {
				t.Fatal("read the previous environment's seed")
			}
		})
	}
}

// A warm-pool holder must not be advertised under image A after copying B.
func TestPoolRefusesDifferentSeedGenerationAndCleansItsMachine(t *testing.T) {
	d, docker := bakeDriver(t)
	setup := bakeWithData(t, d, docker, "claim-setup", "new seed")
	specB := bakeSpec(setup)
	specB.SHA = strings.Repeat("b", 40)
	if _, err := d.Bake(context.Background(), specB); err != nil {
		t.Fatal(err)
	}
	s := spec()
	before := len(docker.containers)
	_, err := d.PoolCreate(context.Background(), driver.PoolSpec{
		CellID: s.CellID, OrgID: s.OrgID, EnvironmentID: bakeEnv,
		ImageID: bakeImageID("cell-1", bakeOrg, bakeEnv, strings.Repeat("a", 40)),
		Size:    s.Size, KMSKeyRef: s.KMSKeyRef, ExpiresAt: s.ExpiresAt, HardExpiresAt: s.HardExpiresAt,
	})
	if err == nil {
		t.Fatal("pool accepted data from a different bake")
	}
	if len(docker.containers) != before {
		t.Fatal("failed pool creation left its holder")
	}
}

// An already restored claim keeps its own state after the environment
// prunes the source bake. Only a missing copy needs that original source.
func TestPinnedExistingProjectDataSurvivesANewerBake(t *testing.T) {
	d, docker := bakeDriver(t)
	ctx := context.Background()
	setup := bakeWithData(t, d, docker, "claim-setup", "old seed")
	image, err := d.Bake(ctx, bakeSpec(setup))
	if err != nil {
		t.Fatal(err)
	}
	ref := machine("claim-base", bakeEnv)
	ref.ImageID = image.ImageID
	if n, err := d.restoreData(ctx, ref, []string{"pgdata"}); err != nil || n != 1 {
		t.Fatalf("first restore %d %v", n, err)
	}
	next := bakeWithData(t, d, docker, "claim-setup-next", "new seed")
	spec := bakeSpec(next)
	spec.SHA = strings.Repeat("b", 40)
	nextImage, err := d.Bake(ctx, spec)
	if err != nil {
		t.Fatal(err)
	}
	if err := d.AcknowledgeBake(ctx, nextImage.ImageID); err != nil {
		t.Fatal(err)
	}
	before := len(docker.copies)
	if n, err := d.restoreData(ctx, ref, []string{"pgdata"}); n != 0 || err != nil {
		t.Fatalf("existing copy rejected: restored=%d err=%v", n, err)
	}
	if len(docker.copies) != before {
		t.Fatal("existing project data was overwritten")
	}
	delete(docker.volumes, projectVolume(ref.MachineID, "pgdata"))
	if n, err := d.restoreData(ctx, ref, []string{"pgdata"}); n != 0 || err == nil {
		t.Fatalf("missing old copy replaced: restored=%d err=%v", n, err)
	}
}
