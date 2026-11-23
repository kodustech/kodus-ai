package dockergvisor

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/bakecatalog"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
)

const (
	maxBakeArtifacts    = 128
	labelBakeGeneration = "kodus.bake-generation"
)

func generationID(cell, org, env, sha, nonce string) string {
	return bakeImageID(cell, org, env, sha) + "." + nonce
}

func generationVolume(g bakecatalog.Generation, key string) string {
	return bakeVolume(g.Cell, g.Org, g.Environment, key, g.Key()+"."+g.Nonce)
}

func generationImage(g bakecatalog.Generation, fp string) string {
	repo, _ := bakeRepo(g.Cell, g.Org, g.Environment)
	return repo + ":" + g.Nonce + "-" + fp
}

func validGeneration(g bakecatalog.Generation, cell string) bool {
	_, scope := bakeRepo(g.Cell, g.Org, g.Environment)
	if !scope || g.Cell != cell || !bakecatalog.IsHex(g.SHA, 40) || !bakecatalog.IsHex(g.Nonce, 24) || g.ID != generationID(g.Cell, g.Org, g.Environment, g.SHA, g.Nonce) || len(g.RecipeSHA) == 0 || len(g.RecipeSHA) > 128 || g.RefsDigest != "" && !bakecatalog.IsRefsDigest(g.RefsDigest) || len(g.Images) > maxBakeArtifacts || len(g.Volumes) > maxBakeArtifacts {
		return false
	}
	for fp, ref := range g.Images {
		if !bakecatalog.IsHex(fp, 64) || ref != generationImage(g, fp) {
			return false
		}
	}
	for key, name := range g.Volumes {
		if key == "" || len(key) > 128 || name != generationVolume(g, key) {
			return false
		}
	}
	return true
}

// bakeCell is the cell id the bakes' names embed: the cell's own, or the
// cell a template's catalog was adopted from. The names of a generation
// never change, so a host made from a template keeps using them.
func (d *Driver) bakeCell() string {
	if id, ok := d.bakeOwnerID.Load().(string); ok && id != "" {
		return id
	}
	return d.cfg.CellID
}

// catalogFor is the cell's bake catalog, opened on first use and kept until
// Close. The directory is the cell's alone before the catalog reads it.
func (d *Driver) catalogFor(ctx context.Context) (*bakecatalog.Catalog, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	d.catalogMu.Lock()
	defer d.catalogMu.Unlock()
	if d.catalog != nil {
		if d.catalog.Closed() {
			return nil, errors.New("dockergvisor: bake catalog closed")
		}
		return d.catalog, nil
	}
	root := d.cfg.BakeStateDir
	if root == "" {
		root = filepath.Join(d.workDir(), "bake-catalog")
	}
	if err := d.dirs.privateRoot(root); err != nil {
		return nil, err
	}
	cfg := bakecatalog.Config{
		Dir: root, Cell: d.cfg.CellID, Driver: Kind,
		Valid: func(g bakecatalog.Generation) bool { return validGeneration(g, d.cfg.CellID) },
		Quarantined: func(q bakecatalog.Quarantine) {
			// The cell starts with an empty catalog. What the old one named
			// stays on the disk: only its own cell's reaper rules reach it.
			d.log().Warn("bake.catalog.quarantined", "reason", q.Reason, "file", q.File, "owner", q.Owner, "eligible", q.Eligible, "retired", q.Retired)
		},
		// Read at each commit: a test makes one fail after the catalog opened.
		SyncDir: func(dir *os.File) error {
			if d.hooks != nil && d.hooks.syncCatalogDir != nil {
				return d.hooks.syncCatalogDir(dir)
			}
			return dir.Sync()
		},
	}
	if org := d.cfg.BakeAdoptOrg; org != "" {
		cfg.Adopt = &bakecatalog.Adoption{Org: org, Valid: func(owner string) func(bakecatalog.Generation) bool {
			if _, ok := bakeRepo(owner, org, "env"); !ok || owner == d.cfg.CellID {
				return nil
			}
			return func(g bakecatalog.Generation) bool { return validGeneration(g, owner) }
		}}
	}
	c, err := bakecatalog.Open(ctx, cfg)
	if err != nil {
		return nil, err
	}
	if a, ok := c.Adopted(); ok {
		d.log().Info("bake.catalog.adopted", "from", a.From, "org", d.cfg.BakeAdoptOrg, "kept", a.Kept, "retired", a.Retired)
	}
	d.bakeOwnerID.Store(c.Owner())
	d.catalog = c
	return c, nil
}

func (d *Driver) holdGeneration(ctx context.Context, ref driver.MachineRef) (bakecatalog.Generation, func(), error) {
	c, err := d.catalogFor(ctx)
	if err != nil {
		return bakecatalog.Generation{}, nil, err
	}
	g, release, ok := c.Hold(ref.ImageID, ref.Tags[driver.TagOrg], ref.Tags[driver.TagEnv])
	if !ok {
		return bakecatalog.Generation{}, nil, ErrBakeDataUnavailable
	}
	return g, release, nil
}

// publishGeneration makes g eligible once every artifact it names exists.
func (d *Driver) publishGeneration(ctx context.Context, g bakecatalog.Generation) error {
	c, err := d.catalogFor(ctx)
	if err != nil {
		return err
	}
	if err := d.verifyGeneration(ctx, g); err != nil {
		return err
	}
	return c.Publish(g)
}

// AcknowledgeBake follows the agent's latest-pointer update. Before it, old
// eligibility must remain usable even if publication returned an uncertain error.
func (d *Driver) AcknowledgeBake(ctx context.Context, id string) error {
	c, err := d.catalogFor(ctx)
	if err != nil {
		return err
	}
	if !c.Acknowledge(id) {
		return ErrBakeDataUnavailable
	}
	return d.pruneGenerations(ctx)
}

