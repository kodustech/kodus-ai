package dockergvisor

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"golang.org/x/sys/unix"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
)

const (
	maxBakeGenerations  = 1024
	maxBakeArtifacts    = 128
	maxBakeCatalogBytes = 4 << 20
	catalogName         = "catalog.json"
	labelBakeGeneration = "kodus.bake-generation"
)

// A generation is published only after all its immutable artifacts exist.
// Holds are deliberately not persisted: old machines must be reaped before
// recovery, never resurrected with an empty lease or memory ledger.
type bakeGeneration struct {
	ID          string            `json:"id"`
	Cell        string            `json:"cell"`
	Org         string            `json:"org"`
	Environment string            `json:"environment"`
	SHA         string            `json:"sha"`
	RecipeSHA   string            `json:"recipeSha"`
	Nonce       string            `json:"nonce"`
	Images      map[string]string `json:"images"`
	Volumes     map[string]string `json:"volumes"`
}

type bakeCatalogState struct {
	Version     int                       `json:"version"`
	Cell        string                    `json:"cell"`
	Driver      string                    `json:"driver"`
	Generations map[string]bakeGeneration `json:"generations"`
	Current     map[string]string         `json:"current"`
	Retired     map[string]bakeGeneration `json:"retired"`
}

type bakeCatalog struct {
	mu      sync.Mutex
	root    *os.Root
	lock    *os.File
	state   bakeCatalogState
	holds   map[string]int
	closed  bool
	syncDir func(*os.File) error
	// Previous/current generations survive the gap between driver publication
	// and the agent installing its latest pointer, including uncertain commits.
	unconfirmed map[string]bool
}

var errCatalogCommitUncertain = errors.New("dockergvisor: bake catalog commit durability uncertain")

func generationID(cell, org, env, sha, nonce string) string {
	return bakeImageID(cell, org, env, sha) + "." + nonce
}

func generationScope(org, env string) string { return org + "/" + env }

func generationVolume(g bakeGeneration, key string) string {
	return bakeVolume(g.Cell, g.Org, g.Environment, key, g.SHA+"."+g.Nonce)
}

func generationImage(g bakeGeneration, fp string) string {
	repo, _ := bakeRepo(g.Cell, g.Org, g.Environment)
	return repo + ":" + g.Nonce + "-" + fp
}

