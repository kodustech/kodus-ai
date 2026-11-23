package agent

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/claims"
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
