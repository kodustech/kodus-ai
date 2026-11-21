package dockercli

import (
	"context"
	"encoding/json"
	"errors"
)

// maxImageConfigBytes bounds what ImageConfig reads of an image's config:
// the image is the PR's own build.
const maxImageConfigBytes = 256 << 10

// ImageConfig is how an image runs: its Config.Env, Entrypoint and Cmd
// (https://docs.docker.com/reference/cli/docker/image/inspect/).
type ImageConfig struct {
	Env, Entrypoint, Cmd []string
}

// ImageConfig reads a local image's config. It never pulls or starts it.
func (c CLI) ImageConfig(ctx context.Context, ref string) (ImageConfig, error) {
	out, err := c.run(ctx, nil, "image", "inspect", "--format", "{{json .Config}}", ref)
	if err != nil {
		return ImageConfig{}, err
	}
	return parseImageConfig(out)
}

func parseImageConfig(raw []byte) (ImageConfig, error) {
	if len(raw) > maxImageConfigBytes {
		return ImageConfig{}, errors.New("dockercli: image config exceeds bound")
	}
	var cfg ImageConfig
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return ImageConfig{}, errors.New("dockercli: invalid image config")
	}
	return cfg, nil
}
