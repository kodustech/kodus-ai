package driver

import (
	"errors"
	"fmt"
	"strings"
	"testing"
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
	max := ClaimSize{MemoryMB: 8192, CPUs: 4}
	for _, s := range []ClaimSize{{}, {MemoryMB: 8192, CPUs: 4}, {MemoryMB: 512, CPUs: 1}} {
		if err := s.Within(max); err != nil {
			t.Errorf("%v refused under %v: %v", s, max, err)
		}
	}
	for _, s := range []ClaimSize{{MemoryMB: 8193, CPUs: 4}, {MemoryMB: 8192, CPUs: 5}, {MemoryMB: -1, CPUs: 1}} {
		err := s.Within(max)
		if !errors.Is(err, ErrSizeUnavailable) || !strings.Contains(err.Error(), "8192 MB / 4 CPUs") {
			t.Errorf("%v under %v: %v, want size unavailable naming the max", s, max, err)
		}
	}
	if err := (ClaimSize{MemoryMB: 512, CPUs: 1}).Within(ClaimSize{}); !errors.Is(err, ErrSizeUnavailable) {
		t.Errorf("a cell that grants no size took one: %v", err)
	}
}
