package localdocker

import (
	"errors"
	"slices"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/recipe"
)

// The direct driver path must refuse the same unsupported contract as the
// agent. A warning cannot stand in for provisioning a read-only SQL account.
func TestLocalDockerDirectPlanRefusesSeededSQLObserver(t *testing.T) {
	const content = `version: 1
services:
  expose:
    - {service: db, port: 5432, kind: postgres, readonly_user_from_seed: true}
data:
  seed: {service: db, user: shop, database: shop, sql: seed.sql}
`
	dir := writeFakeRepo(t, map[string]string{
		"compose.yaml": "services: {db: {image: 'postgres:16'}}\n",
		recipe.Path:    content,
		"seed.sql":     "CREATE TABLE orders(id integer);\n",
	})
	plan, err := newBootPlan(dir, "fixture", nil, nil)
	if err == nil || plan != nil {
		t.Fatal("local-docker silently ignored required SQL account provisioning")
	}
	if !errors.Is(err, driver.ErrWorkloadRecipe) {
		t.Fatalf("unsupported SQL account contract needs a typed recipe refusal: %v", err)
	}
	rec, err := recipe.Parse([]byte(content))
	if err != nil {
		t.Fatal(err)
	}
	if slices.Contains(recipeKeysIgnored(rec), "services.expose.readonly_user_from_seed") {
		t.Fatal("a refused SQL requirement is still reported as merely ignored")
	}
}

func TestLocalDockerDirectPlanStillAcceptsOrdinaryPostgresExpose(t *testing.T) {
	dir := writeFakeRepo(t, map[string]string{
		"compose.yaml": "services: {db: {image: 'postgres:16'}}\n",
		recipe.Path:    "version: 1\nservices: {expose: [{service: db, port: 5432, kind: postgres}]}\n",
	})
	if _, err := newBootPlan(dir, "fixture", nil, nil); err != nil {
		t.Fatal(err)
	}
}
