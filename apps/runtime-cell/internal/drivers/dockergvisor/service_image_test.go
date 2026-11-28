package dockergvisor

import (
	"context"
	"errors"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
)

// F3-01: compose pulled the images of the services the cell did not build,
// on the host's daemon, with the cell's docker config and no bound. Now the
// cell pulls each one itself, within its image bound, before anything of
// the project starts (the golden first boot's partial up included), and
// compose never pulls.
func TestUpPullsTheImagesItDidNotBuildBeforeAnythingStarts(t *testing.T) {
	r := newGoldenRig(t, goldenCompose, goldenRecipe)
	bound := strconv.FormatInt(r.d.maxImageBytes(), 10)
	if _, err := r.d.Up(context.Background(), driver.UpRequest{Ref: r.ref, Compose: r.file, ProjectDir: r.dir}); err != nil {
		t.Fatal(err)
	}
	want := []string{"shop-app " + bound + " here", "pgvector/pgvector:pg16 " + bound + " here"} // by service: app, db
	if !slices.Equal(r.docker.servicePulls, want) {
		t.Fatalf("pulls %v, want %v", r.docker.servicePulls, want)
	}
	for _, doc := range r.docker.rendered {
		for name, s := range doc["services"].(map[string]any) {
			if pp := s.(map[string]any)["pull_policy"]; pp != "never" {
				t.Fatalf("%s may be pulled by compose: pull_policy %v", name, pp)
			}
		}
	}
}

// N10: an image the cell itself runs (pulled with the cell's login, maybe
// private) is pulled anonymously even when the host has it, so a compose
// file runs it only as a registry serves it to anyone.
func TestAServiceNamingOneOfTheCellsImagesIsPulledFresh(t *testing.T) {
	r := newGoldenRig(t, goldenCompose, goldenRecipe, func(c *Config) {
		c.CellImages = []string{"docker.io/pgvector/pgvector@sha256:" + strings.Repeat("b", 64)}
	})
	bound := strconv.FormatInt(r.d.maxImageBytes(), 10)
	if _, err := r.d.Up(context.Background(), driver.UpRequest{Ref: r.ref, Compose: r.file, ProjectDir: r.dir}); err != nil {
		t.Fatal(err)
	}
	want := []string{"shop-app " + bound + " here", "pgvector/pgvector:pg16 " + bound + " fresh"}
	if !slices.Equal(r.docker.servicePulls, want) {
		t.Fatalf("pulls %v, want %v", r.docker.servicePulls, want)
	}
}

func TestAnImagePastTheBoundFailsTheUpBeforeAnythingStarts(t *testing.T) {
	r := newGoldenRig(t, goldenCompose, goldenRecipe)
	r.docker.imageSizes = map[string]int64{"pgvector/pgvector:pg16": r.d.maxImageBytes() + 1}
	_, err := r.d.Up(context.Background(), driver.UpRequest{Ref: r.ref, Compose: r.file, ProjectDir: r.dir})
	if !errors.Is(err, driver.ErrImageTooLarge) {
		t.Fatalf("Up: %v", err)
	}
	if len(r.docker.ups) != 0 {
		t.Fatalf("compose up ran %v", r.docker.ups)
	}
}

// R3-02: with no claim limits each service got the claim's whole memory.
// Its services now share it by role (the database a small cap, the app the
// rest, the sandbox some headroom), so what admission counts bounds them.
func TestWithoutClaimLimitsAClaimsServicesShareItsMemory(t *testing.T) {
	r := newGoldenRig(t, goldenCompose, goldenRecipe, func(c *Config) { c.MemLimit = "4g" })
	if _, err := r.d.Up(context.Background(), driver.UpRequest{Ref: r.ref, Compose: r.file, ProjectDir: r.dir}); err != nil {
		t.Fatal(err)
	}
	doc := r.docker.rendered[0]
	for name, s := range doc["services"].(map[string]any) {
		want := map[string]string{"app": "3174m", "db": "512m"}[name]
		if got := s.(map[string]any)["mem_limit"]; got != want {
			t.Fatalf("%s: mem_limit %v, want %s of the claim's 4g", name, got, want)
		}
	}
	if got := r.d.ClaimMemory(driver.ClaimSize{}); got.ReadyMB != 4096 {
		t.Fatalf("a ready claim is counted at %d MB, under what its services may use", got.ReadyMB)
	}
}
