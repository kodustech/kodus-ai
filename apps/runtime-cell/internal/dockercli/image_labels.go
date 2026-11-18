package dockercli

import (
	"context"
	"encoding/json"
	"errors"
)

// ImageLabels reads only cached image metadata. It never pulls or starts it.
func (c CLI) ImageLabels(ctx context.Context, ref string) (map[string]string, error) {
	out, err := c.run(ctx, nil, "image", "inspect", "--format", "{{json .Config.Labels}}", ref)
	if err != nil {
		return nil, err
	}
	if len(out) > 65536 {
		return nil, errors.New("dockercli: image labels exceed bound")
	}
	var labels map[string]string
	if err := json.Unmarshal(out, &labels); err != nil {
		return nil, errors.New("dockercli: invalid image label metadata")
	}
	return labels, nil
}
