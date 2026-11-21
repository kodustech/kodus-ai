package rootfs

import (
	"archive/tar"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// An OCI image layout (https://github.com/opencontainers/image-spec,
// image-layout.md) as a directory or a tar of one: what `docker save`
// (Docker 25 and later) and `docker buildx build --output type=oci` write.

const (
	mtOCIIndex      = "application/vnd.oci.image.index.v1+json"
	mtOCIManifest   = "application/vnd.oci.image.manifest.v1+json"
	mtDockerList    = "application/vnd.docker.distribution.manifest.list.v2+json"
	mtDockerV2      = "application/vnd.docker.distribution.manifest.v2+json"
	mtLayerTar      = "application/vnd.oci.image.layer.v1.tar"
	mtLayerGzip     = "application/vnd.oci.image.layer.v1.tar+gzip"
	mtDockerLayer   = "application/vnd.docker.image.rootfs.diff.tar.gzip"
	mtLayerZstd     = "application/vnd.oci.image.layer.v1.tar+zstd"
	maxManifestSize = 4 << 20
)

type descriptor struct {
	MediaType string `json:"mediaType"`
	Digest    string `json:"digest"`
	Size      int64  `json:"size"`
	Platform  *struct {
		OS           string `json:"os"`
		Architecture string `json:"architecture"`
		Variant      string `json:"variant,omitempty"`
	} `json:"platform,omitempty"`
}

type index struct {
	MediaType string       `json:"mediaType"`
	Manifests []descriptor `json:"manifests"`
}

type manifest struct {
	MediaType string       `json:"mediaType"`
	Layers    []descriptor `json:"layers"`
}

var digestRE = regexp.MustCompile(`^sha256:([0-9a-f]{64})$`)

// Layout is an OCI image layout on disk.
type Layout struct{ dir string }

// OpenLayout opens a layout directory, or extracts a layout tar into
// scratch (a directory the caller removes) and opens that.
func OpenLayout(path, scratch string) (*Layout, error) {
	fi, err := os.Stat(path)
	if err != nil {
		return nil, fmt.Errorf("rootfs: %w", err)
	}
	if fi.IsDir() {
		return &Layout{dir: path}, nil
	}
	if err := extractLayout(path, scratch); err != nil {
		return nil, err
	}
	return &Layout{dir: scratch}, nil
}

// extractLayout writes index.json, oci-layout and the blobs of a layout tar
// into dir, and nothing else: no other name, no link, no directory outside.
func extractLayout(tarPath, dir string) error {
	f, err := os.Open(tarPath) //nolint:gosec // G304: the operator's image file
	if err != nil {
		return fmt.Errorf("rootfs: %w", err)
	}
	defer func() { _ = f.Close() }()
	if err := os.MkdirAll(filepath.Join(dir, "blobs", "sha256"), 0o700); err != nil {
		return err
	}
	blob := regexp.MustCompile(`^blobs/sha256/[0-9a-f]{64}$`)
	tr := tar.NewReader(f)
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("rootfs: layout tar: %w", err)
		}
		name := strings.TrimPrefix(h.Name, "./")
		if h.Typeflag != tar.TypeReg || (name != "index.json" && name != "oci-layout" && !blob.MatchString(name)) {
			continue
		}
		out, err := os.OpenFile(filepath.Join(dir, filepath.FromSlash(name)), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600) //nolint:gosec // G304: name is index.json, oci-layout or blobs/sha256/<64 hex>, checked above
		if err != nil {
			return fmt.Errorf("rootfs: layout tar: %w", err)
		}
		_, err = io.Copy(out, tr) //nolint:gosec // G110: a blob is checked against its digest when read
		if cerr := out.Close(); err == nil {
			err = cerr
		}
		if err != nil {
			return err
		}
	}
}

func (l *Layout) blobPath(d descriptor) (string, error) {
	m := digestRE.FindStringSubmatch(d.Digest)
	if m == nil {
		return "", fmt.Errorf("rootfs: digest %q is not sha256", d.Digest)
	}
	return filepath.Join(l.dir, "blobs", "sha256", m[1]), nil
}

// readBlob reads a small blob (an index, a manifest) and checks its digest.
func (l *Layout) readBlob(d descriptor) ([]byte, error) {
	p, err := l.blobPath(d)
	if err != nil {
		return nil, err
	}
	f, err := os.Open(p) //nolint:gosec // G304: a path built from a checked digest
	if err != nil {
		return nil, fmt.Errorf("rootfs: blob %s: %w", d.Digest, err)
	}
	defer func() { _ = f.Close() }()
	b, err := io.ReadAll(io.LimitReader(f, maxManifestSize+1))
	if err != nil {
		return nil, err
	}
	if len(b) > maxManifestSize {
		return nil, fmt.Errorf("rootfs: blob %s is too large for a manifest", d.Digest)
	}
	sum := sha256.Sum256(b)
	if "sha256:"+hex.EncodeToString(sum[:]) != d.Digest {
		return nil, fmt.Errorf("rootfs: blob %s does not match its digest", d.Digest)
	}
	return b, nil
}

