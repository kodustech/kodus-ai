package dockercli

import (
	"archive/tar"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"strings"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
)

// A builder's tarball is written by the build, and a build's RUN steps are
// the pull request's code: what they leave in /out is untrusted. docker load
// names every image a tarball lists, so a tarball that listed another name
// (postgres:16, another claim's kodus-build/... tag) would replace that
// image on the host for everyone who runs it next. LoadImage reads the
// tarball's own index first and loads only a tarball that is exactly the one
// image the cell asked the builder for.

const (
	// DefaultMaxImageBytes bounds a build's tarball when the caller sets none.
	DefaultMaxImageBytes int64 = 32 << 30
	// DefaultMaxImageEntries bounds its entries: an image is a few blobs per
	// layer, and a layer count past a few hundred no storage driver mounts.
	DefaultMaxImageEntries = 4096
	// maxIndexBytes bounds manifest.json, index.json and repositories.
	maxIndexBytes = 1 << 20
)

// ImageLoad is one built image to load: the tarball the builder wrote and
// the only name it may carry.
type ImageLoad struct {
	Tarball string
	// Tag is the name the cell gave the build (kodus-build/<machine>-<service>:claim).
	Tag string
	// MaxBytes and MaxEntries bound the tarball; zero: the defaults.
	MaxBytes   int64
	MaxEntries int
}

// LoadImage checks the builder's tarball (CheckImageTarball) and loads it
// into this Docker. Both failures are driver.ErrImageLoad, a tarball past
// MaxBytes driver.ErrImageTooLarge.
func (c CLI) LoadImage(ctx context.Context, l ImageLoad) error {
	if err := CheckImageTarball(l); err != nil {
		return err
	}
	if _, err := c.run(ctx, nil, "load", "-q", "-i", l.Tarball); err != nil {
		return fmt.Errorf("%w: %w", driver.ErrImageLoad, err)
	}
	return nil
}

// CheckImageTarball refuses a tarball that is not exactly one image named
// l.Tag: one manifest.json entry whose RepoTags are that name, at most one
// manifest in index.json and no other name in its annotations, a
// repositories file (when there is one) naming that image alone. It also
// refuses links, devices and names outside the archive, and bounds the size
// and the entry count. It reads the file once and never follows a link.
func CheckImageTarball(l ImageLoad) error {
	maxBytes, maxEntries := l.MaxBytes, l.MaxEntries
	if maxBytes <= 0 {
		maxBytes = DefaultMaxImageBytes
	}
	if maxEntries <= 0 {
		maxEntries = DefaultMaxImageEntries
	}
	want, err := parseRef(l.Tag)
	if err != nil {
		return fmt.Errorf("%w: expected tag %q: %w", driver.ErrImageLoad, l.Tag, err)
	}
	refuse := func(format string, a ...any) error {
		return fmt.Errorf("%w: image tarball: %s", driver.ErrImageLoad, fmt.Sprintf(format, a...))
	}
	info, err := os.Lstat(l.Tarball)
	if err != nil {
		return fmt.Errorf("%w: image tarball: %w", driver.ErrImageLoad, err)
	}
	if !info.Mode().IsRegular() {
		return refuse("not a regular file (%s)", info.Mode().Type())
	}
	if info.Size() > maxBytes {
		return fmt.Errorf("%w: the image tarball is %d bytes, over %d", driver.ErrImageTooLarge, info.Size(), maxBytes)
	}
	f, err := os.Open(l.Tarball)
	if err != nil {
		return fmt.Errorf("%w: image tarball: %w", driver.ErrImageLoad, err)
	}
	defer func() { _ = f.Close() }()
	if opened, err := f.Stat(); err != nil || !os.SameFile(info, opened) {
		return refuse("changed while it was opened")
	}
	var manifest, index, repositories []byte
	seen := map[string]bool{}
	var total int64
	tr := tar.NewReader(io.LimitReader(f, maxBytes+1))
	for entries := 0; ; entries++ {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return refuse("%v", err)
		}
		if entries >= maxEntries {
			return refuse("more than %d entries", maxEntries)
		}
		name := strings.TrimPrefix(h.Name, "./")
		clean := path.Clean(name)
		if name == "" || strings.HasPrefix(name, "/") || clean == ".." || strings.HasPrefix(clean, "../") || strings.ContainsRune(name, 0) {
			return refuse("entry %q is outside the archive", h.Name)
		}
		switch h.Typeflag {
		case tar.TypeDir:
			continue
		case tar.TypeReg:
		default:
			return refuse("entry %q is not a file or a directory", h.Name)
		}
		if total += h.Size; h.Size < 0 || total > maxBytes {
			return fmt.Errorf("%w: the image tarball holds more than %d bytes", driver.ErrImageTooLarge, maxBytes)
		}
		var into *[]byte
		switch clean {
		case "manifest.json":
			into = &manifest
		case "index.json":
			into = &index
		case "repositories":
			into = &repositories
		default:
			continue
		}
		if seen[clean] {
			return refuse("two %s entries", clean)
		}
		seen[clean] = true
		if h.Size > maxIndexBytes {
			return refuse("%s is larger than %d bytes", clean, maxIndexBytes)
		}
		if *into, err = io.ReadAll(io.LimitReader(tr, maxIndexBytes)); err != nil {
			return refuse("%s: %v", clean, err)
		}
	}
	if manifest == nil {
		return refuse("no manifest.json")
	}
	if err := checkManifest(manifest, want); err != nil {
		return refuse("manifest.json: %v", err)
	}
	if index != nil {
		if err := checkIndex(index, want); err != nil {
			return refuse("index.json: %v", err)
		}
	}
	if repositories != nil {
		if err := checkRepositories(repositories, want); err != nil {
			return refuse("repositories: %v", err)
		}
	}
	return nil
}

