package dockergvisor

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"sort"
	"strings"

	"go.yaml.in/yaml/v3"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/bakecatalog"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/recipe"
)

// A bake also keeps the setup's data when the recipe keeps it in named
// volumes (data.reset: snapshot): each project volume is copied, with the
// project down, into a bake volume of the environment. A later claim of the
// environment starts from copies of them instead of empty volumes, so it
// boots on the default branch's migrated and seeded data. The copies run
// under Runtime with no network: the data is the org's app's.

const defaultHelperImage = "busybox:1.36"

// Labels of a bake volume: which project volume it stands for, and the
// commit it was baked at. kodus.cell, kodus.org and kodus.env say whose.
const (
	labelBakeVolume = "kodus.bake-volume"
	labelBakeSHA    = "kodus.bake-sha"
)

// dataKeys are the project's named volume keys when the recipe keeps its
// data in them, none otherwise. The recipe in the checkout is the product's
// (the agent wrote it there), never the PR's.
func dataKeys(composeFile []byte, projectDir string) ([]string, error) {
	rec, err := recipe.Load(projectDir)
	if err != nil {
		return nil, err
	}
	if rec == nil || rec.ResetStrategy() != recipe.ResetSnapshot {
		return nil, nil
	}
	var doc struct {
		Volumes map[string]any `yaml:"volumes"`
	}
	if err := yaml.Unmarshal(composeFile, &doc); err != nil {
		return nil, err
	}
	keys := make([]string, 0, len(doc.Volumes))
	for k := range doc.Volumes {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys, nil
}

// projectVolume is how compose names a project's volume.
func projectVolume(machine, key string) string { return machine + "_" + key }

// bakeVolume names an environment's baked copy of a volume at a commit.
func bakeVolume(cell, org, env, key, sha string) string {
	h := sha256.New()
	for _, p := range []string{cell, org, env, key, sha} {
		fmt.Fprintf(h, "%d:%s", len(p), p)
	}
	return "kodus-bake-" + hex.EncodeToString(h.Sum(nil))[:32]
}

func envLabels(cell, org, env string) map[string]string {
	return toLabels(map[string]string{driver.TagCell: cell, driver.TagOrg: org, driver.TagEnv: env})
}

// ErrBakeDataUnavailable prevents a claim from silently replacing its pinned
// seed with another generation or with an empty database.
var ErrBakeDataUnavailable = errors.New("dockergvisor: pinned bake data unavailable")

// pinnedBakeSHA validates this scope's source identity. Concrete generation
// membership and exact artifact identity additionally require the catalog.
func (d *Driver) pinnedBakeSHA(ref driver.MachineRef) (string, error) {
	if !strings.HasPrefix(ref.ImageID, "kodus-bake/") {
		return "", nil
	}
	_, sha, ok := strings.Cut(ref.ImageID, "@")
	if source, nonce, hasGeneration := strings.Cut(sha, "."); hasGeneration {
		if !bakecatalog.IsHex(nonce, 24) {
			return "", ErrBakeDataUnavailable
		}
		sha = source
	}
	if !ok || len(sha) != 40 {
		return "", ErrBakeDataUnavailable
	}
	for _, c := range sha {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return "", ErrBakeDataUnavailable
		}
	}
	org, env := ref.Tags[driver.TagOrg], ref.Tags[driver.TagEnv]
	base := strings.Split(ref.ImageID, ".")[0]
	if _, ok := bakeRepo(d.cfg.CellID, org, env); !ok || base != bakeImageID(d.cfg.CellID, org, env, sha) {
		return "", ErrBakeDataUnavailable
	}
	return sha, nil
}

