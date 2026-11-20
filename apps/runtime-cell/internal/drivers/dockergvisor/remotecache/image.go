package remotecache

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// Baked images shared across cells (docs/runtime/shared-baked-environments.md).
// What moves here is one image a bake named, as a standard OCI image manifest
// (config and layers), so the customer's registry, `docker pull
// <repo>@<digest>` and cosign all see an ordinary image. The cell pushes it
// after a bake and reads the manifest's digest back; the hub keeps that
// digest; another cell pulls by it, and the manifest's own bytes must hash to
// it before any layer moves. Every layer is checked against its digest on the
// way in, as the build cache's are.

// Media types of a baked image.
const (
	ImageConfigMediaType = "application/vnd.oci.image.config.v1+json"
	layerTar             = "application/vnd.oci.image.layer.v1.tar"
	layerGzip            = "application/vnd.oci.image.layer.v1.tar+gzip"
	layerZstd            = "application/vnd.oci.image.layer.v1.tar+zstd"
	maxImageLayers       = 512
	maxSavedManifest     = 1 << 20
)

// ErrDigestMismatch is a manifest whose bytes are not the digest the cell asked for.
var ErrDigestMismatch = errors.New("remotecache: the manifest is not the digest the hub recorded")

// ImageKey names one baked image: the org, the environment and the build
// fingerprint of the service image (buildfingerprint), the same key a claim
// matches a bake's image by on the cell that baked it.
type ImageKey struct {
	Org, Env, Fingerprint string
}

// Repository is the environment's baked images under prefix:
// <prefix>/o-<org>/b-<org, env>, each a hash. The org's hash is its own path
// segment, as the build cache's, so one access rule per org holds both.
func (k ImageKey) Repository(prefix string) string {
	return prefix + "/o-" + hashOf(k.Org) + "/b-" + hashOf(k.Org, k.Env)
}

// Tag is the fingerprint's tag: a hash, since a fingerprint may hold
// characters a tag may not. The tag is a convenience for people; a cell pulls
// by digest only.
func (k ImageKey) Tag() string { return "fp-" + hashOf(k.Fingerprint) }

func (k ImageKey) valid() bool { return k.Org != "" && k.Env != "" && k.Fingerprint != "" }

type savedImage struct {
	Config string   `json:"Config"`
	Layers []string `json:"Layers"`
}

// PushImage pushes the image `docker save` wrote, extracted at dir: the one
// image manifest.json names. It returns the manifest's digest. dir is the
// cell's own export, but every read stays inside it and every blob must hash
// to its name before the first byte leaves the cell.
func (r *Registry) PushImage(ctx context.Context, k ImageKey, dir string) (string, Stats, error) {
	var st Stats
	if !k.valid() {
		return "", st, errors.New("remotecache: image key needs org, environment and fingerprint")
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		return "", st, fmt.Errorf("remotecache: %w", err)
	}
	defer func() { _ = root.Close() }()
	saved, err := readSaved(root)
	if err != nil {
		return "", st, err
	}
	describe := func(p, mediaType string) (descriptor, error) {
		d, ok := strings.CutPrefix(p, "blobs/sha256/")
		if !ok || !digestRE.MatchString("sha256:"+d) {
			return descriptor{}, fmt.Errorf("remotecache: %q is not a blob", p)
		}
		info, err := root.Lstat(p)
		if err != nil || !info.Mode().IsRegular() {
			return descriptor{}, fmt.Errorf("remotecache: blob %q is not a regular file", p)
		}
		if mediaType == "" {
			mediaType, err = layerMediaType(root, p)
			if err != nil {
				return descriptor{}, err
			}
		}
		return descriptor{MediaType: mediaType, Digest: "sha256:" + d, Size: info.Size()}, nil
	}
	m := manifest{SchemaVersion: 2, MediaType: ManifestMediaType}
	if m.Config, err = describe(saved.Config, ImageConfigMediaType); err != nil {
		return "", st, err
	}
	for _, l := range saved.Layers {
		d, err := describe(l, "")
		if err != nil {
			return "", st, err
		}
		m.Layers = append(m.Layers, d)
	}
	var total int64
	for _, b := range append([]descriptor{m.Config}, m.Layers...) {
		if total += b.Size; total > r.maxBytes {
			return "", st, fmt.Errorf("remotecache: the image passes %d bytes", r.maxBytes)
		}
		st.Blobs++
		st.Bytes += b.Size
		moved, err := r.pushBlob(ctx, k.Repository(r.prefix), b, func() (io.ReadCloser, error) { return openBlob(root, b) })
		if err != nil {
			return "", st, err
		}
		if moved {
			st.Moved++
			st.MovedBytes += b.Size
		}
	}
	body, err := json.Marshal(m)
	if err != nil {
		return "", st, err
	}
	digest := digestOf(body)
	resp, err := r.request(ctx, http.MethodPut, "/v2/"+k.Repository(r.prefix)+"/manifests/"+k.Tag(), bytes.NewReader(body), int64(len(body)), map[string]string{"Content-Type": ManifestMediaType})
	if err != nil {
		return "", st, fmt.Errorf("remotecache: manifest: %w", err)
	}
	defer drain(resp)
	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusOK {
		return "", st, statusErr("manifest", resp)
	}
	if got := resp.Header.Get("Docker-Content-Digest"); got != "" && got != digest {
		return "", st, fmt.Errorf("%w: the registry stored %s, the cell pushed %s", ErrDigestMismatch, short(got), short(digest))
	}
	return digest, st, nil
}

