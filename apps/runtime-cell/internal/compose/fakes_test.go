package compose

import (
	"bytes"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/recipe"
)

const fixtureMailFake = "version: 1\nfakes: { email: { image: axllent/mailpit@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb, env: { SMTP_HOST: mailpit } } }\n"

func TestFakesPreserveAppDependenciesAndNeverInheritAppEnv(t *testing.T) {
	proj, _ := FromYAML([]byte("services: { web: { image: app, depends_on: [db], environment: { SAFE: application } }, db: { image: postgres } }\n"))
	rec, err := recipe.Parse([]byte(fixtureMailFake))
	if err != nil {
		t.Fatal(err)
	}
	if err := proj.AddRecipeFakes(rec); err != nil {
		t.Fatal(err)
	}
	fake := proj.Service("mailpit")
	env := fake["environment"].(map[string]any)
	if env["MP_MAX_MESSAGES"] != "500" || env["SAFE"] != nil || env["SMTP_HOST"] != nil {
		t.Fatal("application configuration leaked into fake")
	}
	deps := proj.Service("web")["depends_on"].(map[string]any)
	if deps["db"] == nil || deps["mailpit"].(map[string]any)["condition"] != "service_healthy" {
		t.Fatal("dependencies lost or readiness not enforced")
	}
	for _, forbidden := range []string{"ports", "volumes", "build", "privileged", "container_name"} {
		if _, ok := fake[forbidden]; ok {
			t.Fatalf("unexpected fake capability %s", forbidden)
		}
	}
}
func TestFakeConflictIsAtomic(t *testing.T) {
	for _, body := range []string{
		"services: { first: { image: app }, last: { image: app, environment: { SMTP_HOST: real.example } } }",
		"services: { web: { image: app }, mailpit: { image: other } }",
	} {
		proj, _ := FromYAML([]byte(body))
		before, _ := proj.Marshal()
		rec, _ := recipe.Parse([]byte(fixtureMailFake))
		if err := proj.AddRecipeFakes(rec); err == nil {
			t.Fatal("conflict accepted")
		}
		after, _ := proj.Marshal()
		if !bytes.Equal(before, after) {
			t.Fatal("a refused declaration partly mutated project")
		}
	}
}