// bakedVolumes selects only the concrete pin's seed, never implicit latest.
func (d *Driver) bakedVolumes(ctx context.Context, ref driver.MachineRef) (map[string]string, error) {
	if generationPin(ref.ImageID) {
		g, release, err := d.holdGeneration(ctx, ref)
		if err != nil {
			return nil, err
		}
		defer release()
		if err := d.verifyGeneration(ctx, g); err != nil {
			return nil, err
		}
		return g.Volumes, nil
	}
	sha, err := d.pinnedBakeSHA(ref)
	if err != nil || sha == "" {
		return nil, err
	}
	org, env := ref.Tags[driver.TagOrg], ref.Tags[driver.TagEnv]
	l := envLabels(d.cfg.CellID, org, env)
	l[labelBakeVolume] = ""
	vols, err := d.d.Volumes(ctx, l)
	if err != nil {
		return nil, err
	}
	out := map[string]string{}
	for _, v := range vols {
		if v.Labels[labelBakeSHA] != sha {
			continue
		}
		for k, want := range envLabels(d.cfg.CellID, org, env) {
			if v.Labels[k] != want {
				return nil, driver.ErrNotOwned
			}
		}
		key := v.Labels[labelBakeVolume]
		if key == "" || v.Name != bakeVolume(d.cfg.CellID, org, env, key, sha) || out[key] != "" {
			return nil, ErrBakeDataUnavailable
		}
		out[key] = v.Name
	}
	if len(vols) > 0 && len(out) == 0 {
		return nil, ErrBakeDataUnavailable
	}
	return out, nil
}

// restoreData gives the claim's project volumes the environment's baked
// data before the project comes up. A failed copy removes partial data and
// stops the boot; it never silently falls back to an empty database.
func (d *Driver) restoreData(ctx context.Context, ref driver.MachineRef, keys []string) (int, error) {
	if len(keys) == 0 {
		return 0, nil
	}
	d.mu.Lock()
	m := d.machines[ref.MachineID]
	setup := m != nil && m.setup
	d.mu.Unlock()
	if setup {
		return 0, nil // a clean setup must migrate and seed from scratch
	}
	sha, err := d.pinnedBakeSHA(ref)
	if err != nil || sha == "" {
		return 0, err
	}
	parent, err := d.parentFor(ctx, ref)
	if err != nil {
		return 0, err
	}
	// A volume the project already has keeps what it holds: only a first
	// boot, or one after a reset took the volumes down, starts from the bake.
	existing, err := d.d.Volumes(ctx, map[string]string{"com.docker.compose.project": ref.MachineID})
	if err != nil {
		return 0, err
	}
	has := map[string]bool{}
	for _, v := range existing {
		has[v.Name] = true
	}
	var missing []string
	for _, k := range keys {
		if !has[projectVolume(ref.MachineID, k)] {
			missing = append(missing, k)
		}
	}
	if len(missing) == 0 {
		return 0, nil
	}
	var generation string
	if generationPin(ref.ImageID) {
		g, release, err := d.holdGeneration(ctx, ref)
		if err != nil {
			return 0, err
		}
		defer release()
		generation = g.Nonce
	}
	baked, err := d.bakedVolumes(ctx, ref)
	if err != nil {
		return 0, err
	}
	// Validate the complete selection before writing any project volume.
	for _, k := range missing {
		if baked[k] == "" {
			return 0, ErrBakeDataUnavailable
		}
	}
	var made []string
	for _, k := range missing {
		from := baked[k]
		to := projectVolume(ref.MachineID, k)
		labels := toLabels(map[string]string{
			driver.TagCell: d.cfg.CellID, driver.TagOrg: ref.Tags[driver.TagOrg], driver.TagClaim: ref.Tags[driver.TagClaim],
			driver.TagHardExpires: ref.Tags[driver.TagHardExpires],
		})
		// Compose's own labels: the volume is the project's, and down -v takes it.
		labels["com.docker.compose.project"], labels["com.docker.compose.volume"] = ref.MachineID, k
		if err := d.copyVolumeGuarded(ctx, from, to, labels, parent, generation, ""); err != nil {
			made = append(made, to)
			d.log().Warn("data.restore.failed", "machine", ref.MachineID, "volume", k, "err", err)
			cleanup, cancel := cleanupContext(ctx)
			defer cancel()
			cleanupErr := d.d.VolumeRemove(cleanup, made...)
			return 0, errors.Join(err, cleanupErr)
		}
		made = append(made, to)
	}
	return len(made), nil
}

