package dockergvisor

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"math"
	"net/url"
	"path"
	"strconv"
	"strings"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/claimlimits"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockercli"
)

var ErrResourceEnforcement = driver.ErrResourceEnforcement

const (
	labelLimitKey          = "kodus.resource-key"
	labelLimitMemory       = "kodus.resource-memory"
	labelLimitQuota        = "kodus.resource-cpu-quota"
	labelLimitPids         = "kodus.resource-host-pids"
	cpuPeriod        int64 = 100000
)

type limitGroup struct {
	key, parent, network string
	limits               claimlimits.Limits
}

func resourceKey(cell, org, physical string) string {
	h := sha256.New()
	for _, s := range []string{cell, org, physical} {
		fmt.Fprintf(h, "%d:%s", len(s), s)
	}
	return hex.EncodeToString(h.Sum(nil))
}

func (d *Driver) groupFor(ctx context.Context, network, org string, size driver.ClaimSize) (limitGroup, error) {
	if d.cfg.ClaimLimits == nil {
		return limitGroup{}, nil
	}
	labels, err := d.d.NetworkLabels(ctx, network)
	if err != nil {
		return limitGroup{}, errors.Join(ErrResourceEnforcement, err)
	}
	if org == "" || labels == nil || labels["kodus.cell"] != d.cfg.CellID || labels["kodus.org"] != org {
		return limitGroup{}, errors.Join(ErrResourceEnforcement, driver.ErrNotOwned)
	}
	mem := d.defaultMemMB
	if size.MemoryMB > 0 {
		mem = size.MemoryMB
	}
	cpu, err := strconv.ParseFloat(d.cfg.CPUs, 64)
	if err != nil || math.IsNaN(cpu) || math.IsInf(cpu, 0) || cpu <= 0 || cpu > 1024 {
		return limitGroup{}, ErrResourceEnforcement
	}
	if size.CPUs > 0 {
		cpu = float64(size.CPUs)
	}
	pids := d.cfg.PidsLimit
	if pids == 0 {
		pids = 2048
	}
	g := limitGroup{key: resourceKey(d.cfg.CellID, org, network), network: network, limits: claimlimits.Limits{MemoryBytes: int64(mem) << 20, CPUQuota: int64(cpu * float64(cpuPeriod)), CPUPeriod: cpuPeriod, Pids: int64(pids)}}
	if err = d.ensureGroup(&g); err != nil {
		return limitGroup{}, err
	}
	return g, nil
}

// Observers share the workload/pool's already pinned physical budget. Their
// ClaimSize is intentionally zero (independent machine sizing on VM drivers),
// so it must never be interpreted as a request for this driver's defaults.
func (d *Driver) observerGroup(ctx context.Context, network, org string) (limitGroup, error) {
	if d.cfg.ClaimLimits == nil {
		return limitGroup{}, nil
	}
	labels, err := d.d.NetworkLabels(ctx, network)
	if err != nil {
		return limitGroup{}, errors.Join(ErrResourceEnforcement, err)
	}
	if org == "" || labels == nil || labels["kodus.cell"] != d.cfg.CellID || labels["kodus.org"] != org || labels["kodus.claim"] == "" || networkName(labels["kodus.claim"]) != network {
		return limitGroup{}, errors.Join(ErrResourceEnforcement, driver.ErrNotOwned)
	}
	d.mu.Lock()
	g, ok := d.limitGroups[network]
	d.mu.Unlock()
	if !ok || g.network != network || g.key != resourceKey(d.cfg.CellID, org, network) || g.parent == "" {
		return limitGroup{}, fmt.Errorf("%w: observer requires the pinned physical claim budget", ErrResourceEnforcement)
	}
	if err = claimlimits.ValidateDockerParent(g.parent); err != nil {
		return limitGroup{}, errors.Join(ErrResourceEnforcement, err)
	}
	// Ensure revalidates the authoritative backend and kernel ceilings; it never
	// changes an existing ceiling. Adoption rehydrates this cache via the holder.
	if err = d.ensureGroup(&g); err != nil {
		return limitGroup{}, err
	}
	return g, nil
}