// Layers are the image's layers for platform ("linux/amd64",
// "linux/arm64"), base first. Each one is checked against its digest as it
// is read: a layer whose bytes do not match fails its read.
func (l *Layout) Layers(platform string) ([]Layer, error) {
	raw, err := os.ReadFile(filepath.Join(l.dir, "index.json"))
	if err != nil {
		return nil, fmt.Errorf("rootfs: %w", err)
	}
	var idx index
	if err := json.Unmarshal(raw, &idx); err != nil {
		return nil, fmt.Errorf("rootfs: index.json: %w", err)
	}
	m, err := l.pick(idx.Manifests, platform, 0)
	if err != nil {
		return nil, err
	}
	var layers []Layer
	for _, d := range m.Layers {
		switch d.MediaType {
		case mtLayerTar, mtLayerGzip, mtDockerLayer:
		case mtLayerZstd:
			return nil, fmt.Errorf("rootfs: layer %s is zstd; rebuild the image with gzip layers", d.Digest)
		default:
			return nil, fmt.Errorf("rootfs: layer %s has media type %q", d.Digest, d.MediaType)
		}
		p, err := l.blobPath(d)
		if err != nil {
			return nil, err
		}
		layers = append(layers, openLayer(p, d))
	}
	if len(layers) == 0 {
		return nil, errors.New("rootfs: the image has no layer")
	}
	return layers, nil
}

// pick follows indexes down to the one manifest of platform.
func (l *Layout) pick(ds []descriptor, platform string, depth int) (manifest, error) {
	if depth > 3 {
		return manifest{}, errors.New("rootfs: indexes nest too deep")
	}
	var found []descriptor
	for _, d := range ds {
		if d.Platform != nil {
			p := d.Platform.OS + "/" + d.Platform.Architecture
			if p != platform && p+"/"+d.Platform.Variant != platform {
				continue
			}
		}
		if d.Platform == nil && d.MediaType != mtOCIIndex && d.MediaType != mtDockerList && len(ds) > 1 {
			// An attestation or another untagged manifest beside the image.
			continue
		}
		found = append(found, d)
	}
	if len(found) == 0 && len(ds) == 1 {
		found = ds
	}
	if len(found) != 1 {
		return manifest{}, fmt.Errorf("rootfs: %d manifests match %s", len(found), platform)
	}
	d := found[0]
	b, err := l.readBlob(d)
	if err != nil {
		return manifest{}, err
	}
	switch d.MediaType {
	case mtOCIIndex, mtDockerList:
		var idx index
		if err := json.Unmarshal(b, &idx); err != nil {
			return manifest{}, fmt.Errorf("rootfs: index %s: %w", d.Digest, err)
		}
		return l.pick(idx.Manifests, platform, depth+1)
	case mtOCIManifest, mtDockerV2:
		var m manifest
		if err := json.Unmarshal(b, &m); err != nil {
			return manifest{}, fmt.Errorf("rootfs: manifest %s: %w", d.Digest, err)
		}
		return m, nil
	}
	return manifest{}, fmt.Errorf("rootfs: %s has media type %q", d.Digest, d.MediaType)
}

// openLayer opens a layer blob, verifying its digest when the reader
// reaches its end, and decompressing it when it is gzip.
func openLayer(p string, d descriptor) Layer {
	return func() (io.ReadCloser, error) {
		f, err := os.Open(p) //nolint:gosec // G304: a path built from a checked digest
		if err != nil {
			return nil, fmt.Errorf("rootfs: layer %s: %w", d.Digest, err)
		}
		v := &verified{r: f, h: sha256.New(), want: strings.TrimPrefix(d.Digest, "sha256:"), f: f}
		if d.MediaType == mtLayerTar {
			return v, nil
		}
		z, err := gzip.NewReader(v)
		if err != nil {
			_ = f.Close()
			return nil, fmt.Errorf("rootfs: layer %s: %w", d.Digest, err)
		}
		return &gzLayer{z: z, v: v}, nil
	}
}

type verified struct {
	r    io.Reader
	h    hash.Hash
	want string
	f    *os.File
}

func (v *verified) Read(p []byte) (int, error) {
	n, err := v.r.Read(p)
	_, _ = v.h.Write(p[:n])
	if errors.Is(err, io.EOF) && hex.EncodeToString(v.h.Sum(nil)) != v.want {
		return n, fmt.Errorf("rootfs: layer sha256:%s does not match its digest", v.want)
	}
	return n, err
}

func (v *verified) Close() error { return v.f.Close() }

type gzLayer struct {
	z *gzip.Reader
	v *verified
}

func (g *gzLayer) Read(p []byte) (int, error) {
	n, err := g.z.Read(p)
	if errors.Is(err, io.EOF) {
		// Read what follows the gzip stream so the digest covers the blob.
		if _, derr := io.Copy(io.Discard, g.v); derr != nil {
			return n, derr
		}
	}
	return n, err
}

func (g *gzLayer) Close() error { _ = g.z.Close(); return g.v.Close() }