// readSaved is the one image the manifest.json of a `docker save` names.
func readSaved(root *os.Root) (savedImage, error) {
	raw, err := readRegular(root, "manifest.json", maxSavedManifest)
	if err != nil {
		return savedImage{}, fmt.Errorf("remotecache: manifest.json: %w", err)
	}
	var saved []savedImage
	if err := json.Unmarshal(raw, &saved); err != nil || len(saved) != 1 || len(saved[0].Layers) > maxImageLayers {
		return savedImage{}, errors.New("remotecache: manifest.json is not exactly one image")
	}
	return saved[0], nil
}

// ErrSecretInImage is a baked image a blob of which carries one of the
// claim's secret values: it never leaves the cell.
var ErrSecretInImage = errors.New("remotecache: the image carries a secret value of its claim")

// ErrUnscannedLayer is a layer the cell cannot read to check (zstd, which it
// cannot decompress): nothing proves it clean, so it is not pushed.
var ErrUnscannedLayer = errors.New("remotecache: a layer the cell cannot read for secrets")

// CheckImageSecrets reads every blob of the image `docker save` wrote at dir
// (its config and each layer, a gzip layer decompressed) through found, the
// redactor's check of the claim's secret values. A blob found carries one is
// ErrSecretInImage, a zstd layer ErrUnscannedLayer; a read error is returned.
// The tar is read as bytes: file contents, names and headers alike.
func CheckImageSecrets(dir string, found func(io.Reader) (bool, error)) error {
	root, err := os.OpenRoot(dir)
	if err != nil {
		return fmt.Errorf("remotecache: %w", err)
	}
	defer func() { _ = root.Close() }()
	saved, err := readSaved(root)
	if err != nil {
		return err
	}
	for _, p := range append([]string{saved.Config}, saved.Layers...) {
		if err := checkBlob(root, p, found); err != nil {
			return err
		}
	}
	return nil
}

