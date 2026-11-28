package localdocker

import (
	"errors"
	"io"
	"log/slog"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
)

// The checkout's own phases fail as the workload's; a snapshot copy or
// restore is the cell's.
func TestOnlyTheCheckoutsPhasesFailAsTheWorkloads(t *testing.T) {
	run := newBootRun(slog.New(slog.NewTextHandler(io.Discard, nil)), "m", bootKindBoot)
	boom := errors.New("boom")
	for _, p := range []string{phaseBuild, phaseUp, phaseSeed, phaseReady} {
		if err := run.phase(p, func() error { return boom }); !errors.Is(err, driver.ErrWorkloadBoot) || err.Error() != p+": boom" {
			t.Fatalf("%s: %v", p, err)
		}
	}
	for _, p := range []string{phaseSnapshot, phaseRestore, phaseDown} {
		if err := run.phase(p, func() error { return boom }); errors.Is(err, driver.ErrWorkloadBoot) {
			t.Fatalf("%s is the cell's: %v", p, err)
		}
	}
	if err := run.phase(phaseUp, func() error { return nil }); err != nil {
		t.Fatal(err)
	}
}
