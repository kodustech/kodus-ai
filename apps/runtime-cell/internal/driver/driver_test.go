package driver

import (
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestWorkloadBootFailedKeepsTheMessageAndTheCause(t *testing.T) {
	cause := errors.New("up: service app exited (1)")
	err := fmt.Errorf("boot: %w", WorkloadBootFailed(cause))
	if !errors.Is(err, ErrWorkloadBoot) || !errors.Is(err, cause) {
		t.Fatalf("%v is not both the mark and its cause", err)
	}
	if err.Error() != "boot: up: service app exited (1)" {
		t.Fatalf("message %q", err.Error())
	}
	if WorkloadBootFailed(nil) != nil || errors.Is(cause, ErrWorkloadBoot) {
		t.Fatal("nil stays nil, and an unmarked error is not a workload boot failure")
	}
	recipe := WorkloadRecipeRefused(cause)
	if !errors.Is(recipe, ErrWorkloadRecipe) || errors.Is(recipe, ErrWorkloadBoot) || errors.Is(err, ErrWorkloadRecipe) {
		t.Fatal("each mark is only itself")
	}
}

// A claim never gets more than the cell grants: memory and CPUs are each
// held to the maximum, and a cell that grants no size refuses any.
func TestClaimSizeWithin(t *testing.T) {
	ceiling := ClaimSize{MemoryMB: 8192, CPUs: 4}
	for _, s := range []ClaimSize{{}, {MemoryMB: 8192, CPUs: 4}, {MemoryMB: 512, CPUs: 1}} {
		if err := s.Within(ceiling); err != nil {
			t.Errorf("%v refused under %v: %v", s, ceiling, err)
		}
	}
	for _, s := range []ClaimSize{{MemoryMB: 8193, CPUs: 4}, {MemoryMB: 8192, CPUs: 5}, {MemoryMB: -1, CPUs: 1}} {
		err := s.Within(ceiling)
		if !errors.Is(err, ErrSizeUnavailable) || !strings.Contains(err.Error(), "8192 MB / 4 CPUs") {
			t.Errorf("%v under %v: %v, want size unavailable naming the ceiling", s, ceiling, err)
		}
	}
	if err := (ClaimSize{MemoryMB: 512, CPUs: 1}).Within(ClaimSize{}); !errors.Is(err, ErrSizeUnavailable) {
		t.Errorf("a cell that grants no size took one: %v", err)
	}
}

// A machine's ceiling decides every sweep: at it or past it the machine is
// expired, and one with no ceiling, or one that does not parse, already is.
// A renewal stops at the ceiling and is refused when there is none.
func TestTheCeilingRule(t *testing.T) {
	now := time.Date(2026, 11, 14, 12, 0, 0, 0, time.UTC)
	at := func(d time.Duration) map[string]string {
		return map[string]string{TagHardExpires: FormatTime(now.Add(d))}
	}
	expired := map[string]struct {
		tags map[string]string
		want bool
	}{
		"under the ceiling": {at(time.Minute), false},
		"at the ceiling":    {at(0), true},
		"past the ceiling":  {at(-time.Minute), true},
		"no ceiling":        {map[string]string{}, true},
		"a bad ceiling":     {map[string]string{TagHardExpires: "tomorrow"}, true},
	}
	for name, c := range expired {
		if got := Expired(c.tags, now); got != c.want {
			t.Errorf("Expired(%s) = %v, want %v", name, got, c.want)
		}
	}
	if got, err := ClampToCeiling(now.Add(time.Hour), at(time.Minute)); err != nil || !got.Equal(now.Add(time.Minute)) {
		t.Errorf("ClampToCeiling past the ceiling = %v, %v; want the ceiling", got, err)
	}
	if got, err := ClampToCeiling(now, at(time.Minute)); err != nil || !got.Equal(now) {
		t.Errorf("ClampToCeiling under the ceiling = %v, %v; want it unchanged", got, err)
	}
	if _, err := ClampToCeiling(now, map[string]string{TagHardExpires: "tomorrow"}); !errors.Is(err, ErrNoCeiling) {
		t.Errorf("ClampToCeiling with a bad ceiling = %v, want ErrNoCeiling", err)
	}
}