func (d *Driver) verifyGeneration(ctx context.Context, g bakecatalog.Generation) error {
	if !validGeneration(g, d.bakeCell()) {
		return ErrBakeDataUnavailable
	}
	repo, _ := bakeRepo(g.Cell, g.Org, g.Environment)
	refs, err := d.d.ImageRefs(ctx, repo)
	if err != nil {
		return err
	}
	has := map[string]bool{}
	for _, r := range refs {
		has[r] = true
	}
	for _, r := range g.Images {
		if !has[r] {
			return ErrBakeDataUnavailable
		}
	}
	labels := envLabels(g.Cell, g.Org, g.Environment)
	labels[labelBakeGeneration] = g.Nonce
	vols, err := d.d.Volumes(ctx, labels)
	if err != nil {
		return err
	}
	if len(vols) != len(g.Volumes) {
		return ErrBakeDataUnavailable
	}
	seen := map[string]bool{}
	for _, v := range vols {
		k := v.Labels[labelBakeVolume]
		if seen[k] || g.Volumes[k] != v.Name || v.Labels[labelBakeSHA] != g.SHA {
			return ErrBakeDataUnavailable
		}
		for k, want := range labels {
			if v.Labels[k] != want {
				return driver.ErrNotOwned
			}
		}
		seen[k] = true
	}
	return nil
}

// RecoverBakes restores eligibility only. Surviving holders are cleanup-only;
// recovering them would lose leases, keys, taint and physical reservations.
func (d *Driver) RecoverBakes(ctx context.Context) ([]driver.RecoveredBake, error) {
	c, err := d.catalogFor(ctx)
	if err != nil {
		return nil, err
	}
	holders, err := d.d.List(ctx, map[string]string{"kodus.cell": d.cfg.CellID, labelMachine: ""})
	if err != nil {
		return nil, err
	}
	if len(holders) > 0 {
		return nil, errors.New("dockergvisor: reap surviving holders before bake recovery")
	}
	if err := d.pruneGenerations(ctx); err != nil {
		return nil, fmt.Errorf("dockergvisor: pending bake cleanup: %w", err)
	}
	var out []driver.RecoveredBake
	var gone []bakecatalog.Generation
	err = c.Each(func(g bakecatalog.Generation, current bool) error {
		if err := d.verifyGeneration(ctx, g); err != nil {
			// A generation whose artifacts are missing or not this cell's
			// is unusable, never a reason to refuse to start: it is retired
			// below and what is left of it removed. Anything else (the
			// docker daemon failing) is still fatal and retried.
			if errors.Is(err, ErrBakeDataUnavailable) || errors.Is(err, driver.ErrNotOwned) {
				gone = append(gone, g)
				return nil
			}
			return fmt.Errorf("dockergvisor: bake recovery: %w", err)
		}
		out = append(out, driver.RecoveredBake{ImageID: g.ID, OrgID: g.Org, EnvironmentID: g.Environment, SHA: g.SHA, Current: current})
		return nil
	})
	if err != nil {
		return nil, err
	}
	if len(gone) > 0 {
		for _, g := range gone {
			d.log().Warn("bake.recovery.retired", "env", g.Environment, "sha", g.SHA, "generation", g.ID, "reason", "artifacts missing or not owned")
			c.Retire(g.ID)
		}
		if err := d.pruneGenerations(ctx); err != nil {
			d.log().Warn("bake.recovery.cleanup_failed", "err", err)
		}
	}
	return out, nil
}

// pruneGenerations retires what is no longer current, held or awaited, and
// removes the images and volumes of each retired generation.
func (d *Driver) pruneGenerations(ctx context.Context) error {
	c, err := d.catalogFor(ctx)
	if err != nil {
		return err
	}
	return c.Prune(func(g bakecatalog.Generation) error { return d.removeGeneration(ctx, g) })
}

// removeGeneration removes a retired generation's images and volumes; only
// the ones the generation names, and only this cell's.
func (d *Driver) removeGeneration(ctx context.Context, g bakecatalog.Generation) error {
	var errs []error
	for _, image := range g.Images {
		errs = append(errs, d.d.RemoveImage(ctx, image))
	}
	labels := envLabels(g.Cell, g.Org, g.Environment)
	labels[labelBakeGeneration] = g.Nonce
	vols, listErr := d.d.Volumes(ctx, labels)
	errs = append(errs, listErr)
	var names []string
	for _, v := range vols {
		if g.Volumes[v.Labels[labelBakeVolume]] != v.Name {
			errs = append(errs, driver.ErrNotOwned)
			continue
		}
		names = append(names, v.Name)
	}
	if listErr == nil {
		errs = append(errs, d.d.VolumeRemove(ctx, names...))
	}
	return errors.Join(errs...)
}

// stageGeneration records g's exact intended artifacts before any is made.
func (d *Driver) stageGeneration(ctx context.Context, g bakecatalog.Generation) (func(), error) {
	c, err := d.catalogFor(ctx)
	if err != nil {
		return nil, err
	}
	return c.Stage(g)
}

// closeCatalog closes the bake catalog (Shutdown's last step).
func (d *Driver) closeCatalog() error {
	d.catalogMu.Lock()
	defer d.catalogMu.Unlock()
	if d.catalog == nil {
		return nil
	}
	return d.catalog.Close()
}

func generationPin(id string) bool {
	return strings.HasPrefix(id, "kodus-bake/") && strings.Contains(id, ".")
}
