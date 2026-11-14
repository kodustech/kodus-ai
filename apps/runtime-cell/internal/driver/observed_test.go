package driver_test

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver/drivertest"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver/fake"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/metrics"
)

// The wrapper adds no behavior: the wrapped fake still keeps the contract.
func TestObservedKeepsTheContract(t *testing.T) {
	drivertest.Run(t, func(t *testing.T) drivertest.Subject {
		f := fake.NewForCell("cell-1")
		return drivertest.Subject{
			Driver: driver.Observed(f, metrics.NewRegistry(), slog.New(slog.DiscardHandler)), CellID: "cell-1", Lifecycle: true,
			ForeignMachine: func(*testing.T) driver.MachineRef { return f.Plant("cell-2", "claim-9") },
			ForeignNetwork: func(*testing.T) driver.ClaimNetwork { return f.PlantNetwork("cell-2", "claim-9") },
		}
	})
}

// A refusal of another cell's machine is counted apart and logged as an
// error: it is the alarm an operator pages on.
func TestObservedCountsAndLogsARefusal(t *testing.T) {
	f := fake.NewForCell("cell-1")
	reg := metrics.NewRegistry()
	var logs bytes.Buffer
	d := driver.Observed(f, reg, slog.New(slog.NewJSONHandler(&logs, nil)))
	ctx := context.Background()

	if _, err := d.List(ctx, nil); err != nil {
		t.Fatal(err)
	}
	if err := d.Destroy(ctx, f.Plant("cell-2", "claim-9")); !errors.Is(err, driver.ErrNotOwned) {
		t.Fatalf("Destroy = %v, want ErrNotOwned unchanged through the wrapper", err)
	}
	var text strings.Builder
	if err := reg.WriteText(&text); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`cell_driver_calls_total{op="list",outcome="ok"} 1`,
		`cell_driver_calls_total{op="destroy",outcome="not_owned"} 1`,
		`cell_driver_not_owned_total{op="destroy"} 1`,
	} {
		if !strings.Contains(text.String(), want) {
			t.Errorf("metrics lack %s:\n%s", want, text.String())
		}
	}
	if !strings.Contains(logs.String(), `"level":"ERROR","msg":"driver.not_owned"`) || !strings.Contains(logs.String(), `"driver":"fake"`) {
		t.Errorf("no error log for the refusal: %s", logs.String())
	}
}

func TestOutcomeNamesWhatAnErrorMeans(t *testing.T) {
	for err, want := range map[error]string{
		nil:                 driver.OutcomeOK,
		errors.New("quota"): driver.OutcomeError,
		driver.ErrNotOwned:  driver.OutcomeNotOwned,
		errors.Join(errors.New("x"), driver.ErrUnsupported): driver.OutcomeUnsupported,
	} {
		if got := driver.Outcome(err); got != want {
			t.Errorf("Outcome(%v) = %s, want %s", err, got, want)
		}
	}
}

// budgeted is a driver that sizes claims (MemoryBudget), like docker-gvisor.
type budgeted struct{ *fake.Driver }

func (budgeted) ClaimMemory(driver.ClaimSize) driver.ClaimMemory {
	return driver.ClaimMemory{BootMB: 12288, ReadyMB: 2048}
}

// The cell wraps its driver before it asks for the memory budget: the
// wrapper must not hide it, or memory admission turns off without a word.
func TestMemoryBudgetIsFoundThroughTheObservedWrapper(t *testing.T) {
	wrapped := driver.Observed(budgeted{fake.NewForCell("cell-1")}, metrics.NewRegistry(), slog.New(slog.DiscardHandler))
	if _, ok := wrapped.(driver.MemoryBudget); ok {
		t.Fatal("the wrapper itself is not expected to be a MemoryBudget")
	}
	b, ok := driver.MemoryBudgetOf(wrapped)
	if !ok || b.ClaimMemory(driver.ClaimSize{}).BootMB != 12288 {
		t.Fatalf("MemoryBudgetOf through Observed: ok=%v", ok)
	}
	if _, ok := driver.MemoryBudgetOf(driver.Observed(fake.NewForCell("cell-1"), metrics.NewRegistry(), slog.New(slog.DiscardHandler))); ok {
		t.Fatal("a driver without a budget has none")
	}
}