func (d *Driver) ensureGroup(g *limitGroup) error {
	p, err := d.cfg.ClaimLimits.Ensure(g.key, g.limits)
	if err != nil {
		return errors.Join(ErrResourceEnforcement, err)
	}
	if p == "" {
		return ErrResourceEnforcement
	}
	if err = claimlimits.ValidateDockerParent(p); err != nil {
		return errors.Join(ErrResourceEnforcement, err)
	}
	if g.parent != "" && g.parent != p {
		return ErrResourceEnforcement
	}
	g.parent = p
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.limitGroups == nil {
		d.limitGroups = map[string]limitGroup{}
	}
	d.limitGroups[g.network] = *g
	return nil
}

func (g limitGroup) label(labels map[string]string) {
	if g.key == "" {
		return
	}
	labels[labelLimitKey] = g.key
	labels[labelLimitMemory] = strconv.FormatInt(g.limits.MemoryBytes, 10)
	labels[labelLimitQuota] = strconv.FormatInt(g.limits.CPUQuota, 10)
	labels[labelLimitPids] = strconv.FormatInt(g.limits.Pids, 10)
}

// Recover from daemon metadata, never from process-local defaults after restart.
func (d *Driver) groupFromHolder(ctx context.Context, ref driver.MachineRef) (limitGroup, error) {
	if d.cfg.ClaimLimits == nil {
		return limitGroup{}, nil
	}
	cs, err := d.d.Inspect(ctx, ref.MachineID)
	if err != nil {
		return limitGroup{}, errors.Join(ErrResourceEnforcement, err)
	}
	for _, c := range cs {
		if c.Name != ref.MachineID {
			continue
		}
		org := c.Labels["kodus.org"]
		if c.Labels["kodus.cell"] != d.cfg.CellID || org == "" || (ref.Tags[driver.TagOrg] != "" && org != ref.Tags[driver.TagOrg]) {
			return limitGroup{}, errors.Join(ErrResourceEnforcement, driver.ErrNotOwned)
		}
		physical := networkName(c.Labels["kodus.claim"])
		if _, ok := c.Networks[physical]; !ok {
			return limitGroup{}, ErrResourceEnforcement
		}
		g := limitGroup{key: resourceKey(d.cfg.CellID, org, physical), parent: c.CgroupParent, network: physical}
		if g.parent == "" || c.Labels[labelLimitKey] != g.key {
			return limitGroup{}, ErrResourceEnforcement
		}
		read := func(k string) (int64, error) {
			n, e := strconv.ParseInt(c.Labels[k], 10, 64)
			if e != nil || n <= 0 {
				return 0, ErrResourceEnforcement
			}
			return n, nil
		}
		if g.limits.MemoryBytes, err = read(labelLimitMemory); err != nil {
			return limitGroup{}, err
		}
		if g.limits.CPUQuota, err = read(labelLimitQuota); err != nil {
			return limitGroup{}, err
		}
		if g.limits.Pids, err = read(labelLimitPids); err != nil {
			return limitGroup{}, err
		}
		pids := d.cfg.PidsLimit
		if pids == 0 {
			pids = 2048
		}
		if g.limits.Pids > int64(pids) {
			return limitGroup{}, ErrResourceEnforcement
		}
		g.limits.CPUPeriod = cpuPeriod
		if g.limits.MemoryBytes > int64(d.maxSize.MemoryMB)<<20 || g.limits.CPUQuota > d.maxCPUQuota() {
			return limitGroup{}, ErrResourceEnforcement
		}
		if err = d.ensureGroup(&g); err != nil {
			return limitGroup{}, err
		}
		if err = d.cfg.ClaimLimits.Verify(g.key, c.PID); err != nil {
			return limitGroup{}, errors.Join(ErrResourceEnforcement, err)
		}
		return g, nil
	}
	return limitGroup{}, ErrResourceEnforcement
}
func (d *Driver) parentFor(ctx context.Context, ref driver.MachineRef) (string, error) {
	g, err := d.groupFromHolder(ctx, ref)
	return g.parent, err
}

