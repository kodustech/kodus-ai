package main

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"strconv"
	"strings"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/metrics"
)

// observeDriver wraps the cell's driver and its parts with metrics
// (driver.Observed), then turns memory admission on when the parts carry a
// memory budget (ADR-070). A cell that requires admission
// (RequireMemoryAdmission) and has no budget part or no figure refuses to
// start: it never falls back to free slots without a word.
func observeDriver(cfg *agent.Config, st settings, reg *metrics.Registry, log *slog.Logger, total func() (int, error)) error {
	cfg.Driver, cfg.Parts = driver.Observed(cfg.Driver, cfg.Parts, reg, log)
	if cfg.Parts.Memory == nil || !st.MemoryAdmission {
		if cfg.RequireMemoryAdmission {
			return fmt.Errorf("%w: the %s driver gives no memory budget, or -memory-admission is off", driver.ErrResourceEnforcement, cfg.Driver.Kind())
		}
		return nil
	}
	mb, err := allocatableMemoryMB(st.MemoryAllocatableMB, st.MemoryReserveMB, total)
	if err != nil {
		if cfg.RequireMemoryAdmission {
			return fmt.Errorf("%w: %w", driver.ErrResourceEnforcement, err)
		}
		// Never a guess: without a figure the cell admits by free slots, as before.
		log.Warn("memory.admission_off", "err", err)
		return nil
	}
	cfg.MemoryAllocatableMB = mb
	log.Info("memory.admission", "allocatableMb", mb, "reserveMb", st.MemoryReserveMB)
	return nil
}

// allocatableMemoryMB is what the cell may commit to claims (ADR-070): the
// operator's figure when set, else the host's memory less the reserve.
func allocatableMemoryMB(set, reserve int, total func() (int, error)) (int, error) {
	if set < 0 || reserve < 0 {
		return 0, errors.New("memory: -memory-allocatable-mb and -memory-reserve-mb may not be negative")
	}
	if set > 0 {
		return set, nil
	}
	mb, err := total()
	if err != nil {
		return 0, err
	}
	if mb-reserve <= 0 {
		return 0, fmt.Errorf("memory: the host's %d MB leave nothing past the %d MB reserve", mb, reserve)
	}
	return mb - reserve, nil
}

// readMemTotalMB reads MemTotal from /proc/meminfo (Linux).
func readMemTotalMB() (int, error) {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0, fmt.Errorf("memory: %w (set -memory-allocatable-mb)", err)
	}
	defer func() { _ = f.Close() }()
	return parseMemTotalMB(f)
}

// parseMemTotalMB reads the "MemTotal: N kB" line of a meminfo.
func parseMemTotalMB(r io.Reader) (int, error) {
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) == 3 && fields[0] == "MemTotal:" && fields[2] == "kB" {
			kb, err := strconv.ParseInt(fields[1], 10, 64)
			if err != nil || kb <= 0 {
				return 0, fmt.Errorf("memory: MemTotal %q", fields[1])
			}
			return int(kb / 1024), nil
		}
	}
	if err := sc.Err(); err != nil {
		return 0, err
	}
	return 0, errors.New("memory: no MemTotal in /proc/meminfo")
}
