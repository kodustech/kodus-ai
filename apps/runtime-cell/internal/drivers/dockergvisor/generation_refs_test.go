package dockergvisor

import (
	"context"
	"strings"
	"testing"
)

// A bake of several repositories keeps its refsDigest in the generation
// and names its data by it: the default-branch commit of the claim's own
// repository says nothing of the others'. A refsDigest that is not one
// makes the generation invalid.
func TestABakeOfSeveralRepositoriesIsKeyedByItsRefsDigest(t *testing.T) {
	d, docker := bakeDriver(t)
	setup := bakeWithData(t, d, docker, "claim-setup", "seeded")
	spec := bakeSpec(setup)
	spec.RefsDigest = "sha256:" + strings.Repeat("ab", 32)
	image, err := d.Bake(context.Background(), spec)
	if err != nil {
		t.Fatal(err)
	}
	g := generationForTest(t, d, image.ImageID)
	if g.RefsDigest != spec.RefsDigest || g.SHA != spec.SHA || g.Key() != spec.RefsDigest {
		t.Fatalf("generation %+v", g)
	}
	if want := bakeVolume("cell-1", bakeOrg, bakeEnv, "pgdata", spec.RefsDigest+"."+g.Nonce); g.Volumes["pgdata"] != want {
		t.Fatalf("volume %s, want %s", g.Volumes["pgdata"], want)
	}
	if got := bakeVolumes(docker); len(got) != 1 || got[0] != g.Volumes["pgdata"]+"=seeded" {
		t.Fatalf("bake volumes %v", got)
	}
	if !validGeneration(g, "cell-1") {
		t.Fatal("the generation is not valid")
	}
	bad := g
	bad.RefsDigest = "sha256:short"
	if validGeneration(bad, "cell-1") {
		t.Fatal("a malformed refsDigest is valid")
	}
	// One repository keeps the commit as its key.
	one := g
	one.RefsDigest = ""
	if one.Key() != spec.SHA || generationVolume(one, "pgdata") != bakeVolume("cell-1", bakeOrg, bakeEnv, "pgdata", spec.SHA+"."+g.Nonce) {
		t.Fatal("a one-repository generation is not keyed by its commit")
	}
}
