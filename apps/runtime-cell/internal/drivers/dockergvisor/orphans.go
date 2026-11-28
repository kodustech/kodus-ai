package dockergvisor

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"time"
)

// orphanGrace is how old a machine's directory with no container must be
// before the orphan pass takes it: a machine being made has its container
// before its build directories, and this margin covers a slow Docker.
const orphanGrace = 2 * time.Minute

// machineDirs are the work directory's per-machine directories, by base.
var machineDirs = []string{"builds", filepath.Join("cache", "machine"), filepath.Join("buildkit", "machine")}

// ReapOrphans is reaper.OrphanReaper for a docker-gvisor cell: the machine
// directories (builds, build caches and states) of a machine none of whose
// containers is left, which a cell that died between removing a machine's
// containers and its directories leaves behind, and the claim networks no
// machine is left on (idleNetworks). Containers of the cell with no machine
// are already List's (a builder a dead cell left).
func (r *Reaper) ReapOrphans(ctx context.Context) ([]string, error) {
	now := r.cfg.Now()
	groups, err := r.groups(ctx)
	if err != nil {
		return nil, err
	}
	live := map[string]bool{}
	for _, g := range groups {
		live[g.name] = true
	}
	seen := map[string]bool{}
	var gone []string
	var errs []error
	for _, base := range machineDirs {
		ents, err := os.ReadDir(filepath.Join(r.cfg.WorkDir, base))
		if err != nil {
			continue
		}
		for _, e := range ents {
			name := e.Name()
			if !e.IsDir() || live[name] || seen[name] || !machineNamePattern.MatchString(name) {
				continue
			}
			if fi, err := e.Info(); err != nil || now.Sub(fi.ModTime()) < orphanGrace {
				continue
			}
			seen[name] = true
			if err := r.removeDirs(name); err != nil {
				errs = append(errs, err)
				continue
			}
			gone = append(gone, "directories "+name)
		}
	}
	idle, err := r.idleNetworks(ctx, now, idleNetworkGrace)
	errs = append(errs, err)
	for _, n := range idle {
		if err := r.releaseNetworks(ctx, []string{n}); err != nil {
			errs = append(errs, err)
			continue
		}
		gone = append(gone, "network "+n)
	}
	return gone, errors.Join(errs...)
}
