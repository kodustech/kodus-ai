package dockergvisor

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/bakecatalog"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
)

// A bake on docker-gvisor keeps what the clean setup claim's build sections
// produced (S-52: the agent checked the claim booted the default-branch
// head and never ran PR code). Each generation owns immutable image tags
// containing its nonce and the build fingerprint:
//
//	kodus-bake/<cell>/<org>/<env>:<generation>-<fingerprint>
//
// A claim reuses only its selected generation's matching fingerprints.
// Previous generations remain while machines/operations hold them and until
// the agent acknowledges publication of the new current pointer.

// bakeComponent is one path component of a Docker repository name.
var bakeComponent = regexp.MustCompile(`^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$`)

// bakeRepo is the repository of an environment's baked images in this
// Docker; false when an id cannot be part of a repository name, and the
// environment then bakes nothing and reuses nothing.
func bakeRepo(cell, org, env string) (string, bool) {
	for _, p := range []string{cell, org, env} {
		if len(p) > 64 || !bakeComponent.MatchString(p) {
			return "", false
		}
	}
	return "kodus-bake/" + cell + "/" + org + "/" + env, true
}

// bakeImageID is the id the agent and the protocol carry for a bake. The
// repository name holds three ids and is too long for the protocol's 128
// characters with UUIDs (136 with the commit), so the id names the
// repository by a hash: it stays unique per cell, org and environment, and
// the agent checks the org and environment of a baked id itself (S-52).
func bakeImageID(cell, org, env, sha string) string {
	sum := sha256.Sum256([]byte(cell + "/" + org + "/" + env))
	return "kodus-bake/" + hex.EncodeToString(sum[:12]) + "@" + sha
}

// ErrBakeSource: the bake names no machine whose output this driver holds.
var ErrBakeSource = errors.New("dockergvisor: no build output of that machine to bake")

// PinBakeSource takes the machine's images, and its volumes when the
// recipe keeps data in them, out of what its Destroy removes, for the bake
// that follows (driver.BakeSourcePinner).
func (d *Driver) PinBakeSource(ref driver.MachineRef) error {
	network := d.claimNetwork(ref.Tags[driver.TagClaim])
	d.mu.Lock()
	defer d.mu.Unlock()
	m := d.machines[ref.MachineID]
	if m == nil || m.output == nil {
		return fmt.Errorf("%w: %s never booted here, or is gone", ErrBakeSource, ref.MachineID)
	}
	if _, dup := d.pinned[ref.MachineID]; dup {
		return fmt.Errorf("%w: %s is already being baked", ErrBakeSource, ref.MachineID)
	}
	group := d.limitGroups[network]
	if d.cfg.ClaimLimits != nil && group.key == "" {
		return ErrResourceEnforcement
	}
	d.pinned[ref.MachineID] = &pinnedOutput{output: *m.output, group: group}
	m.output = nil
	return nil
}

