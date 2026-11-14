package localdocker

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/recipe"
)

const fakeStripeImage = "stripe/stripe-mock@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const fakeEmailImage = "axllent/mailpit@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

// Before #2494 local-docker accepted this declaration but never added a fake.
func TestDeclaredFakesBecomePrivateServicesBeforeBuild(t *testing.T) {
	dir := writeFakeRepo(t, map[string]string{
		"compose.yaml": "services: { web: { build: . } }\n",
		recipe.Path:    "version: 1\nservices: { compose: { public: web } }\nfakes:\n  stripe: { image: " + fakeStripeImage + ", env: { STRIPE_API_BASE: 'http://stripe-mock:12111' } }\n  email: { image: " + fakeEmailImage + " }\n",
	})
	plan, err := newBootPlan(dir, "fixture", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	proj, err := compose.FromYAML(plan.adapted)
	if err != nil {
		t.Fatal(err)
	}
	if !proj.HasService("stripe-mock") || !proj.HasService("mailpit") {
		t.Fatal("declared fakes were silently ignored")
	}
	if len(plan.services) != 3 {
		t.Fatalf("generated services not accounted: %v", plan.services)
	}
	for _, svc := range []string{"stripe-mock", "mailpit"} {
		for _, forbidden := range []string{"ports", "volumes", "build", "privileged", "container_name"} {
			if _, exists := proj.Service(svc)[forbidden]; exists {
				t.Fatalf("fake has %s", forbidden)
			}
		}
	}
	if proj.Service("stripe-mock")["image"] != fakeStripeImage {
		t.Fatal("fake image pin changed")
	}
	if !strings.Contains(string(plan.adapted), "http://stripe-mock:12111") {
		t.Fatal("fake app environment not materialized")
	}
}

func TestUnpinnedFakeAndCollisionRefuseTheBootPlan(t *testing.T) {
	for _, tc := range []struct{ name, services, fakes string }{
		{"unpinned", "web: { build: . }", "stripe: { image: stripe-mock }"},
		{"collision", "web: { build: . }, mailpit: { image: alpine }", "email: { image: " + fakeEmailImage + " }"},
		{"env conflict", "web: { build: ., environment: { SMTP_HOST: real.example } }", "email: { image: " + fakeEmailImage + ", env: { SMTP_HOST: mailpit } }"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := writeFakeRepo(t, map[string]string{"compose.yaml": "services: { " + tc.services + " }\n", recipe.Path: "version: 1\nfakes: { " + tc.fakes + " }\n"})
			if _, err := newBootPlan(dir, "fixture", nil, nil); err == nil {
				t.Fatal("unsafe fake declaration reached a build plan")
			}
		})
	}
}

func writeFakeRepo(t *testing.T, files map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	for name, contents := range files {
		file := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(file, []byte(contents), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

// Mailpit stores messages in its own container. Reusing that container on a
// reseed or volume-only snapshot reset used to leak messages across rounds.
func TestDeclaredFakesAlwaysRecreateEvenForFastResetStrategies(t *testing.T) {
	for _, strategy := range []string{"reseed", "snapshot"} {
		t.Run(strategy, func(t *testing.T) {
			ctx := context.Background()
			d, m, work, dir := snapshotRig(t, strategy)
			text := "version: 1\ndata: { migrate: ./migrate, reset: " + strategy + " }\nfakes: { email: { image: " + fakeEmailImage + " } }\n"
			if err := os.WriteFile(filepath.Join(dir, recipe.Path), []byte(text), 0o600); err != nil {
				t.Fatal(err)
			}
			if err := d.Boot(ctx, work, dir); err != nil {
				t.Fatal(err)
			}
			if d.hasSnapshot(work.MachineID) {
				t.Fatal("a fake-bearing environment took a state-retaining shortcut snapshot")
			}
			n := len(m.calls)
			if err := d.Reset(ctx, work, driver.SnapshotRef{Kind: "compose_volumes"}); err != nil {
				t.Fatal(err)
			}
			calls := callsFrom(m, n)
			if !strings.Contains(calls, "down "+work.MachineID+" v=true") || !strings.Contains(calls, "up "+work.MachineID) {
				t.Fatalf("fake was not recreated:\n%s", calls)
			}
		})
	}
}

func TestDeclaredFakeNeverPublishesAHostPort(t *testing.T) {
	dir := writeFakeRepo(t, map[string]string{"compose.yaml": "services: { web: { image: application } }\n", recipe.Path: "version: 1\nservices: { expose: [{ service: mailpit, port: 8025, kind: http }] }\nfakes: { email: { image: " + fakeEmailImage + " } }\n"})
	if _, err := newBootPlan(dir, "fixture", nil, nil); err == nil {
		t.Fatal("declared fake gained a host port")
	}
}

// A generated fake joins Compose's implicit default network. Local Docker
// preserves application networks, unlike the canonical isolated-cell rewrite.
func TestDeclaredFakeRefusesUnreachableApplicationNetworks(t *testing.T) {
	for _, networks := range []string{
		"networks: [backend]",
		"networks: {backend: {}}",
		"network_mode: none",
		"network_mode: host",
	} {
		t.Run(networks, func(t *testing.T) {
			dir := writeFakeRepo(t, map[string]string{
				"compose.yaml": "services: {web: {image: application, " + networks + "}}\nnetworks: {backend: {}}\n",
				recipe.Path:    "version: 1\nfakes: {email: {image: " + fakeEmailImage + ", env: {SMTP_HOST: mailpit}}}\n",
			})
			if plan, err := newBootPlan(dir, "fixture", nil, nil); err == nil || plan != nil {
				t.Fatal("fake declaration accepted without a shared default network")
			} else if !errors.Is(err, driver.ErrWorkloadRecipe) {
				t.Fatalf("network refusal is not a typed recipe error: %v", err)
			}
		})
	}
}

func TestDeclaredFakeAcceptsApplicationOnExplicitDefaultNetwork(t *testing.T) {
	dir := writeFakeRepo(t, map[string]string{
		"compose.yaml": "services: {web: {image: application, networks: [backend, default]}}\nnetworks: {backend: {}}\n",
		recipe.Path:    "version: 1\nfakes: {email: {image: " + fakeEmailImage + "}}\n",
	})
	if _, err := newBootPlan(dir, "fixture", nil, nil); err != nil {
		t.Fatal(err)
	}
}