func checkBlob(root *os.Root, p string, found func(io.Reader) (bool, error)) error {
	f, err := openRegular(root, p)
	if err != nil {
		return fmt.Errorf("remotecache: blob %q: %w", p, err)
	}
	defer func() { _ = f.Close() }()
	head := make([]byte, 4)
	n, _ := io.ReadFull(f, head)
	r := io.MultiReader(bytes.NewReader(head[:n]), f)
	switch {
	case n == 4 && bytes.Equal(head, []byte{0x28, 0xb5, 0x2f, 0xfd}):
		return fmt.Errorf("%w: %s", ErrUnscannedLayer, p)
	case n >= 2 && head[0] == 0x1f && head[1] == 0x8b:
		zr, err := gzip.NewReader(r)
		if err != nil {
			return fmt.Errorf("remotecache: blob %q: %w", p, err)
		}
		defer func() { _ = zr.Close() }()
		r = zr
	}
	hit, err := found(r)
	if err != nil {
		return fmt.Errorf("remotecache: blob %q: %w", p, err)
	}
	if hit {
		return fmt.Errorf("%w: %s", ErrSecretInImage, p)
	}
	return nil
}

// layerMediaType reads a layer's first bytes: docker save writes plain tar
// with the classic store and the registry's compression with containerd's.
func layerMediaType(root *os.Root, p string) (string, error) {
	f, err := openRegular(root, p)
	if err != nil {
		return "", fmt.Errorf("remotecache: blob %q: %w", p, err)
	}
	defer func() { _ = f.Close() }()
	head := make([]byte, 4)
	n, _ := io.ReadFull(f, head)
	switch {
	case n >= 2 && head[0] == 0x1f && head[1] == 0x8b:
		return layerGzip, nil
	case n == 4 && bytes.Equal(head, []byte{0x28, 0xb5, 0x2f, 0xfd}):
		return layerZstd, nil
	default:
		return layerTar, nil
	}
}

// PullImage pulls the image at digest from k's repository into tarball, a
// `docker load` archive whose one name is tag (the name the pulling cell
// gives its generation, which dockercli.LoadImage then checks). The
// manifest's bytes must hash to digest, and each blob to its descriptor;
// either failing removes what was written.
func (r *Registry) PullImage(ctx context.Context, k ImageKey, digest, tarball, tag string) (Stats, error) {
	var st Stats
	if !k.valid() || !digestRE.MatchString(digest) || tag == "" {
		return st, errors.New("remotecache: a pull needs an image key, a sha256 digest and a name")
	}
	repo := k.Repository(r.prefix)
	resp, err := r.request(ctx, http.MethodGet, "/v2/"+repo+"/manifests/"+digest, nil, 0, map[string]string{"Accept": ManifestMediaType})
	if err != nil {
		return st, fmt.Errorf("remotecache: manifest: %w", err)
	}
	if resp.StatusCode == http.StatusNotFound {
		drain(resp)
		return st, ErrNotFound
	}
	if resp.StatusCode != http.StatusOK {
		drain(resp)
		return st, statusErr("manifest", resp)
	}
	body, err := readBounded(resp.Body, maxManifestBytes)
	drain(resp)
	if err != nil {
		return st, fmt.Errorf("remotecache: manifest: %w", err)
	}
	if digestOf(body) != digest {
		return st, ErrDigestMismatch
	}
	var m manifest
	if err := json.Unmarshal(body, &m); err != nil {
		return st, fmt.Errorf("remotecache: manifest: %w", err)
	}
	if m.SchemaVersion != 2 || m.MediaType != ManifestMediaType || m.Config.MediaType != ImageConfigMediaType || len(m.Layers) > maxImageLayers {
		return st, errors.New("remotecache: the manifest is not a baked image")
	}
	var total int64
	for _, d := range append([]descriptor{m.Config}, m.Layers...) {
		if !digestRE.MatchString(d.Digest) || d.Size < 0 {
			return st, errors.New("remotecache: the manifest names a blob that is not sha256")
		}
		if total += d.Size; total > r.maxBytes {
			return st, fmt.Errorf("remotecache: the image passes %d bytes", r.maxBytes)
		}
	}
	dir := tarball + ".d"
	if err := os.MkdirAll(filepath.Join(dir, "blobs", "sha256"), 0o700); err != nil {
		return st, err
	}
	defer func() { _ = os.RemoveAll(dir) }()
	saved := savedImage{Config: blobPath(m.Config.Digest)}
	seen := map[string]bool{}
	for i, d := range append([]descriptor{m.Config}, m.Layers...) {
		if i > 0 {
			saved.Layers = append(saved.Layers, blobPath(d.Digest))
		}
		if seen[d.Digest] {
			continue
		}
		seen[d.Digest] = true
		if err := r.fetchFile(ctx, repo, d, filepath.Join(dir, blobPath(d.Digest))); err != nil {
			return st, err
		}
		st.Blobs++
		st.Moved++
		st.Bytes += d.Size
		st.MovedBytes += d.Size
	}
	if err := os.WriteFile(filepath.Join(dir, blobPath(digest)), body, 0o600); err != nil {
		return st, err
	}
	if err := writeLoadable(dir, tarball, tag, digest, int64(len(body)), saved); err != nil {
		_ = os.Remove(tarball)
		return st, err
	}
	return st, nil
}

