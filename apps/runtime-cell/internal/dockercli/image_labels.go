package dockercli

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
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

// ImageID is a local image's content id (sha256:<64 hex>), which names its
// bytes whatever tag or digest reference pointed at it. It never pulls.
func (c CLI) ImageID(ctx context.Context, ref string) (string, error) {
	out, err := c.run(ctx, nil, "image", "inspect", "--format", "{{.Id}}", ref)
	if err != nil {
		return "", err
	}
	id := strings.TrimSpace(string(out))
	if !imageID.MatchString(id) {
		return "", errors.New("dockercli: image id is not sha256:<64 hex>")
	}
	return id, nil
}

var imageID = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)
