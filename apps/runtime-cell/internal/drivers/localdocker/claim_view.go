package localdocker

import (
	"fmt"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/observer"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// Manifest is claim.ready's manifest for the claim's workload: the compose
// services, the exposed ports the last boot published and the seed's
// fingerprint. The cell agent sends it in place of the one it builds from
// claim.acquire.
func (d *Driver) Manifest(claimID string) (protocol.Manifest, bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	m := d.st.Machines[machineName(claimID, driver.RoleWorkload)]
	if m == nil || m.Dir == "" {
		return protocol.Manifest{}, false
	}
	man := protocol.Manifest{Services: []protocol.ManifestService{}, Expose: []protocol.Expose{}, ImageID: m.Tags[tagImage], SeedSha: m.SeedSha}
	for _, s := range m.Services {
		man.Services = append(man.Services, protocol.ManifestService{Name: s, Health: protocol.ServiceHealthOk})
	}
	for _, e := range m.Expose {
		man.Expose = append(man.Expose, protocol.Expose{Service: e.Service, Port: int64(e.Port), Kind: protocol.ExposeKind(e.Kind)})
	}
	return man, true
}

// Targets is every port the claim's workload published, each pointed at
// the host port Docker picked, so the in-process observer reaches each
// exposed service by its name. A requested target that was not published
// is an error.
func (d *Driver) Targets(claimID string, in []observer.Target) ([]observer.Target, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	m := d.st.Machines[machineName(claimID, driver.RoleWorkload)]
	if m == nil {
		return nil, fmt.Errorf("localdocker: no workload for claim %s", claimID)
	}
	notPublished := func(service string, port int) error {
		return fmt.Errorf("localdocker: %s/%d is not published for claim %s", service, port, claimID)
	}
	out := make([]observer.Target, 0, len(m.Expose))
	for _, e := range m.Expose {
		addr, ok := m.Ports[exposeKey(e.Service, e.Port)]
		if !ok {
			return nil, notPublished(e.Service, e.Port)
		}
		out = append(out, observer.Target{Service: e.Service, Port: e.Port, Kind: e.Kind, Address: addr})
	}
	for _, t := range in {
		if _, ok := m.Ports[exposeKey(t.Service, t.Port)]; !ok {
			return nil, notPublished(t.Service, t.Port)
		}
	}
	return out, nil
}