// writeLoadable writes dir as one archive docker load takes with either image
// store: manifest.json (the classic store) and an OCI index naming the
// manifest under tag (containerd's).
func writeLoadable(dir, tarball, tag, digest string, size int64, saved savedImage) error {
	saved.Layers = append([]string{}, saved.Layers...)
	m, err := json.Marshal([]map[string]any{{"Config": saved.Config, "RepoTags": []string{tag}, "Layers": saved.Layers}})
	if err != nil {
		return err
	}
	_, refName, _ := strings.Cut(tag, ":")
	idx, err := json.Marshal(map[string]any{"schemaVersion": 2, "mediaType": "application/vnd.oci.image.index.v1+json", "manifests": []map[string]any{{
		"mediaType": ManifestMediaType, "digest": digest, "size": size,
		"annotations": map[string]string{"io.containerd.image.name": fullName(tag), "org.opencontainers.image.ref.name": refName},
	}}})
	if err != nil {
		return err
	}
	f, err := os.OpenFile(tarball, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600) //nolint:gosec // G304: a new file in the cell's own work directory
	if err != nil {
		return err
	}
	tw := tar.NewWriter(f)
	add := func(name string, b []byte) error {
		if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: int64(len(b)), Typeflag: tar.TypeReg}); err != nil {
			return err
		}
		_, err := tw.Write(b)
		return err
	}
	err = errors.Join(add("oci-layout", []byte(`{"imageLayoutVersion":"1.0.0"}`)), add("index.json", idx), add("manifest.json", m))
	if err == nil {
		err = tw.WriteHeader(&tar.Header{Name: "blobs/", Mode: 0o755, Typeflag: tar.TypeDir})
	}
	if err == nil {
		err = tw.WriteHeader(&tar.Header{Name: "blobs/sha256/", Mode: 0o755, Typeflag: tar.TypeDir})
	}
	entries, rerr := os.ReadDir(filepath.Join(dir, "blobs", "sha256"))
	err = errors.Join(err, rerr)
	for _, e := range entries {
		if err != nil {
			break
		}
		err = addFile(tw, filepath.Join(dir, "blobs", "sha256", e.Name()), "blobs/sha256/"+e.Name())
	}
	return errors.Join(err, tw.Close(), f.Close())
}

// fullName is tag as the containerd image store keeps it: an image of no
// registry is docker.io's, and a name loaded without that prefix is listed
// but not found by its tag.
func fullName(tag string) string {
	first, _, ok := strings.Cut(tag, "/")
	if ok && (strings.ContainsAny(first, ".:") || first == "localhost") {
		return tag
	}
	if !ok {
		return "docker.io/library/" + tag
	}
	return "docker.io/" + tag
}

func addFile(tw *tar.Writer, path, name string) error {
	f, err := os.Open(path) //nolint:gosec // G304: a blob this pull wrote and checked
	if err != nil {
		return err
	}
	defer func() { _ = f.Close() }()
	info, err := f.Stat()
	if err != nil {
		return err
	}
	if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: info.Size(), Typeflag: tar.TypeReg}); err != nil {
		return err
	}
	_, err = io.Copy(tw, f)
	return err
}
