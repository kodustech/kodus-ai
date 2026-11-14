package dockergvisor

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/recipe"
)

const dataCompose = "services:\n  db:\n    image: postgres:16\n    volumes: [pgdata:/var/lib/postgresql/data]\nvolumes:\n  pgdata: {}\n  cache: {}\n"

func recipeDir(t *testing.T, reset string) string {
	t.Helper()
	dir := t.TempDir()
	if reset != "" {
		writeFile(t, filepath.Join(dir, recipe.Path), "version: 1\ndata: { migrate: ./migrate, reset: "+reset+" }\n")
	}
	return dir
}

// Only a recipe that keeps its data in named volumes bakes them.
func TestDataKeysFollowTheRecipe(t *testing.T) {
	keys, err := dataKeys([]byte(dataCompose), recipeDir(t, "snapshot"))
	if err != nil || strings.Join(keys, ",") != "cache,pgdata" {
		t.Fatalf("snapshot recipe: %v %v", keys, err)
	}
	for _, reset := range []string{"", "recreate", "reseed"} {
		if keys, err := dataKeys([]byte(dataCompose), recipeDir(t, reset)); err != nil || len(keys) != 0 {
			t.Errorf("reset %q baked data %v %v", reset, keys, err)
		}
	}
}

// holder plants the machine's holder container, as Create makes it.
func holder(docker *memDocker, ref driver.MachineRef) {
	docker.plant(dockercli.Container{ID: "h-" + ref.MachineID, Name: ref.MachineID, Labels: map[string]string{dockercli.LabelFromTag(driver.TagCell): "cell-1"}})
}

// bakeWithData boots the setup machine (its volumes holding data), pins it
// and returns it ready to bake.
func bakeWithData(t *testing.T, d *Driver, docker *memDocker, claim, data string) driver.MachineRef {
	t.Helper()
	ref := machine(claim, bakeEnv)
	holder(docker, ref)
	boot(t, d, ref)
	d.machineOutput(ref.MachineID).volumes = []string{"pgdata"}
	docker.plantVolume(ref.MachineID, "pgdata", data)
	if err := d.PinBakeSource(ref); err != nil {
		t.Fatal(err)
	}
	return ref
}

func bakeVolumes(docker *memDocker) []string {
	vols, _ := docker.Volumes(context.Background(), map[string]string{labelBakeVolume: ""})
	var out []string
	for _, v := range vols {
		out = append(out, v.Name+"="+docker.volumes[v.Name].data)
	}
	sort.Strings(out)
	return out
}

// The release that follows the ack brings the setup project down but its
// volumes wait for the bake, which copies them under runsc and then removes
// them; in whichever order the two come.
func TestBakeCopiesTheSetupDataWhateverTheReleaseOrder(t *testing.T) {
	for _, order := range []string{"release first", "bake first"} {
		t.Run(order, func(t *testing.T) {
			d, docker := bakeDriver(t)
			ctx := context.Background()
			setup := bakeWithData(t, d, docker, "claim-setup", "migrated+seeded")
			vol := projectVolume(setup.MachineID, "pgdata")
			release := func() {
				if err := d.Destroy(ctx, setup); err != nil {
					t.Fatal(err)
				}
			}
			if order == "release first" {
				release()
				if _, ok := docker.volume(vol); !ok {
					t.Fatal("the release took the volume the bake was about to copy")
				}
			}
			image, err := d.Bake(ctx, bakeSpec(setup))
			if err != nil {
				t.Fatal(err)
			}
			if order == "bake first" {
				if _, ok := docker.volume(vol); !ok {
					t.Fatal("the bake removed the volume of a project still up")
				}
				release()
			}
			want := generationForTest(t, d, image.ImageID).Volumes["pgdata"] + "=migrated+seeded"
			if got := bakeVolumes(docker); len(got) != 1 || got[0] != want {
				t.Fatalf("bake volumes %v, want [%s]", got, want)
			}
			if _, ok := docker.volume(vol); ok {
				t.Fatal("the setup's volume outlived both the release and the bake")
			}
			for _, c := range docker.copies {
				if !strings.HasPrefix(c, "runsc ") {
					t.Fatalf("a copy of the org's data ran outside gVisor: %q", c)
				}
			}
		})
	}
}