func cleanupContext(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
}

func (d *Driver) removeLimitGroup(ctx context.Context, g limitGroup) error {
	if d.cfg.ClaimLimits == nil || g.key == "" {
		return nil
	}
	d.mu.Lock()
	for _, p := range d.pinned {
		if p.group.key == g.key {
			d.mu.Unlock()
			return nil
		}
	}
	d.mu.Unlock()
	labels, err := d.d.NetworkLabels(ctx, g.network)
	if err != nil || labels != nil {
		return err
	}
	if err = d.cfg.ClaimLimits.Remove(g.key); err != nil {
		return errors.Join(ErrResourceEnforcement, err)
	}
	d.mu.Lock()
	delete(d.limitGroups, g.network)
	d.mu.Unlock()
	return nil
}
func (d *Driver) sweepLimitGroups(ctx context.Context) error {
	if d.cfg.ClaimLimits == nil {
		return nil
	}
	d.mu.Lock()
	gs := make([]limitGroup, 0, len(d.limitGroups))
	for _, g := range d.limitGroups {
		gs = append(gs, g)
	}
	d.mu.Unlock()
	var errs []error
	for _, g := range gs {
		if ctx.Err() != nil {
			return errors.Join(append(errs, ctx.Err())...)
		}
		errs = append(errs, d.removeLimitGroup(ctx, g))
	}
	return errors.Join(errs...)
}

func (d *Driver) maxCPUQuota() int64 {
	v, _ := strconv.ParseFloat(d.cfg.CPUs, 64)
	return int64(math.Max(v, float64(d.maxSize.CPUs)) * float64(cpuPeriod))
}

// ValidateClaimLimitEndpoint refuses remote, ambiguous or non-Unix Docker
// endpoints: resource readback belongs to the same kernel as this cell.
func ValidateClaimLimitEndpoint(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "unix" || u.Host != "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || !strings.HasPrefix(u.Path, "/") || u.Path == "/" || path.Clean(u.Path) != u.Path || strings.ContainsAny(raw, "\r\n\x00") {
		return fmt.Errorf("%w: claim limits require a local Unix Docker socket", ErrResourceEnforcement)
	}
	return nil
}

// ValidateClaimLimitDaemon checks explicit controller/runtime facts before any
// claim starts. It never reconfigures Docker or changes runsc's global mode.
func ValidateClaimLimitDaemon(info dockercli.CgroupDaemonInfo, backend, runtime string) error {
	if info.Version != "2" || info.Driver != backend || info.Rootless || (backend != "cgroupfs" && backend != "systemd") {
		return fmt.Errorf("%w: rootful Docker cgroup v2 must match configured backend", ErrResourceEnforcement)
	}
	if backend == "systemd" {
		rt, ok := info.Runtimes[runtime]
		if !ok || rt.Path == "" {
			return fmt.Errorf("%w: runtime configuration missing", ErrResourceEnforcement)
		}
		enabled := false
		for _, arg := range rt.RuntimeArgs {
			if arg == "--systemd-cgroup" || arg == "--systemd-cgroup=true" {
				enabled = true
			} else if strings.HasPrefix(arg, "--systemd-cgroup=") {
				return fmt.Errorf("%w: runtime systemd-cgroup mode is disabled or unknown", ErrResourceEnforcement)
			}
		}
		if !enabled {
			return fmt.Errorf("%w: runsc must enable --systemd-cgroup", ErrResourceEnforcement)
		}
	}
	return nil
}
