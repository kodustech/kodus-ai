package sandbox

import (
	"errors"
	"strings"
	"testing"

	"go.yaml.in/yaml/v3"
)

func appliedApp(t *testing.T, compose string, o Options) map[string]any {
	t.Helper()
	out, err := Apply([]byte(compose), o)
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err := yaml.Unmarshal(out, &doc); err != nil {
		t.Fatal(err)
	}
	return doc["services"].(map[string]any)["app"].(map[string]any)
}

// F3-02: Apply kept stop_grace_period: 87600h, and every down of the claim
// (a destroy, a reset, the sweep) waited for it past the claim's ceiling.
// The cell clamps it to its own stop bound.
func TestStopGracePeriodIsClampedToTheCellsBound(t *testing.T) {
	dir := checkout(t)
	if got := appliedApp(t, "services:\n  app:\n    image: alpine\n    stop_grace_period: 87600h\n", opts(dir))["stop_grace_period"]; got != "10s" {
		t.Fatalf("stop_grace_period %v", got)
	}
	if got := appliedApp(t, "services:\n  app:\n    image: alpine\n    stop_grace_period: 3s\n", opts(dir))["stop_grace_period"]; got != "3s" {
		t.Fatalf("a shorter stop_grace_period became %v", got)
	}
	refused(t, "services:\n  app:\n    image: alpine\n    stop_grace_period: forever\n", dir)
	ok := canonical(``)
	if err := VerifyCanonical([]byte(ok), opts(dir)); err != nil {
		t.Fatal(err)
	}
	var re *RefusedError
	long := strings.Replace(ok, `"image":"x",`, `"image":"x","stop_grace_period":"87600h0m0s",`, 1)
	if err := VerifyCanonical([]byte(long), opts(dir)); !errors.As(err, &re) {
		t.Fatalf("a long stop_grace_period accepted: %v", err)
	}
}

// F3-03: a service-level tmpfs over a cell target was never checked: a tmpfs
// over /run/kodus-coverage emptied a Run's coverage evidence.
func TestATmpfsNeverCoversTheCellsTargets(t *testing.T) {
	dir := checkout(t)
	for _, target := range []string{CoverageTarget, DecoyTarget, ResolvTarget, "/etc/hosts", "/etc/kodus", "/etc/kodus/ca.pem"} {
		for _, line := range []string{"tmpfs: " + target, "tmpfs: [" + target + ":size=1m]", "tmpfs: [/tmp, '" + target + "']"} {
			refused(t, "services:\n  app:\n    image: alpine\n    "+line+"\n", dir)
		}
	}
	refused(t, "services:\n  app:\n    image: alpine\n    tmpfs: {a: b}\n", dir)
	if got := appliedApp(t, "services:\n  app:\n    image: alpine\n    tmpfs: [/tmp, /run/app]\n", opts(dir))["tmpfs"]; got == nil {
		t.Fatal("an ordinary tmpfs was dropped")
	}
	var re *RefusedError
	over := strings.Replace(canonical(``), `"image":"x",`, `"image":"x","tmpfs":["`+CoverageTarget+`"],`, 1)
	if err := VerifyCanonical([]byte(over), opts(dir)); !errors.As(err, &re) {
		t.Fatalf("a tmpfs over the coverage target accepted: %v", err)
	}
}
