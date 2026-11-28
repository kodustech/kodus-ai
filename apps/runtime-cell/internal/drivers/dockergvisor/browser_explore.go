package dockergvisor

import (
	"context"
	"errors"
)

// CheckBrowserExploreImage refuses legacy images before hello advertises the
// optional capability. Labels belong to the trusted digest-pinned image.
func (d *Driver) CheckBrowserExploreImage(ctx context.Context, ref string) error {
	if err := CheckBrowserImage(ref); err != nil {
		return err
	}
	labels, err := d.d.ImageLabels(ctx, ref)
	if err != nil {
		return errors.New("dockergvisor: browser exploration image unavailable")
	}
	if labels["io.kodus.browser-explore.protocol"] != "1" || labels["io.kodus.agent-browser.version"] != "0.41.2" {
		return errors.New("dockergvisor: browser exploration needs the versioned native runner image")
	}
	return nil
}
