package main

import (
	"errors"
	"log/slog"
	"strings"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver/fake"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/metrics"
)

func TestAllocatableMemory(t *testing.T) {
	host := func() (int, error) { return 15_800, nil }
	if mb, err := allocatableMemoryMB(0, 1024, host); err != nil || mb != 14_776 {
		t.Fatalf("host less reserve = %d, %v", mb, err)
	}
	if mb, err := allocatableMemoryMB(12_000, 1024, host); err != nil || mb != 12_000 {
		t.Fatalf("operator's figure = %d, %v", mb, err)
	}
	if _, err := allocatableMemoryMB(0, 16_000, host); err == nil {
		t.Fatal("a reserve above the host took")
	}
	if _, err := allocatableMemoryMB(0, 1024, func() (int, error) { return 0, errors.New("no meminfo") }); err == nil {
		t.Fatal("an unreadable host took")
	}
	if _, err := allocatableMemoryMB(-1, 1024, host); err == nil {
		t.Fatal("a negative figure took")
	}
}

func TestParseMemTotal(t *testing.T) {
	mb, err := parseMemTotalMB(strings.NewReader("MemTotal:       16179288 kB\nMemFree:  1 kB\n"))
	if err != nil || mb != 15_800 {
		t.Fatalf("MemTotal = %d, %v", mb, err)
	}
	if _, err := parseMemTotalMB(strings.NewReader("MemFree: 1 kB\n")); err == nil {
		t.Fatal("no MemTotal took")
	}
}

// budget is a driver's memory budget part, as docker-gvisor's.
type budget struct{}

func (budget) ClaimMemory(driver.ClaimSize) driver.ClaimMemory {
	return driver.ClaimMemory{BootMB: 4096, ReadyMB: 1024}
}

// The cell wraps its driver in Observed before admission reads the budget: a
// wrapped driver still gives its budget, so admission stays on (a bare type
// assertion on the wrapper turned it off on cell-dev-1).
func TestAWrappedDriverStillGivesAdmissionItsMemoryBudget(t *testing.T) {
	cfg := agent.Config{Driver: fake.New(), Parts: driver.Parts{Memory: budget{}}, RequireMemoryAdmission: true}
	st := settings{MemoryAdmission: true, MemoryAllocatableMB: 8192}
	if err := observeDriver(&cfg, st, metrics.NewRegistry(), slog.New(slog.DiscardHandler), nil); err != nil {
		t.Fatal(err)
	}
	if cfg.Parts.Memory == nil || cfg.MemoryAllocatableMB != 8192 {
		t.Fatalf("admission after the wrapper: budget %v, allocatable %d MB", cfg.Parts.Memory, cfg.MemoryAllocatableMB)
	}
}

// A cell that requires memory admission refuses to start on a driver with no
// budget part, or with no figure to admit against, instead of admitting by
// free slots.
func TestRequiredAdmissionWithoutABudgetRefusesToStart(t *testing.T) {
	noFigure := func() (int, error) { return 0, errors.New("no /proc/meminfo") }
	for name, cfg := range map[string]agent.Config{
		"no budget part": {Driver: fake.New(), RequireMemoryAdmission: true},
		"no figure":      {Driver: fake.New(), Parts: driver.Parts{Memory: budget{}}, RequireMemoryAdmission: true},
	} {
		err := observeDriver(&cfg, settings{MemoryAdmission: true}, metrics.NewRegistry(), slog.New(slog.DiscardHandler), noFigure)
		if !errors.Is(err, driver.ErrResourceEnforcement) {
			t.Errorf("%s: %v, want ErrResourceEnforcement", name, err)
		}
	}
	// Not required: the cell admits by free slots, as before.
	cfg := agent.Config{Driver: fake.New()}
	if err := observeDriver(&cfg, settings{MemoryAdmission: true}, metrics.NewRegistry(), slog.New(slog.DiscardHandler), noFigure); err != nil || cfg.MemoryAllocatableMB != 0 {
		t.Fatalf("an optional admission without a budget: %v, %d MB", err, cfg.MemoryAllocatableMB)
	}
}
