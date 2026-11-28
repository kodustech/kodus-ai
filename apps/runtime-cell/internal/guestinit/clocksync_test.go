package guestinit

import (
	"context"
	"errors"
	"testing"
	"time"
)

// fakeHost answers the offsets of each read in turn (an error for a nil).
type fakeHost struct {
	offsets []*time.Duration
	calls   []string
}

func (f *fakeHost) Offset() (time.Duration, error) {
	o := f.offsets[0]
	f.offsets = f.offsets[1:]
	if o == nil {
		return 0, errors.New("no sample")
	}
	return *o, nil
}

func (f *fakeHost) Step(d time.Duration) error {
	f.calls = append(f.calls, "step "+d.String())
	return nil
}

func (f *fakeHost) Slew(d time.Duration) error {
	f.calls = append(f.calls, "slew "+d.String())
	return nil
}

func dur(d time.Duration) *time.Duration { return &d }

// A guest clock far off the host's (a clock someone set, a restore whose
// rebirth was missed) is stepped onto it, either way; one a little off is
// handed to the kernel's PLL; it is read again every interval until init
// ends; an offset that cannot be read is reported and read again next time.
func TestTheGuestsWallClockFollowsTheHosts(t *testing.T) {
	f := &fakeHost{offsets: []*time.Duration{dur(30 * time.Second), dur(3 * time.Millisecond), nil, dur(-StepThreshold - time.Millisecond)}}
	tick := make(chan time.Time)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	var reported []error
	go func() {
		SyncClock(ctx, f, tick, func(err error) { reported = append(reported, err) })
		close(done)
	}()
	for range 3 {
		tick <- time.Now()
	}
	cancel()
	<-done
	want := []string{"step 30s", "slew 3ms", "step -101ms"}
	if len(f.calls) != len(want) || f.calls[0] != want[0] || f.calls[1] != want[1] || f.calls[2] != want[2] {
		t.Fatalf("calls %v, want %v", f.calls, want)
	}
	if len(reported) != 1 {
		t.Fatalf("reported %v, want the one read that failed", reported)
	}
}