// A later claim starts from the bake's data; a volume it already has (a
// second Up) keeps what it holds; a new bake replaces the old data.
func TestAClaimStartsFromTheBakedData(t *testing.T) {
	d, docker := bakeDriver(t)
	ctx := context.Background()
	setup := bakeWithData(t, d, docker, "claim-setup", "v1")
	image, err := d.Bake(ctx, bakeSpec(setup))
	if err != nil {
		t.Fatal(err)
	}
	claim := machine("claim-base", bakeEnv)
	claim.ImageID = image.ImageID
	holder(docker, claim)
	n, err := d.restoreData(ctx, claim, []string{"pgdata"})
	if err != nil || n != 1 {
		t.Fatalf("restored %d %v, want the one baked volume", n, err)
	}
	v, _ := docker.volume(projectVolume(claim.MachineID, "pgdata"))
	if v.data != "v1" || v.labels["com.docker.compose.project"] != claim.MachineID || v.labels["com.docker.compose.volume"] != "pgdata" {
		t.Fatalf("the claim's volume %+v is not the project's copy of the bake", v)
	}
	// The app wrote to it; a second Up must not put the bake back.
	docker.volumes[projectVolume(claim.MachineID, "pgdata")] = memVolume{labels: v.labels, data: "written by the claim"}
	if n, _ := d.restoreData(ctx, claim, []string{"pgdata"}); n != 0 {
		t.Fatal("the bake overwrote a volume the claim already has")
	}
	// The claim's down -v takes its copy, never the bake.
	if err := d.Destroy(ctx, claim); err != nil {
		t.Fatal(err)
	}
	if _, ok := docker.volume(projectVolume(claim.MachineID, "pgdata")); ok {
		t.Fatal("the claim's copy outlived it")
	}

	next := bakeWithData(t, d, docker, "claim-setup-2", "v2")
	spec := bakeSpec(next)
	spec.SHA = strings.Repeat("c", 40)
	nextImage, err := d.Bake(ctx, spec)
	if err != nil {
		t.Fatal(err)
	}
	if err := d.AcknowledgeBake(ctx, nextImage.ImageID); err != nil {
		t.Fatal(err)
	}
	if got := bakeVolumes(docker); len(got) != 1 || !strings.HasSuffix(got[0], "=v2") {
		t.Fatalf("bake volumes after a new bake %v, want only v2", got)
	}
	// Another environment's claim gets nothing of this one's.
	if n, _ := d.restoreData(ctx, machine("claim-other", "env-2"), []string{"pgdata"}); n != 0 {
		t.Fatal("another environment started from this one's data")
	}
}

// A copy that fails leaves no partial volumes and stops the boot.
func TestAFailedRestoreStopsBootAndRemovesPartialData(t *testing.T) {
	d, docker := bakeDriver(t)
	ctx := context.Background()
	setup := bakeWithData(t, d, docker, "claim-setup", "v1")
	d.pinned[setup.MachineID].volumes = []string{"a", "pgdata"}
	docker.plantVolume(setup.MachineID, "a", "va")
	image, err := d.Bake(ctx, bakeSpec(setup))
	if err != nil {
		t.Fatal(err)
	}
	claim := machine("claim-base", bakeEnv)
	claim.ImageID = image.ImageID
	failing := &failSecond{memDocker: docker}
	d.d = failing
	if n, err := d.restoreData(ctx, claim, []string{"a", "pgdata"}); !errors.Is(err, os.ErrDeadlineExceeded) || n != 0 {
		t.Fatalf("restored %d %v, want the copy error and no data", n, err)
	}
	if _, ok := docker.volume(projectVolume(claim.MachineID, "a")); ok {
		t.Fatal("a half restore kept the first volume")
	}
}

// failSecond fails the second volume copy.
type failSecond struct {
	*memDocker
	n int
}

func (f *failSecond) CopyVolumeGeneration(ctx context.Context, runtime, helper, from, to string, labels map[string]string, parent, expected, write string) error {
	return f.memDocker.copyGeneration(from, to, expected, write, func() error { return f.CopyVolumeIn(ctx, runtime, helper, from, to, labels) })
}

func (f *failSecond) CopyVolumeIn(ctx context.Context, runtime, helper, from, to string, labels map[string]string) error {
	if f.n++; f.n == 2 {
		return os.ErrDeadlineExceeded
	}
	return f.memDocker.CopyVolumeIn(ctx, runtime, helper, from, to, labels)
}

// The release and the bake at the same time: the data is always copied,
// and the setup's volume always goes, exactly once.
func TestBakeAndReleaseRacingNeverLoseOrLeakTheData(t *testing.T) {
	for i := 0; i < 50; i++ {
		d, docker := bakeDriver(t)
		ctx := context.Background()
		setup := bakeWithData(t, d, docker, "claim-setup", "seeded")
		done := make(chan error, 2)
		go func() { _, err := d.Bake(ctx, bakeSpec(setup)); done <- err }()
		go func() { done <- d.Destroy(ctx, setup) }()
		for range 2 {
			if err := <-done; err != nil {
				t.Fatal(err)
			}
		}
		if got := bakeVolumes(docker); len(got) != 1 || !strings.HasSuffix(got[0], "=seeded") {
			t.Fatalf("run %d: bake volumes %v", i, got)
		}
		if _, ok := docker.volume(projectVolume(setup.MachineID, "pgdata")); ok {
			t.Fatalf("run %d: the setup's volume leaked", i)
		}
	}
}