// Bake stages and publishes a new immutable generation from spec.Source.
// Old artifacts retire only after the agent's acknowledgement and the last
// holder/operation release. The source pin is consumed either way: the
// machine's own names for the images, and its volumes once it is down,
// go with it.
func (d *Driver) Bake(ctx context.Context, spec driver.BakeSpec) (driver.ImageRef, error) {
	src := spec.Source.MachineID
	d.mu.Lock()
	pin, ok := d.pinned[src]
	d.mu.Unlock()
	if !ok {
		return driver.ImageRef{}, fmt.Errorf("%w: %q was not pinned", ErrBakeSource, src)
	}
	defer func() {
		cleanup := context.WithoutCancel(ctx)
		if err := errors.Join(d.removeImages(cleanup, pin.images), d.unpin(cleanup, src, pin), d.removeMachineCache(src)); err != nil {
			d.log().Warn("bake.cleanup.failed", "machine", src, "err", err)
		}
	}()

	switch {
	case spec.CellID != d.cfg.CellID:
		return driver.ImageRef{}, fmt.Errorf("%w: bake for cell %s", driver.ErrNotOwned, spec.CellID)
	// The machine must be the environment's: the agent checked the claim,
	// and the machine's own tags must say the same.
	case spec.Source.Tags[driver.TagOrg] != spec.OrgID || spec.Source.Tags[driver.TagEnv] != spec.EnvironmentID:
		return driver.ImageRef{}, fmt.Errorf("%w: machine %s is not of org %s environment %s", driver.ErrNotOwned, src, spec.OrgID, spec.EnvironmentID)
	}
	_, ok = bakeRepo(spec.CellID, spec.OrgID, spec.EnvironmentID)
	if !ok {
		return driver.ImageRef{}, fmt.Errorf("dockergvisor: cell, org or environment id cannot name an image repository")
	}

	if _, err := d.catalogFor(ctx); err != nil {
		return driver.ImageRef{}, err
	}
	if err := d.pruneGenerations(ctx); err != nil {
		return driver.ImageRef{}, err
	}
	var nonce [12]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return driver.ImageRef{}, err
	}
	g := bakecatalog.Generation{Cell: spec.CellID, Org: spec.OrgID, Environment: spec.EnvironmentID, SHA: spec.SHA, RecipeSHA: spec.RecipeSHA, Nonce: hex.EncodeToString(nonce[:]), Images: map[string]string{}, Volumes: map[string]string{}}
	g.ID = generationID(g.Cell, g.Org, g.Environment, g.SHA, g.Nonce)
	for _, image := range pin.images {
		if image.fp != "" {
			g.Images[image.fp] = generationImage(g, image.fp)
		}
	}
	for _, key := range pin.volumes {
		g.Volumes[key] = generationVolume(g, key)
	}
	if len(pin.images) > maxBakeArtifacts || len(pin.volumes) > maxBakeArtifacts || !validGeneration(g, d.cfg.CellID) {
		return driver.ImageRef{}, ErrBakeDataUnavailable
	}
	release, err := d.stageGeneration(ctx, g)
	if err != nil {
		return driver.ImageRef{}, err
	}
	defer func() {
		release()
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
		defer cancel()
		if err := d.pruneGenerations(cleanup); err != nil {
			d.log().Warn("bake.cleanup.pending", "alarm", true, "err", err)
		}
	}()
	for _, img := range pin.images {
		if img.fp == "" {
			d.log().Warn("bake.service.skipped", "env", spec.EnvironmentID, "service", img.service, "reason", "no_fingerprint")
			continue
		}
		name := generationImage(g, img.fp)
		if err := d.d.TagImage(ctx, img.tag, name); err != nil {
			return driver.ImageRef{}, fmt.Errorf("dockergvisor: bake %s: %w", img.service, err)
		}
	}
	// The build cache: only a setup machine's builds wrote one.
	caches := 0
	for _, img := range pin.images {
		if img.cache == "" {
			continue
		}
		if err := d.promoteCache(img.cache, spec.OrgID, spec.EnvironmentID, img.service); err != nil {
			d.log().Warn("bake.cache.failed", "env", spec.EnvironmentID, "service", img.service, "err", err)
			continue
		}
		caches++
	}
	volumes, err := d.bakeData(ctx, spec, pin.volumes, &g)
	if err != nil {
		return driver.ImageRef{}, err
	}
	if err := d.publishGeneration(ctx, g); err != nil {
		return driver.ImageRef{}, err
	}
	if err := d.pruneGenerations(ctx); err != nil {
		d.log().Warn("bake.prune.failed", "env", spec.EnvironmentID, "err", err)
	}
	names := make([]string, 0, len(g.Images))
	for _, name := range g.Images {
		names = append(names, name)
	}
	sort.Strings(names)
	d.log().Info("bake.named", "env", spec.EnvironmentID, "sha", spec.SHA, "images", len(names), "skipped", len(pin.images)-len(names), "volumes", volumes, "caches", caches)
	return driver.ImageRef{ImageID: g.ID, DriverRef: strings.Join(names, ",")}, nil
}