// bakeData copies the stopped setup's volumes into its staged generation.
// Publication/retirement is separate and cannot prune an in-flight source.
func (d *Driver) bakeData(ctx context.Context, spec driver.BakeSpec, keys []string, generation *bakecatalog.Generation) (int, error) {
	machine := spec.Source.MachineID
	parent := ""
	if d.cfg.ClaimLimits != nil {
		hard := driver.ParseExpiry(spec.Source.Tags, driver.TagHardExpires)
		if hard.IsZero() {
			return 0, ErrResourceEnforcement
		}
		var cancel context.CancelFunc
		ctx, cancel = context.WithDeadline(ctx, hard)
		defer cancel()
		d.mu.Lock()
		pin := d.pinned[machine]
		d.mu.Unlock()
		if pin == nil || pin.group.key == "" {
			return 0, ErrResourceEnforcement
		}
		g := pin.group
		if err := d.ensureGroup(&g); err != nil {
			return 0, err
		}
		parent = g.parent
	}
	// Stopped, or already down by the release: either way nothing writes.
	if err := d.d.ComposeStop(ctx, machine); err != nil {
		d.log().Info("bake.data.stop", "machine", machine, "err", err)
	}
	for _, k := range keys {
		name := generationVolume(*generation, k)
		labels := envLabels(spec.CellID, spec.OrgID, spec.EnvironmentID)
		labels[labelBakeVolume], labels[labelBakeSHA] = k, spec.SHA
		labels[labelBakeGeneration] = generation.Nonce
		labels["kodus.bake-source"] = machine
		if err := d.copyVolumeGuarded(ctx, projectVolume(machine, k), name, labels, parent, "", generation.Nonce); err != nil {
			return 0, fmt.Errorf("dockergvisor: bake volume %s: %w", k, err)
		}
	}
	return len(generation.Volumes), nil
}

// pinnedOutput is a machine's output a bake took, and whether its release
// already brought the project down (its volumes then wait for the bake).
type pinnedOutput struct {
	group limitGroup
	output
	down bool
}

// downForBake records that the machine's project is down with its volumes
// kept for the bake; when the bake is already done, they go now.
func (d *Driver) downForBake(ctx context.Context, machine string, pin *pinnedOutput) error {
	d.mu.Lock()
	if d.pinned[machine] == pin {
		pin.down = true
		d.mu.Unlock()
		return nil
	}
	d.mu.Unlock()
	return d.removeVolumes(ctx, machine, pin.volumes)
}

// unpin ends the bake's hold on the machine; when its release already
// brought the project down, its volumes go now.
func (d *Driver) unpin(ctx context.Context, machine string, pin *pinnedOutput) error {
	d.mu.Lock()
	down := pin.down
	if d.pinned[machine] == pin {
		delete(d.pinned, machine)
	}
	d.mu.Unlock()
	if !down {
		return nil
	}
	return errors.Join(d.removeVolumes(ctx, machine, pin.volumes), d.removeLimitGroup(ctx, pin.group))
}

func (d *Driver) removeVolumes(ctx context.Context, machine string, keys []string) error {
	names := make([]string, 0, len(keys))
	for _, k := range keys {
		names = append(names, projectVolume(machine, k))
	}
	if err := d.d.VolumeRemove(ctx, names...); err != nil {
		return errors.Join(fmt.Errorf("dockergvisor: volumes of %s", machine), err)
	}
	return nil
}

// removeProjectVolumes removes every volume of the machine's project: down
// -v takes those the compose file names, and a pool machine was given the
// environment's baked volumes before any compose file was known.
func (d *Driver) removeProjectVolumes(ctx context.Context, machine string) error {
	vols, err := d.d.Volumes(ctx, map[string]string{"com.docker.compose.project": machine})
	if err != nil || len(vols) == 0 {
		return err
	}
	names := make([]string, 0, len(vols))
	for _, v := range vols {
		names = append(names, v.Name)
	}
	return d.d.VolumeRemove(ctx, names...)
}

func (d *Driver) copyVolume(ctx context.Context, from, to string, labels map[string]string, parent string) error {
	if d.cfg.ClaimLimits == nil {
		return d.d.CopyVolumeIn(ctx, d.cfg.Runtime, d.cfg.HelperImage, from, to, labels)
	}
	if parent == "" {
		return ErrResourceEnforcement
	}
	return d.d.CopyVolumeBound(ctx, d.cfg.Runtime, d.cfg.HelperImage, from, to, labels, parent)
}

func (d *Driver) copyVolumeGuarded(ctx context.Context, from, to string, labels map[string]string, parent, expected, write string) error {
	if expected == "" && write == "" {
		return d.copyVolume(ctx, from, to, labels, parent)
	}
	if d.cfg.ClaimLimits != nil && parent == "" {
		return ErrResourceEnforcement
	}
	return d.d.CopyVolumeGeneration(ctx, d.cfg.Runtime, d.cfg.HelperImage, from, to, labels, parent, expected, write)
}
