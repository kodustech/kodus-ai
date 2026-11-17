package driver_test

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"reflect"
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
		d, parts := driver.Observed(f, f.Parts(), metrics.NewRegistry(), slog.New(slog.DiscardHandler))
		return drivertest.Subject{
			Driver: d, Parts: parts, CellID: "cell-1", Lifecycle: true,
			ForeignMachine: func(*testing.T) driver.MachineRef { return f.Plant("cell-2", "claim-9") },
			ForeignNetwork: func(*testing.T) driver.ClaimNetwork { return f.PlantNetwork("cell-2", "claim-9") },
			UndatedMachine: func(_ *testing.T, ceiling string) string {
				tags := map[string]string{driver.TagCell: "cell-1", driver.TagClaim: "undated", driver.TagRole: string(driver.RoleWorkload)}
				if ceiling != "" {
					tags[driver.TagHardExpires] = ceiling
				}
				return f.PlantTags(tags).MachineID
			},
		}
	})
}

// A refusal of another cell's machine is counted apart and logged as an
// error: it is the alarm an operator pages on.
func TestObservedCountsAndLogsARefusal(t *testing.T) {
	f := fake.NewForCell("cell-1")
	reg := metrics.NewRegistry()
	var logs bytes.Buffer
	d, _ := driver.Observed(f, f.Parts(), reg, slog.New(slog.NewJSONHandler(&logs, nil)))
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

// everyPart is a value of every part's interface, so a Parts can be filled
// whole: a new field it does not implement makes the test below panic,
// asking for the field here.
type everyPart struct {
	driver.Baker
	driver.BakeSourcePinner
	driver.BakeCatalog
	driver.MachineResetter
	driver.ComposeBooter
	driver.RecipeRunner
	driver.Pooler
	driver.Sandboxer
	driver.Snapshotter
	driver.SessionForgetter
	driver.MemoryBudget
	driver.SandboxBudget
	driver.ReadySettler
	driver.Diagnoser
	driver.ServiceLogReader
	driver.HealthReader
	driver.BootTimer
	driver.BootPhaser
	driver.BuildStateReporter
	driver.SQLObserverProvisioner
	driver.CoverageFlusher
	driver.Sweeper
}

// The cell wraps its driver before the agent reads its parts: every part the
// driver has must come back out of the wrapper, or a capability (memory
// admission on the dev cell) turns off without a word.
func TestObservedHandsBackEveryPart(t *testing.T) {
	var in driver.Parts
	v := reflect.ValueOf(&in).Elem()
	for i := range v.NumField() {
		v.Field(i).Set(reflect.ValueOf(everyPart{}))
	}
	_, out := driver.Observed(fake.NewForCell("cell-1"), in, metrics.NewRegistry(), slog.New(slog.DiscardHandler))
	got := reflect.ValueOf(out)
	for i := range got.NumField() {
		if got.Field(i).IsNil() {
			t.Errorf("Observed dropped the %s part", got.Type().Field(i).Name)
		}
	}
	if _, none := driver.Observed(fake.NewForCell("cell-1"), driver.Parts{}, metrics.NewRegistry(), slog.New(slog.DiscardHandler)); none != (driver.Parts{}) {
		t.Errorf("Observed gave a driver with no parts some: %+v", none)
	}
}

// budget is a driver's memory budget, like docker-gvisor's.
type budget struct{}

func (budget) ClaimMemory(driver.ClaimSize) driver.ClaimMemory {
	return driver.ClaimMemory{BootMB: 12288, ReadyMB: 2048}
}

// A wrapped driver's budget is the one it had: admission counts the same.
func TestObservedKeepsTheMemoryBudget(t *testing.T) {
	_, parts := driver.Observed(fake.NewForCell("cell-1"), driver.Parts{Memory: budget{}}, metrics.NewRegistry(), slog.New(slog.DiscardHandler))
	if parts.Memory == nil || parts.Memory.ClaimMemory(driver.ClaimSize{}).BootMB != 12288 {
		t.Fatalf("memory budget through Observed: %v", parts.Memory)
	}
}

// A bake and a reset are calls of the driver too: the wrapper counts them.
func TestObservedCountsBakesAndResets(t *testing.T) {
	f := fake.NewForCell("cell-1")
	reg := metrics.NewRegistry()
	_, parts := driver.Observed(f, f.Parts(), reg, slog.New(slog.DiscardHandler))
	ctx := context.Background()
	if _, err := parts.Baker.Bake(ctx, driver.BakeSpec{CellID: "cell-1", OrgID: "org-a", EnvironmentID: "env-1", KMSKeyRef: "k"}); err != nil {
		t.Fatal(err)
	}
	if err := parts.Resetter.Reset(ctx, driver.MachineRef{MachineID: "gone"}, driver.SnapshotRef{Kind: "disk"}); err == nil {
		t.Fatal("a reset of no machine succeeded")
	}
	var text strings.Builder
	if err := reg.WriteText(&text); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`cell_driver_calls_total{op="bake",outcome="ok"} 1`,
		`cell_driver_calls_total{op="reset",outcome="error"} 1`,
	} {
		if !strings.Contains(text.String(), want) {
			t.Errorf("metrics lack %s:\n%s", want, text.String())
		}
	}
}
