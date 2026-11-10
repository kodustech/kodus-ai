package dockergvisor

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"sort"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockercli"
)

// A pool machine on docker-gvisor is what a claim would make before its
// project comes up: a network of its own wired to the cell's egress, a
// holder, and the environment's baked data already copied into the
// project's volumes. All of it comes from the bake, none from a claim
// (S-52). A claim that adopts it boots its project there; the images are
// the bake's, so its Up only restarts what the PR changed.

// PoolCreate makes one ready machine for the environment.
func (d *Driver) PoolCreate(ctx context.Context, spec driver.PoolSpec) (driver.PoolMachine, error) {
	if spec.CellID != d.cfg.CellID {
		return driver.PoolMachine{}, fmt.Errorf("%w: pool spec for cell %s", driver.ErrNotOwned, spec.CellID)
	}
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return driver.PoolMachine{}, err
	}
	id := "pool-" + hex.EncodeToString(b[:])
	net, err := d.PrepareClaim(ctx, driver.ClaimNetworkSpec{CellID: spec.CellID, OrgID: spec.OrgID, ClaimID: id})
	if err != nil {
		return driver.PoolMachine{}, err
	}
	ref, err := d.Create(ctx, driver.MachineSpec{
		CellID: spec.CellID, EnvironmentID: spec.EnvironmentID, Role: driver.RolePool, OrgID: spec.OrgID, ClaimID: id,
		ImageID: spec.ImageID, ImageRef: spec.ImageID, Size: spec.Size, ClaimSize: spec.ClaimSize, ClaimGroupID: net.WorkloadGroupID, KMSKeyRef: spec.KMSKeyRef,
		ExpiresAt: spec.ExpiresAt, HardExpiresAt: spec.HardExpiresAt,
	})
	if err != nil {
		return driver.PoolMachine{}, errors.Join(err, d.ReleaseClaim(context.WithoutCancel(ctx), net))
	}
	d.machineOutput(ref.MachineID)
	undo := func(err error) (driver.PoolMachine, error) {
		cleanup := context.WithoutCancel(ctx)
		return driver.PoolMachine{}, errors.Join(err, d.Destroy(cleanup, ref), d.ReleaseClaim(cleanup, net))
	}
	baked, err := d.bakedVolumes(ctx, ref)
	if err != nil {
		return undo(err)
	}
	keys := make([]string, 0, len(baked))
	for k := range baked {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	restored, err := d.restoreData(ctx, ref, keys)
	if err != nil {
		return undo(err)
	}
	d.log().Info("pool.created", "machine", ref.MachineID, "env", spec.EnvironmentID, "volumes", restored)
	return driver.PoolMachine{Network: net, Workload: ref, OrgID: spec.OrgID, EnvironmentID: spec.EnvironmentID, ImageID: spec.ImageID, ClaimSize: spec.ClaimSize, HardExpiresAt: spec.HardExpiresAt}, nil
}

// Adopt binds the pool machine's network to claimID, after checking that
// both the network and the machine are still this cell's.
func (d *Driver) Adopt(ctx context.Context, p driver.PoolMachine, claimID string) error {
	if err := driver.ValidateClaimID(claimID); err != nil {
		return err
	}
	labels, err := d.d.NetworkLabels(ctx, p.Network.WorkloadGroupID)
	if err != nil {
		return err
	}
	if labels == nil || labels[dockercli.LabelFromTag(driver.TagCell)] != d.cfg.CellID || labels[dockercli.LabelFromTag(driver.TagOrg)] != p.OrgID {
		return fmt.Errorf("%w: network %s", driver.ErrNotOwned, p.Network.WorkloadGroupID)
	}
	exists, err := d.owned(ctx, p.Workload.MachineID)
	if err != nil {
		return err
	}
	if !exists {
		return fmt.Errorf("dockergvisor: pool machine %s is gone", p.Workload.MachineID)
	}
	if d.cfg.ClaimLimits != nil {
		if p.Workload.Tags[driver.TagOrg] != p.OrgID {
			return errors.Join(ErrResourceEnforcement, driver.ErrNotOwned)
		}
		if _, err := d.groupFromHolder(ctx, p.Workload); err != nil {
			return err
		}
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	d.adopted[claimID] = p.Network.WorkloadGroupID
	return nil
}

// claimNetwork is the network a claim's machines join: its own, or the
// pool machine's it adopted.
func (d *Driver) claimNetwork(claimID string) string {
	d.mu.Lock()
	defer d.mu.Unlock()
	if n, ok := d.adopted[claimID]; ok {
		return n
	}
	return networkName(claimID)
}

// forgetAdoptions drops the claims bound to a network being removed.
func (d *Driver) forgetAdoptions(network string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	for c, n := range d.adopted {
		if n == network {
			delete(d.adopted, c)
		}
	}
}
