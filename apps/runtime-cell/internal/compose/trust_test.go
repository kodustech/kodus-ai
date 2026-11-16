package compose

import (
	"os"
	"path/filepath"
	"testing"

	"go.yaml.in/yaml/v3"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose/sandbox"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/machinetrust"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/recipe"
)

// The recipe's env goes into every service's environment (the agent's
// loadClaimCompose), and the org's secrets after it. On a claim with
// secrets the cell's trust variables still win: a recipe that names
// SSL_CERT_FILE or NODE_EXTRA_CA_CERTS does not take the injector's CA away.
func TestRecipeEnvCannotReplaceTheCABundleVariables(t *testing.T) {
	rec, err := recipe.Parse([]byte("version: 1\nservices:\n  compose:\n    env:\n      SSL_CERT_FILE: /app/certs.pem\n      NODE_EXTRA_CA_CERTS: /app/ca.pem\n      GIT_SSL_CAINFO: /app/git.pem\n      APP_MODE: test\n"))
	if err != nil {
		t.Fatal(err)
	}
	proj, err := FromYAML([]byte("services:\n  api:\n    image: a\n  db:\n    image: b\n"))
	if err != nil {
		t.Fatal(err)
	}
	if err := proj.AddEnvironment(rec.Services.Compose.Env); err != nil {
		t.Fatal(err)
	}
	if err := proj.AddEnvironment(map[string]string{"NPM_TOKEN": "kph_placeholder"}); err != nil {
		t.Fatal(err)
	}
	file, err := proj.Marshal()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, "src"), 0o755); err != nil {
		t.Fatal(err)
	}
	out, err := sandbox.Apply(file, sandbox.Options{
		ProjectDir: dir, Project: "kodus-claim-1-workload", Runtime: "runsc", Network: "kodus-claim-1",
		Trust: machinetrust.Files{Bundle: "/var/lib/kodus-cell/trust/ca-bundle.pem", CellCA: "/var/lib/kodus-cell/trust/cell-ca.pem"},
	})
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Services map[string]struct {
			Environment map[string]any `yaml:"environment"`
		} `yaml:"services"`
	}
	if err := yaml.Unmarshal(out, &doc); err != nil {
		t.Fatal(err)
	}
	want := machinetrust.Env(machinetrust.BundleTarget, machinetrust.CellCATarget)
	for name, svc := range doc.Services {
		for k, v := range want {
			if svc.Environment[k] != v {
				t.Errorf("%s: %s = %v, want the cell's %s", name, k, svc.Environment[k], v)
			}
		}
		if svc.Environment["APP_MODE"] != "test" || svc.Environment["NPM_TOKEN"] != "kph_placeholder" {
			t.Errorf("%s: the recipe's other env or the secret is gone: %v", name, svc.Environment)
		}
	}
}