func hexValue(s string, size int) bool {
	if len(s) != size {
		return false
	}
	for _, c := range s {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

func validGeneration(g bakeGeneration, cell string) bool {
	_, scope := bakeRepo(g.Cell, g.Org, g.Environment)
	if !scope || g.Cell != cell || !hexValue(g.SHA, 40) || !hexValue(g.Nonce, 24) || g.ID != generationID(g.Cell, g.Org, g.Environment, g.SHA, g.Nonce) || len(g.RecipeSHA) == 0 || len(g.RecipeSHA) > 128 || len(g.Images) > maxBakeArtifacts || len(g.Volumes) > maxBakeArtifacts {
		return false
	}
	for fp, ref := range g.Images {
		if !hexValue(fp, 64) || ref != generationImage(g, fp) {
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

func (d *Driver) catalogFor(ctx context.Context) (*bakeCatalog, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	d.catalogMu.Lock()
	defer d.catalogMu.Unlock()
	if d.catalog != nil {
		d.catalog.mu.Lock()
		closed := d.catalog.closed
		d.catalog.mu.Unlock()
		if closed {
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
	r, err := os.OpenRoot(root)
	if err != nil {
		return nil, err
	}
	lock, err := r.OpenFile("lock", os.O_CREATE|os.O_RDWR|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0o600)
	if err != nil {
		r.Close()
		return nil, err
	}
	fail := func(err error) (*bakeCatalog, error) { lock.Close(); r.Close(); return nil, err }
	info, err := lock.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 {
		return fail(errors.New("dockergvisor: unsafe bake catalog lock"))
	}
	if err := unix.Flock(int(lock.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		return fail(errors.New("dockergvisor: bake catalog already controlled"))
	}
	// Only the exclusive controller may remove abandoned atomic-write files.
	// Names and file type are fixed; nothing from a checkout is traversed.
	dir, err := r.Open(".")
	if err != nil {
		return fail(err)
	}
	defer dir.Close()
	for {
		if err := ctx.Err(); err != nil {
			return fail(err)
		}
		entries, err := dir.ReadDir(128)
		if err != nil && !errors.Is(err, io.EOF) {
			return fail(err)
		}
		for _, entry := range entries {
			if !strings.HasPrefix(entry.Name(), "pending-") || !hexValue(strings.TrimPrefix(entry.Name(), "pending-"), 24) {
				continue
			}
			info, err := r.Lstat(entry.Name())
			if err != nil {
				return fail(err)
			}
			if !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 {
				return fail(errors.New("dockergvisor: unsafe pending bake catalog"))
			}
			if err := r.Remove(entry.Name()); err != nil {
				return fail(err)
			}
		}
		if errors.Is(err, io.EOF) {
			break
		}
	}
	c := &bakeCatalog{root: r, lock: lock, holds: map[string]int{}, unconfirmed: map[string]bool{}, syncDir: func(f *os.File) error { return f.Sync() }, state: bakeCatalogState{Version: 1, Cell: d.cfg.CellID, Driver: Kind, Generations: map[string]bakeGeneration{}, Current: map[string]string{}, Retired: map[string]bakeGeneration{}}}
	f, err := r.OpenFile(catalogName, os.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK, 0)
	if err == nil {
		info, statErr := f.Stat()
		if statErr != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 || info.Size() > maxBakeCatalogBytes {
			f.Close()
			return fail(errors.New("dockergvisor: unsafe bake catalog"))
		}
		raw, readErr := io.ReadAll(io.LimitReader(f, maxBakeCatalogBytes+1))
		f.Close()
		if readErr != nil || len(raw) > maxBakeCatalogBytes || json.Unmarshal(raw, &c.state) != nil {
			return fail(errors.New("dockergvisor: invalid bake catalog"))
		}
		canonical, marshalErr := json.Marshal(c.state)
		// Only our canonical representation is accepted. This also refuses
		// duplicate/unknown/case-aliased keys and trailing JSON.
		if marshalErr != nil || !bytes.Equal(raw, canonical) || !c.valid(d.cfg.CellID) {
			return fail(errors.New("dockergvisor: invalid bake catalog"))
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return fail(err)
	}
	d.catalog = c
	return c, nil
}

func (c *bakeCatalog) valid(cell string) bool {
	if c.state.Version != 1 || c.state.Driver != Kind || c.state.Cell != cell || c.state.Generations == nil || c.state.Current == nil || c.state.Retired == nil || len(c.state.Generations)+len(c.state.Retired) > maxBakeGenerations || len(c.state.Current) > maxBakeGenerations {
		return false
	}
	for id, g := range c.state.Generations {
		if id != g.ID || !validGeneration(g, cell) {
			return false
		}
	}
	for id, g := range c.state.Retired {
		if id != g.ID || !validGeneration(g, cell) {
			return false
		}
		if _, eligible := c.state.Generations[id]; eligible {
			return false
		}
	}
	for scope, id := range c.state.Current {
		g, ok := c.state.Generations[id]
		if !ok || scope != generationScope(g.Org, g.Environment) {
			return false
		}
	}
	return true
}

// saveLocked publishes metadata after artifacts, never before. A failed
// write keeps the previous eligible generation and leaves only orphans.
func (c *bakeCatalog) saveLocked() error {
	if c.closed {
		return errors.New("dockergvisor: bake catalog closed")
	}
	raw, err := json.Marshal(c.state)
	if err != nil || len(raw) > maxBakeCatalogBytes {
		return errors.New("dockergvisor: bake catalog limit")
	}
	var nonce [12]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return err
	}
	tmp := "pending-" + hex.EncodeToString(nonce[:])
	f, err := c.root.OpenFile(tmp, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer c.root.Remove(tmp)
	_, err = f.Write(raw)
	if err == nil {
		err = f.Sync()
	}
	err = errors.Join(err, f.Close())
	if err != nil {
		return err
	}
	if err = c.root.Rename(tmp, catalogName); err != nil {
		return err
	}
	dir, err := c.root.Open(".")
	if err != nil {
		return errors.Join(errCatalogCommitUncertain, err)
	}
	if err := errors.Join(c.syncDir(dir), dir.Close()); err != nil {
		return errors.Join(errCatalogCommitUncertain, err)
	}
	return nil
}

func (c *bakeCatalog) hold(id, cell, org, env string) (bakeGeneration, func(), error) {
	c.mu.Lock()
	g, ok := c.state.Generations[id]
	if c.closed || !ok || g.Cell != cell || g.Org != org || g.Environment != env {
		c.mu.Unlock()
		return bakeGeneration{}, nil, ErrBakeDataUnavailable
	}
	c.holds[id]++
	c.mu.Unlock()
	var once sync.Once
	return g, func() {
		once.Do(func() {
			c.mu.Lock()
			if c.holds[id] <= 1 {
				delete(c.holds, id)
			} else {
				c.holds[id]--
			}
			c.mu.Unlock()
		})
	}, nil
}

func (d *Driver) holdGeneration(ctx context.Context, ref driver.MachineRef) (bakeGeneration, func(), error) {
	c, err := d.catalogFor(ctx)
	if err != nil {
		return bakeGeneration{}, nil, err
	}
	return c.hold(ref.ImageID, d.cfg.CellID, ref.Tags[driver.TagOrg], ref.Tags[driver.TagEnv])
}

func (d *Driver) publishGeneration(ctx context.Context, g bakeGeneration) error {
	g.Images = maps.Clone(g.Images)
	g.Volumes = maps.Clone(g.Volumes)
	c, err := d.catalogFor(ctx)
	if err != nil {
		return err
	}
	if err := d.verifyGeneration(ctx, g); err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.state.Generations)+len(c.state.Retired) >= maxBakeGenerations && c.state.Retired[g.ID].ID == "" {
		return errors.New("dockergvisor: bake catalog limit")
	}
	old := c.state
	c.state.Generations = maps.Clone(old.Generations)
	c.state.Current = maps.Clone(old.Current)
	c.state.Retired = maps.Clone(old.Retired)
	delete(c.state.Retired, g.ID)
	c.state.Generations[g.ID] = g
	c.state.Current[generationScope(g.Org, g.Environment)] = g.ID
	if err := c.saveLocked(); err != nil {
		if !errors.Is(err, errCatalogCommitUncertain) {
			c.state = old
		} else {
			c.unconfirmed[g.ID] = true
			if prev := old.Current[generationScope(g.Org, g.Environment)]; prev != "" {
				c.unconfirmed[prev] = true
			}
		}
		return err
	}
	c.unconfirmed[g.ID] = true
	if prev := old.Current[generationScope(g.Org, g.Environment)]; prev != "" {
		c.unconfirmed[prev] = true
	}
	return nil
}

// AcknowledgeBake follows the agent's latest-pointer update. Before it, old
// eligibility must remain usable even if publication returned an uncertain error.
func (d *Driver) AcknowledgeBake(ctx context.Context, id string) error {
	c, err := d.catalogFor(ctx)
	if err != nil {
		return err
	}
	c.mu.Lock()
	g, ok := c.state.Generations[id]
	if !ok || c.state.Current[generationScope(g.Org, g.Environment)] != id {
		c.mu.Unlock()
		return ErrBakeDataUnavailable
	}
	for pending := range c.unconfirmed {
		p, ok := c.state.Generations[pending]
		if ok && generationScope(p.Org, p.Environment) == generationScope(g.Org, g.Environment) {
			delete(c.unconfirmed, pending)
		}
	}
	c.mu.Unlock()
	return d.pruneGenerations(ctx)
}

func (d *Driver) verifyGeneration(ctx context.Context, g bakeGeneration) error {
	if !validGeneration(g, d.cfg.CellID) {
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
	c.mu.Lock()
	defer c.mu.Unlock()
	var out []driver.RecoveredBake
	for id, g := range c.state.Generations {
		if err := d.verifyGeneration(ctx, g); err != nil {
			return nil, fmt.Errorf("dockergvisor: bake recovery: %w", err)
		}
		out = append(out, driver.RecoveredBake{ImageID: id, OrgID: g.Org, EnvironmentID: g.Environment, SHA: g.SHA, Current: c.state.Current[generationScope(g.Org, g.Environment)] == id})
	}
	return out, nil
}

// Prune first removes eligibility durably. Holds exclude generations being
// copied, tagged or used by a live machine, without blocking new publication.
func (d *Driver) pruneGenerations(ctx context.Context) error {
	c, err := d.catalogFor(ctx)
	if err != nil {
		return err
	}
	c.mu.Lock()
	old := c.state
	next := maps.Clone(old.Generations)
	retired := maps.Clone(old.Retired)
	changed := false
	for id, g := range next {
		if old.Current[generationScope(g.Org, g.Environment)] != id && c.holds[id] == 0 && !c.unconfirmed[id] {
			retired[id] = g
			delete(next, id)
			changed = true
		}
	}
	if changed {
		c.state.Generations, c.state.Retired = next, retired
		if err := c.saveLocked(); err != nil {
			if !errors.Is(err, errCatalogCommitUncertain) {
				c.state = old
			}
			c.mu.Unlock()
			return err
		}
	}
	var drop []bakeGeneration
	for id, g := range retired {
		if c.holds[id] == 0 {
			drop = append(drop, g)
		}
	}
	c.mu.Unlock()
	var errs []error
	for _, g := range drop {
		var generationErrors []error
		for _, image := range g.Images {
			generationErrors = append(generationErrors, d.d.RemoveImage(ctx, image))
		}
		labels := envLabels(g.Cell, g.Org, g.Environment)
		labels[labelBakeGeneration] = g.Nonce
		vols, listErr := d.d.Volumes(ctx, labels)
		generationErrors = append(generationErrors, listErr)
		var names []string
		for _, v := range vols {
			if g.Volumes[v.Labels[labelBakeVolume]] != v.Name {
				generationErrors = append(generationErrors, driver.ErrNotOwned)
				continue
			}
			names = append(names, v.Name)
		}
		if listErr == nil {
			generationErrors = append(generationErrors, d.d.VolumeRemove(ctx, names...))
		}
		if err := errors.Join(generationErrors...); err != nil {
			errs = append(errs, err)
			continue
		}
		c.mu.Lock()
		oldRetired := c.state.Retired
		c.state.Retired = maps.Clone(oldRetired)
		delete(c.state.Retired, g.ID)
		if err := c.saveLocked(); err != nil {
			if !errors.Is(err, errCatalogCommitUncertain) {
				c.state.Retired = oldRetired
			}
			errs = append(errs, err)
		}
		c.mu.Unlock()
	}
	return errors.Join(errs...)
}

// Stage records exact intended artifacts before any is created. A crash
// leaves cleanup work, never an eligible partial generation.
func (d *Driver) stageGeneration(ctx context.Context, g bakeGeneration) (func(), error) {
	g.Images = maps.Clone(g.Images)
	g.Volumes = maps.Clone(g.Volumes)
	c, err := d.catalogFor(ctx)
	if err != nil {
		return nil, err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if !validGeneration(g, d.cfg.CellID) || len(c.state.Generations)+len(c.state.Retired) >= maxBakeGenerations {
		return nil, errors.New("dockergvisor: bake catalog limit")
	}
	old := c.state.Retired
	c.state.Retired = maps.Clone(old)
	c.state.Retired[g.ID] = g
	if err := c.saveLocked(); err != nil {
		if !errors.Is(err, errCatalogCommitUncertain) {
			c.state.Retired = old
		}
		return nil, err
	}
	c.holds[g.ID]++
	var once sync.Once
	return func() {
		once.Do(func() {
			c.mu.Lock()
			if c.holds[g.ID] <= 1 {
				delete(c.holds, g.ID)
			} else {
				c.holds[g.ID]--
			}
			c.mu.Unlock()
		})
	}, nil
}

func (d *Driver) Close() error {
	d.catalogMu.Lock()
	defer d.catalogMu.Unlock()
	if d.catalog == nil {
		return nil
	}
	c := d.catalog
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return nil
	}
	c.closed = true
	return errors.Join(c.lock.Close(), c.root.Close())
}

func generationPin(id string) bool {
	return strings.HasPrefix(id, "kodus-bake/") && strings.Contains(id, ".")
}
