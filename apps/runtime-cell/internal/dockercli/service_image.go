package dockercli

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
)

// PullServiceImage makes ref, the image of a service the cell did not build
// (compose/sandbox.PullImages), present on this Docker, within maxBytes.
// compose never pulls (the sandbox gives every service pull_policy never),
// so this is the one pull of a compose file's image, and it is anonymous:
// docker runs with a config directory of its own that holds no login, so a
// compose file never borrows the cell's registry credentials (DOCKER_CONFIG).
// An image past maxBytes is driver.ErrImageTooLarge; one this call pulled
// is removed again.
//
// An image already here is used without a pull only as a registry served it
// (N10): a digest names its content, whoever pulled it; a tag must carry a
// registry digest of its own repository, else it was built or tagged on
// this host and is refused. fresh is an image the cell may have pulled with
// its own login (one of its own images): it is pulled anonymously even when
// here, and refused when no registry serves it so.
func (c CLI) PullServiceImage(ctx context.Context, ref string, maxBytes int64, fresh bool) error {
	img, err := c.serviceImage(ctx, ref)
	missing := NoSuchImage(err)
	if missing || err == nil && fresh {
		if err := c.pullAnonymous(ctx, ref); err != nil {
			return err
		}
		img, err = c.serviceImage(ctx, ref)
	}
	if err != nil {
		return err
	}
	if !missing && !fresh && !strings.Contains(ref, "@") && !img.servedAs(ref) {
		return fmt.Errorf("dockercli: %s is on this host with no registry digest of its repository (built or tagged here, not pulled): a service runs an image only as a registry serves it; pin it by digest", ref)
	}
	if maxBytes > 0 && img.size > maxBytes {
		if missing {
			_ = c.RemoveImage(context.WithoutCancel(ctx), ref)
		}
		return fmt.Errorf("%w: %s is %d bytes, over %d", driver.ErrImageTooLarge, ref, img.size, maxBytes)
	}
	return nil
}

// localImage is what the host says of an image: its size, and the registry
// digests (repo@sha256:...) it was pulled as.
type localImage struct {
	size        int64
	repoDigests []string
}

// servedAs says a registry served the image under ref's repository.
func (i localImage) servedAs(ref string) bool {
	repo := ImageRepository(ref)
	for _, rd := range i.repoDigests {
		name, digest, ok := strings.Cut(rd, "@")
		if ok && ManifestDigest.MatchString(digest) && ImageRepository(name) == repo {
			return true
		}
	}
	return false
}

// ImageRepository is ref's repository without its tag or digest, in the
// full form Docker reads it as ("postgres:16" is
// "docker.io/library/postgres"), so two spellings of one compare equal.
func ImageRepository(ref string) string {
	name, _, _ := strings.Cut(ref, "@")
	if i := strings.LastIndex(name, ":"); i > strings.LastIndex(name, "/") {
		name = name[:i]
	}
	domain, path := "docker.io", name
	if first, rest, ok := strings.Cut(name, "/"); ok && (strings.ContainsAny(first, ".:") || first == "localhost" || strings.ToLower(first) != first) {
		domain, path = strings.ToLower(first), rest
	}
	switch domain {
	case "index.docker.io", "registry-1.docker.io":
		domain = "docker.io"
	}
	if domain == "docker.io" && !strings.Contains(path, "/") {
		path = "library/" + path
	}
	return domain + "/" + path
}

// pullAnonymous pulls ref with an empty docker config: no credential, no
// credential helper.
func (c CLI) pullAnonymous(ctx context.Context, ref string) error {
	dir, err := os.MkdirTemp("", "kodus-pull-config-*")
	if err != nil {
		return err
	}
	defer func() { _ = os.RemoveAll(dir) }()
	if _, err := c.run(ctx, nil, "--config", dir, "pull", "-q", "--", ref); err != nil {
		return fmt.Errorf("dockercli: pull %s: %w", ref, err)
	}
	return nil
}

func (c CLI) serviceImage(ctx context.Context, ref string) (localImage, error) {
	out, err := c.run(ctx, nil, "image", "inspect", "--format", "{{.Size}} {{json .RepoDigests}}", "--", ref)
	if err != nil {
		return localImage{}, err
	}
	sizeText, digests, _ := strings.Cut(strings.TrimSpace(string(out)), " ")
	var img localImage
	if img.size, err = strconv.ParseInt(sizeText, 10, 64); err != nil {
		return localImage{}, fmt.Errorf("dockercli: size of %s: %w", ref, err)
	}
	if digests != "" && digests != "null" {
		if err := json.Unmarshal([]byte(digests), &img.repoDigests); err != nil {
			return localImage{}, fmt.Errorf("dockercli: registry digests of %s: %w", ref, err)
		}
	}
	return img, nil
}
