package localdocker

import (
	"context"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
)

// PrepareClaim has no network to make (compose gives each project its own
// networks); it remembers the claim's expose list for the boot.
func (d *Driver) PrepareClaim(_ context.Context, spec driver.ClaimNetworkSpec) (driver.ClaimNetwork, error) {
	if err := driver.ValidateClaimID(spec.ClaimID); err != nil {
		return driver.ClaimNetwork{}, err
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	d.st.Claims[spec.ClaimID] = &claimState{Expose: spec.Expose}
	if err := d.saveLocked(); err != nil {
		return driver.ClaimNetwork{}, err
	}
	g := claimGroup(spec.ClaimID)
	return driver.ClaimNetwork{WorkloadGroupID: g, ObserverGroupID: g}, nil
}

func (d *Driver) ReleaseClaim(_ context.Context, n driver.ClaimNetwork) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	for id := range d.st.Claims {
		if claimGroup(id) == n.WorkloadGroupID {
			delete(d.st.Claims, id)
		}
	}
	return d.saveLocked()
}
