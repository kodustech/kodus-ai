package guestinit

import (
	"context"
	"time"
)

// The guest's wall clock follows the host's through the KVM PTP clock
// (/dev/ptp0, CONFIG_PTP_1588_CLOCK_KVM), as Firecracker's FAQ recommends
// ("My guest wall-clock is drifting"): kvm-clock keeps the guest's
// monotonic time, but nothing steers its CLOCK_REALTIME after boot or after
// the rebirth's step, so a sandbox or a session that lives for hours drifts
// from the host by the guest's own frequency error. Init does what phc2sys
// (linuxptp) does with a PHC as its source: it reads the offset from the
// PTP clock every SyncInterval, steps the clock when it is off by more than
// StepThreshold (a restore whose rebirth was missed, a clock someone set)
// and otherwise hands the offset to the kernel's PLL, which slews. No
// daemon, no network source, nothing the workload can reach.

const (
	// SyncInterval is how often init reads the offset from the host.
	SyncInterval = 2 * time.Second
	// StepThreshold is the offset above which the clock is stepped, not slewed.
	StepThreshold = 100 * time.Millisecond
)

// HostClock is the guest's view of the host's wall clock.
type HostClock interface {
	// Offset is the host's wall clock minus the guest's.
	Offset() (time.Duration, error)
	// Step moves the guest's wall clock by d at once.
	Step(d time.Duration) error
	// Slew hands d to the kernel's PLL, which corrects it gradually.
	Slew(d time.Duration) error
}

// SyncClock keeps the guest's wall clock on the host's until ctx ends;
// tick is each interval (time.Tick's channel in init, a test's own).
func SyncClock(ctx context.Context, c HostClock, tick <-chan time.Time, report func(error)) {
	for {
		if err := syncOnce(c); err != nil && report != nil {
			report(err)
		}
		select {
		case <-ctx.Done():
			return
		case <-tick:
		}
	}
}

func syncOnce(c HostClock) error {
	off, err := c.Offset()
	if err != nil {
		return err
	}
	if off > StepThreshold || off < -StepThreshold {
		return c.Step(off)
	}
	return c.Slew(off)
}
