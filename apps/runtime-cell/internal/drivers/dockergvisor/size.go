package dockergvisor

import (
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
)

// A claim may ask a size of its own (claim.acquire size): every build and
// service of its workload then gets that memory and those CPUs instead of
// Config.MemLimit and Config.CPUs, never more than Config.MemMax and
// Config.CPUsMax. The size lives in the machine's state (machineState), set
// at Create and dropped at Destroy, so no claim's size reaches another's.

// memSize is a docker memory value: a number, then b, k, m, g, t (binary
// multiples), optionally followed by "i" and "b" ("4g", "512m", "16GiB").
var memSize = regexp.MustCompile(`^([0-9]+(?:\.[0-9]+)?) ?([bkmgt])?i?b?$`)

// parseMemMB reads a docker memory value as whole MB, rounded down.
func parseMemMB(s string) (int, error) {
	m := memSize.FindStringSubmatch(strings.ToLower(strings.TrimSpace(s)))
	if m == nil {
		return 0, fmt.Errorf("dockergvisor: memory %q is not a docker memory value (4g, 512m)", s)
	}
	n, err := strconv.ParseFloat(m[1], 64)
	if err != nil {
		return 0, fmt.Errorf("dockergvisor: memory %q: %w", s, err)
	}
	mult := map[string]float64{"": 1, "b": 1, "k": 1 << 10, "m": 1 << 20, "g": 1 << 30, "t": 1 << 40}[m[2]]
	mb := math.Floor(n * mult / (1 << 20))
	if mb < 1 || mb > math.MaxInt32 {
		return 0, fmt.Errorf("dockergvisor: memory %q is out of range", s)
	}
	return int(mb), nil
}

// parseCPUs reads a docker --cpus value ("2", "1.5") and the whole CPUs in it.
func parseCPUs(s string) (int, error) {
	n, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
	if err != nil || n <= 0 || n > 1024 {
		return 0, fmt.Errorf("dockergvisor: cpus %q is not a positive number", s)
	}
	return max(int(math.Floor(n)), 1), nil
}

// maxClaimSize is the largest size the cell grants one claim: MemMax and
// CPUsMax, or the defaults when they are unset. It refuses a maximum below
// the default, which every claim that asks no size gets.
func maxClaimSize(cfg Config) (driver.ClaimSize, error) {
	defMem, err := parseMemMB(cfg.MemLimit)
	if err != nil {
		return driver.ClaimSize{}, err
	}
	defCPUs, err := parseCPUs(cfg.CPUs)
	if err != nil {
		return driver.ClaimSize{}, err
	}
	out := driver.ClaimSize{MemoryMB: defMem, CPUs: defCPUs}
	if cfg.MemMax != "" {
		if out.MemoryMB, err = parseMemMB(cfg.MemMax); err != nil {
			return driver.ClaimSize{}, err
		}
		if out.MemoryMB < defMem {
			return driver.ClaimSize{}, fmt.Errorf("dockergvisor: the memory maximum %s is below the default %s", cfg.MemMax, cfg.MemLimit)
		}
	}
	if cfg.CPUsMax != 0 {
		if cfg.CPUsMax < defCPUs {
			return driver.ClaimSize{}, fmt.Errorf("dockergvisor: the CPU maximum %d is below the default %s", cfg.CPUsMax, cfg.CPUs)
		}
		out.CPUs = cfg.CPUsMax
	}
	return out, nil
}

// limits are the memory and CPUs the machine's builds and services get: the
// size its claim asked, field by field, else the cell's default.
func (d *Driver) limits(machine string) (mem, cpus string) {
	mem, cpus = d.cfg.MemLimit, d.cfg.CPUs
	s := d.peek(machine).size
	if s.MemoryMB > 0 {
		mem = fmt.Sprintf("%dm", s.MemoryMB)
	}
	if s.CPUs > 0 {
		cpus = strconv.Itoa(s.CPUs)
	}
	return mem, cpus
}

// defaultReadyMB is what a ready claim is counted for when -gvisor-mem-ready
// is unset: its services, not its builds, which are done by then.
const defaultReadyMB = 2048

// ClaimMemory is what a claim is counted for on this host (ADR-070): its
// memory limit while it boots (one build at a time gets it), and the smaller
// of that and Config.MemReady once ready. Neither changes a limit.
func (d *Driver) ClaimMemory(size driver.ClaimSize) driver.ClaimMemory {
	boot := d.defaultMemMB
	if size.MemoryMB > 0 {
		boot = size.MemoryMB
	}
	if d.cfg.ClaimLimits != nil {
		return driver.ClaimMemory{BootMB: boot, ReadyMB: boot}
	}
	return driver.ClaimMemory{BootMB: boot, ReadyMB: min(boot, d.readyMB)}
}

var _ driver.MemoryBudget = (*Driver)(nil)
