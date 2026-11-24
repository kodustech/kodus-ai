package agent

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/claims"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/buildmirror"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/recipe"
)

// The Runtime runs like CI: the app's services boot with CI=true, as in the
// customer's own CI, and a recipe that sets CI keeps its value.
func TestServicesBootWithCIUnlessTheRecipeSetsIt(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "docker-compose.yml"), []byte("services:\n  web:\n    image: web\n  api:\n    image: api\n    environment:\n      MODE: test\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, recipeText string
		want             map[string]any
	}{
		{"no recipe env", "version: 1\n", map[string]any{"CI": "true"}},
		{"the recipe's CI wins", "version: 1\nservices:\n  compose:\n    env:\n      CI: 'false'\n", map[string]any{"CI": "false"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec, err := recipe.Parse([]byte(tc.recipeText))
			if err != nil {
				t.Fatal(err)
			}
			proj, err := (&Agent{}).loadClaimCompose(&claims.Claim{}, dir, rec)
			if err != nil {
				t.Fatal(err)
			}
			if got := proj.Service("web")["environment"]; !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("web %v", got)
			}
			want := map[string]any{"MODE": "test"}
			for k, v := range tc.want {
				want[k] = v
			}
			if got := proj.Service("api")["environment"]; !reflect.DeepEqual(got, want) {
				t.Fatalf("api %v", got)
			}
		})
	}
}

// A test that downloads a MongoDB binary or a Prisma engine while it runs
// (mongodb-memory-server in a spec, prisma at start) reaches the cell's
// mirror as the build did: every service gets the mirror's variables, and a
// value the compose file or the recipe sets stays.
func TestServicesGetTheMirrorTheBuildGotUnlessTheProjectSetsIt(t *testing.T) {
	dir := t.TempDir()
	compose := "services:\n  web:\n    image: web\n  api:\n    image: api\n    environment:\n      MONGOMS_DOWNLOAD_MIRROR: https://own.example/mongodb\n"
	if err := os.WriteFile(filepath.Join(dir, "docker-compose.yml"), []byte(compose), 0o644); err != nil {
		t.Fatal(err)
	}
	rec, err := recipe.Parse([]byte("version: 1\nservices:\n  compose:\n    env:\n      PRISMA_ENGINES_MIRROR: http://recipe.example/prisma\n"))
	if err != nil {
		t.Fatal(err)
	}
	m, err := buildmirror.At("http://mirror.cell.internal:8080")
	if err != nil {
		t.Fatal(err)
	}
	a := &Agent{cfg: Config{ServiceEnv: m.Args(nil)}}
	proj, err := a.loadClaimCompose(&claims.Claim{}, dir, rec)
	if err != nil {
		t.Fatal(err)
	}
	web, _ := proj.Service("web")["environment"].(map[string]any)
	for k, want := range map[string]string{
		"CI":                      "true",
		"MONGOMS_DOWNLOAD_MIRROR": "http://mirror.cell.internal:8080/artifacts/mongodb",
		"MONGOMS_USE_HTTP":        "1",
		"PRISMA_ENGINES_MIRROR":   "http://recipe.example/prisma",
		"npm_config_registry":     "http://mirror.cell.internal:8080/npm/",
	} {
		if web[k] != want {
			t.Errorf("web %s = %v, want %s", k, web[k], want)
		}
	}
	api, _ := proj.Service("api")["environment"].(map[string]any)
	if api["MONGOMS_DOWNLOAD_MIRROR"] != "https://own.example/mongodb" {
		t.Errorf("api kept %v, want its own MONGOMS_DOWNLOAD_MIRROR", api["MONGOMS_DOWNLOAD_MIRROR"])
	}
}

// A cell with no mirror gives its services CI=true and nothing else.
func TestServicesOfACellWithNoMirrorGetOnlyCI(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "docker-compose.yml"), []byte("services:\n  web:\n    image: web\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	a := &Agent{cfg: Config{ServiceEnv: buildmirror.Mirror{}.Args(nil)}}
	proj, err := a.loadClaimCompose(&claims.Claim{}, dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := proj.Service("web")["environment"]; !reflect.DeepEqual(got, map[string]any{"CI": "true"}) {
		t.Fatalf("web %v", got)
	}
}