// checkManifest: docker save's manifest, one image whose only name is want.
func checkManifest(b []byte, want ref) error {
	var m []struct {
		RepoTags []string `json:"RepoTags"`
	}
	if err := json.Unmarshal(b, &m); err != nil {
		return err
	}
	if len(m) != 1 {
		return fmt.Errorf("%d images, not one", len(m))
	}
	if len(m[0].RepoTags) != 1 {
		return fmt.Errorf("RepoTags %q, not the one name %s", m[0].RepoTags, want)
	}
	got, err := parseRef(m[0].RepoTags[0])
	if err != nil || got != want {
		return fmt.Errorf("names %q, not %s", m[0].RepoTags[0], want)
	}
	return nil
}

// Annotations an OCI index names its images with: the containerd image
// store loads under the first, and may fall back to the second.
const (
	annotationImageName = "io.containerd.image.name"
	annotationRefName   = "org.opencontainers.image.ref.name"
)

// checkIndex: the OCI index lists one manifest, named want or not named.
func checkIndex(b []byte, want ref) error {
	var idx struct {
		Manifests []struct {
			Annotations map[string]string `json:"annotations"`
		} `json:"manifests"`
	}
	if err := json.Unmarshal(b, &idx); err != nil {
		return err
	}
	if len(idx.Manifests) != 1 {
		return fmt.Errorf("%d manifests, not one", len(idx.Manifests))
	}
	a := idx.Manifests[0].Annotations
	if n, ok := a[annotationImageName]; ok {
		if got, err := parseRef(n); err != nil || got != want {
			return fmt.Errorf("%s %q, not %s", annotationImageName, n, want)
		}
	}
	if n, ok := a[annotationRefName]; ok && n != want.tag {
		// The OCI ref name is a tag alone; a full name there is another image's.
		if got, err := parseRef(n); err != nil || got != want {
			return fmt.Errorf("%s %q, not %s", annotationRefName, n, want)
		}
	}
	return nil
}

// checkRepositories: the legacy name file, one repository with one tag.
func checkRepositories(b []byte, want ref) error {
	var repos map[string]map[string]string
	if err := json.Unmarshal(b, &repos); err != nil {
		return err
	}
	if len(repos) != 1 {
		return fmt.Errorf("%d repositories, not one", len(repos))
	}
	for repo, tags := range repos {
		if len(tags) != 1 {
			return fmt.Errorf("%d tags, not one", len(tags))
		}
		for tag := range tags {
			if got, err := parseRef(repo + ":" + tag); err != nil || got != want {
				return fmt.Errorf("names %s:%s, not %s", repo, tag, want)
			}
		}
	}
	return nil
}

// ref is an image name as Docker resolves it: docker.io/library/postgres
// for postgres, with its tag.
type ref struct{ repo, tag string }

func (r ref) String() string { return r.repo + ":" + r.tag }

// parseRef reads repo:tag (no digest) into the name Docker would give it, so
// "kodus-build/m:claim" and "docker.io/kodus-build/m:claim" are one name.
func parseRef(s string) (ref, error) {
	if s == "" || strings.ContainsAny(s, "@ \t\n") {
		return ref{}, fmt.Errorf("%q is not a repo:tag", s)
	}
	repo, tag := s, "latest"
	if i := strings.LastIndexByte(s, ':'); i > strings.LastIndexByte(s, '/') {
		repo, tag = s[:i], s[i+1:]
	}
	if repo == "" || tag == "" {
		return ref{}, fmt.Errorf("%q is not a repo:tag", s)
	}
	first, rest, nested := strings.Cut(repo, "/")
	switch {
	case !nested:
		repo = "docker.io/library/" + repo
	case !strings.ContainsAny(first, ".:") && first != "localhost":
		repo = "docker.io/" + repo
	case first == "index.docker.io":
		repo = "docker.io/" + rest
	}
	if strings.HasPrefix(repo, "docker.io/") && !strings.Contains(strings.TrimPrefix(repo, "docker.io/"), "/") {
		repo = "docker.io/library/" + strings.TrimPrefix(repo, "docker.io/")
	}
	return ref{repo: strings.ToLower(repo), tag: tag}, nil
}
