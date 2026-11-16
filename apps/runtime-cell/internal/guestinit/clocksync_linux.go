//go:build linux

package guestinit

import (
	"errors"
	"fmt"
	"os"
	"time"

	"golang.org/x/sys/unix"
)

// PTPDevice is the KVM PTP clock's device in the guest.
const PTPDevice = "/dev/ptp0"

// ptpClock is HostClock over the KVM PTP clock and adjtimex.
type ptpClock struct{ f *os.File }

// openHostClock opens the KVM PTP clock; an error when the kernel has none.
func openHostClock() (*ptpClock, error) {
	f, err := os.Open(PTPDevice)
	if err != nil {
		return nil, err
	}
	return &ptpClock{f: f}, nil
}

// Offset is the host's time minus the guest's. The KVM PTP clock answers a
// cross timestamp (PTP_SYS_OFFSET_PRECISE: both clocks read at one instant
// by the hypervisor); a kernel whose driver has none is read by bracketing:
// the guest's clock, the PTP clock, the guest's again, the least delay of
// a few. (ptp_kvm has no gettimex64, so PTP_SYS_OFFSET_EXTENDED is refused.)
func (p *ptpClock) Offset() (time.Duration, error) {
	ns := func(t unix.PtpClockTime) int64 { return t.Sec*1e9 + int64(t.Nsec) }
	if o, err := unix.IoctlPtpSysOffsetPrecise(int(p.f.Fd())); err == nil {
		return time.Duration(ns(o.Device) - ns(o.Realtime)), nil
	}
	phc := unix.FdToClockID(int(p.f.Fd()))
	best, delay := time.Duration(0), int64(-1)
	for range 5 {
		var a, h, b unix.Timespec
		if err := unix.ClockGettime(unix.CLOCK_REALTIME, &a); err != nil {
			return 0, err
		}
		if err := unix.ClockGettime(phc, &h); err != nil {
			return 0, fmt.Errorf("ptp clock: %w", err)
		}
		if err := unix.ClockGettime(unix.CLOCK_REALTIME, &b); err != nil {
			return 0, err
		}
		before, after := unix.TimespecToNsec(a), unix.TimespecToNsec(b)
		if d := after - before; d >= 0 && (delay < 0 || d < delay) {
			delay, best = d, time.Duration(unix.TimespecToNsec(h)-(before+d/2))
		}
	}
	if delay < 0 {
		return 0, errors.New("ptp clock: no usable sample")
	}
	return best, nil
}

func (p *ptpClock) Step(d time.Duration) error {
	var ts unix.Timespec
	if err := unix.ClockGettime(unix.CLOCK_REALTIME, &ts); err != nil {
		return err
	}
	now := unix.TimespecToNsec(ts) + int64(d)
	ts = unix.NsecToTimespec(now)
	return unix.ClockSettime(unix.CLOCK_REALTIME, &ts)
}

// Slew is the kernel PLL's phase offset (ADJ_OFFSET in nanoseconds), as
// ntpd's kernel discipline feeds it; the kernel bounds it and slews.
func (p *ptpClock) Slew(d time.Duration) error {
	tx := unix.Timex{
		Modes:    unix.ADJ_OFFSET | unix.ADJ_NANO | unix.ADJ_STATUS | unix.ADJ_MAXERROR | unix.ADJ_ESTERROR | unix.ADJ_TIMECONST,
		Offset:   int64(d),
		Status:   unix.STA_PLL | unix.STA_NANO,
		Constant: 2,
	}
	_, err := unix.Adjtimex(&tx)
	return err
}
