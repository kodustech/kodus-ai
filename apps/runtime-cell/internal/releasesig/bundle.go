package releasesig

// The offline bundle: one directory a host with no network installs or
// updates a cell from (docs/runtime/self-hosted.md, "Air-gapped host").
//
//	BUNDLE        the manifest (MarshalBundle): every artifact, its sha256
//	BUNDLE.sig    its signature, with the release key, under its own prefix
//	release/      the signed release: SHA256SUMS(.sig), RELEASE-INDEX(.sig),
//	              PROTOCOL, <command>-linux-<arch>
//	images/       <component>.oci.tar: each image the host runs, an OCI
//	              archive whose index.json lists the pinned digest
//	gvisor/       <arch>/gvisor.tar.bz2, the runsc archive of each arch
//
// The bundle's signature is made with the same release key as SHA256SUMS
// and RELEASE-INDEX (no new key type), over BundleMessage, whose prefix no
// release or index message has: a bundle signature never passes for one of
// theirs, nor theirs for a bundle's.

import (
	"archive/tar"
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"
)

const (
	// BundleManifestName is the bundle's manifest.
	BundleManifestName = "BUNDLE"
	// BundleSignatureName is the manifest's signature.
	BundleSignatureName = BundleManifestName + ".sig"

	bundleHeader          = "kodus-cell-bundle v1"
	bundleSignatureHeader = "kodus-cell-release-bundle-signature v1"
	bundleMessagePrefix   = "kodus-cell-release-bundle v1\n"

	// Artifact kinds.
	KindRelease = "release"
	KindImage   = "image"
	KindRunsc   = "runsc"

	// maxIndexJSON bounds an OCI archive's index.json.
	maxIndexJSON = 1 << 20
)

var (
	imageRef      = regexp.MustCompile(`^[a-z0-9][a-z0-9._:/-]{0,254}@(sha256:[0-9a-f]{64})$`)
	componentName = regexp.MustCompile(`^[a-z][a-z0-9-]{0,31}$`)
	archName      = regexp.MustCompile(`^(x86_64|aarch64)$`)
	bundlePath    = regexp.MustCompile(`^(release/[A-Za-z0-9][A-Za-z0-9._+-]{0,127}|images/[a-z][a-z0-9-]{0,31}\.oci\.tar|gvisor/(x86_64|aarch64)/gvisor\.tar\.bz2)$`)
	// The release files every bundle carries: what `cell update -from` and
	// the installer verify the release with.
	bundleRequired = []string{ManifestName, SignatureName, IndexName, IndexSignatureName, ProtocolName}
)

// Artifact is one line of BUNDLE: Name is the release file, the image's
// component or the runsc archive's arch; Ref the image's pinned reference
// (repository@sha256:...), "-" for the other kinds.
type Artifact struct {
	SHA256 string
	Kind   string
	Name   string
	Path   string
	Ref    string
}

// Bundle is a parsed BUNDLE.
type Bundle struct {
	Release   string
	Artifacts []Artifact
}

// BundleMessage is what a bundle's signature covers.
func BundleMessage(release string, manifest []byte) []byte {
	m := make([]byte, 0, len(bundleMessagePrefix)+len(release)+len(manifest)+16)
	m = append(m, bundleMessagePrefix...)
	m = append(m, "release "+release+"\n"...)
	return append(m, manifest...)
}

// MarshalBundle is BUNDLE's text: a header, the release, then one
// tab-separated "<sha256> <kind> <name> <path> <ref>" line per artifact,
// sorted by path, so the same bundle always has the same bytes.
func MarshalBundle(b Bundle) ([]byte, error) {
	if err := b.check(); err != nil {
		return nil, err
	}
	arts := slices.Clone(b.Artifacts)
	slices.SortFunc(arts, func(x, y Artifact) int { return strings.Compare(x.Path, y.Path) })
	var buf bytes.Buffer
	fmt.Fprintf(&buf, "%s\nrelease %s\n", bundleHeader, b.Release)
	for _, a := range arts {
		fmt.Fprintf(&buf, "%s\t%s\t%s\t%s\t%s\n", a.SHA256, a.Kind, a.Name, a.Path, a.Ref)
	}
	return buf.Bytes(), nil
}

// ParseBundle reads BUNDLE; file names it in an error.
func ParseBundle(text []byte, file string) (Bundle, error) {
	lines := strings.Split(strings.TrimSuffix(string(text), "\n"), "\n")
	if len(lines) < 2 || lines[0] != bundleHeader {
		return Bundle{}, refuse(file, "not a %q manifest", bundleHeader)
	}
	release, ok := strings.CutPrefix(lines[1], "release ")
	if !ok {
		return Bundle{}, refuse(file, "line 2 is not \"release <name>\"")
	}
	b := Bundle{Release: release}
	for i, l := range lines[2:] {
		f := strings.Split(l, "\t")
		if len(f) != 5 {
			return Bundle{}, refuse(file, "line %d is not \"<sha256>\\t<kind>\\t<name>\\t<path>\\t<ref>\"", i+3)
		}
		b.Artifacts = append(b.Artifacts, Artifact{SHA256: f[0], Kind: f[1], Name: f[2], Path: f[3], Ref: f[4]})
	}
	if err := b.check(); err != nil {
		return Bundle{}, refuse(file, "%v", err)
	}
	return b, nil
}

func (b Bundle) check() error {
	if !releaseName.MatchString(b.Release) {
		return fmt.Errorf("releasesig: %q is not a release name", b.Release)
	}
	seen := map[string]bool{}
	var release []string
	for _, a := range b.Artifacts {
		if len(a.SHA256) != 64 || strings.Trim(a.SHA256, "0123456789abcdef") != "" {
			return fmt.Errorf("releasesig: %s: %q is not a sha256", a.Path, a.SHA256)
		}
		if !bundlePath.MatchString(a.Path) {
			return fmt.Errorf("releasesig: %q is not a bundle path", a.Path)
		}
		if seen[a.Path] {
			return fmt.Errorf("releasesig: %s is listed twice", a.Path)
		}
		seen[a.Path] = true
		var want string
		switch a.Kind {
		case KindRelease:
			want = "release/" + a.Name
			release = append(release, a.Name)
			if a.Ref != "-" {
				return fmt.Errorf("releasesig: %s: a release file has no reference", a.Path)
			}
		case KindImage:
			want = "images/" + a.Name + ".oci.tar"
			if !componentName.MatchString(a.Name) || !imageRef.MatchString(a.Ref) {
				return fmt.Errorf("releasesig: %s: an image needs a component and a reference pinned by digest (repository@sha256:...), not %q", a.Path, a.Ref)
			}
		case KindRunsc:
			want = "gvisor/" + a.Name + "/gvisor.tar.bz2"
			if !archName.MatchString(a.Name) || a.Ref != "-" {
				return fmt.Errorf("releasesig: %s: a runsc archive is named by its arch (x86_64, aarch64)", a.Path)
			}
		default:
			return fmt.Errorf("releasesig: %s: unknown kind %q", a.Path, a.Kind)
		}
		if a.Path != want {
			return fmt.Errorf("releasesig: %s: a %s %q lives at %s", a.Path, a.Kind, a.Name, want)
		}
	}
	for _, r := range bundleRequired {
		if !slices.Contains(release, r) {
			return fmt.Errorf("releasesig: the bundle carries no release/%s", r)
		}
	}
	return nil
}

// SignBundle is the signature file of manifest (MarshalBundle's output).
func SignBundle(priv ed25519.PrivateKey, manifest []byte) ([]byte, error) {
	b, err := ParseBundle(manifest, BundleManifestName)
	if err != nil {
		return nil, err
	}
	pub, _ := priv.Public().(ed25519.PublicKey)
	sig := ed25519.Sign(priv, BundleMessage(b.Release, manifest))
	var out bytes.Buffer
	fmt.Fprintf(&out, "%s\nkey %s\nrelease %s\nsignature %s\n", bundleSignatureHeader, KeyID(pub), b.Release, base64.StdEncoding.EncodeToString(sig))
	return out.Bytes(), nil
}

// VerifyBundle checks dir offline, before anything in it is loaded: BUNDLE's
// signature against the pinned keys, the sha256 of every artifact it lists,
// that each image archive lists its pinned digest, then the release inside
// as `cell update` would (its SHA256SUMS signature for the bundle's release,
// every release file against SHA256SUMS) and its release index (signed, not
// expired at now, not revoking the key that signed the bundle). Ordering
// against a host's installed release and stored index is cellupdate's.
func VerifyBundle(dir string, keys []PublicKey, now time.Time) (Bundle, Index, error) {
	if len(keys) == 0 {
		return Bundle{}, Index{}, refuse("", "no release key is pinned: nothing can be verified")
	}
	manifestPath, sigPath := filepath.Join(dir, BundleManifestName), filepath.Join(dir, BundleSignatureName)
	manifest, err := readSmall(manifestPath)
	if err != nil {
		return Bundle{}, Index{}, err
	}
	sigText, err := readSmall(sigPath)
	if err != nil {
		return Bundle{}, Index{}, err
	}
	keyID, signedRelease, sig, err := parseSignatureWith(sigText, sigPath, bundleSignatureHeader)
	if err != nil {
		return Bundle{}, Index{}, err
	}
	var pub ed25519.PublicKey
	for _, k := range keys {
		if k.ID == keyID {
			pub = k.Key
		}
	}
	if pub == nil {
		return Bundle{}, Index{}, refuse(sigPath, "signed with key %s, which is not pinned", keyID)
	}
	if !ed25519.Verify(pub, BundleMessage(signedRelease, manifest), sig) {
		return Bundle{}, Index{}, refuse(sigPath, "the signature does not verify against %s with key %s", BundleManifestName, keyID)
	}
	b, err := ParseBundle(manifest, manifestPath)
	if err != nil {
		return Bundle{}, Index{}, err
	}
	if b.Release != signedRelease {
		return Bundle{}, Index{}, refuse(sigPath, "signed for release %q, the manifest names %q", signedRelease, b.Release)
	}
	for _, a := range b.Artifacts {
		p := filepath.Join(dir, filepath.FromSlash(a.Path))
		if err := CheckFile(p, a.SHA256); err != nil {
			return Bundle{}, Index{}, err
		}
		if a.Kind == KindImage {
			if err := checkOCIArchive(p, a.Ref); err != nil {
				return Bundle{}, Index{}, err
			}
		}
	}
	relDir := filepath.Join(dir, "release")
	sums, err := Verify(relDir, b.Release, keys)
	if err != nil {
		return Bundle{}, Index{}, err
	}
	for _, a := range b.Artifacts {
		if a.Kind != KindRelease || a.Name == ManifestName || a.Name == SignatureName || a.Name == IndexName || a.Name == IndexSignatureName {
			continue
		}
		want, ok := sums[a.Name]
		if !ok {
			return Bundle{}, Index{}, refuse(filepath.Join(relDir, a.Name), "not listed in the release's %s", ManifestName)
		}
		if err := CheckFile(filepath.Join(relDir, a.Name), want); err != nil {
			return Bundle{}, Index{}, err
		}
	}
	ix, err := VerifyIndex(relDir, keys, nil, now)
	if err != nil {
		return Bundle{}, Index{}, err
	}
	if slices.Contains(ix.RevokedKeys, keyID) {
		return Bundle{}, Index{}, refuse(sigPath, "signed with key %s, which the release index revokes", keyID)
	}
	return b, ix, nil
}

// ImageInput is one image of a bundle: the component (images.lock), its
// pinned reference and the OCI archive saved from it (skopeo copy
// docker://<ref> oci-archive:<file>).
type ImageInput struct {
	Component string
	Ref       string
	Archive   string
}

// BuildBundle writes the bundle of the signed release in releaseDir into
// out (which must not exist): it refuses a release whose signature or
// index does not verify with priv's key at now, and an image archive that
// does not list its pinned digest, then signs BUNDLE and verifies the
// result as a host would. runsc maps an arch (x86_64, aarch64) to its
// gvisor.tar.bz2.
func BuildBundle(priv ed25519.PrivateKey, release, releaseDir string, images []ImageInput, runsc map[string]string, out string, now time.Time) error {
	pub, _ := priv.Public().(ed25519.PublicKey)
	keys := []PublicKey{{ID: KeyID(pub), Key: pub}}
	sums, err := Verify(releaseDir, release, keys)
	if err != nil {
		return err
	}
	if _, err := VerifyIndex(releaseDir, keys, nil, now); err != nil {
		return err
	}
	if err := os.Mkdir(out, 0o755); err != nil { //nolint:gosec // G301: a bundle to publish
		return err
	}
	b := Bundle{Release: release}
	add := func(kind, name, rel, ref, src string) error {
		dst := filepath.Join(out, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil { //nolint:gosec // G301: a bundle to publish
			return err
		}
		sum, err := copyHashed(src, dst)
		if err != nil {
			return err
		}
		b.Artifacts = append(b.Artifacts, Artifact{SHA256: sum, Kind: kind, Name: name, Path: rel, Ref: ref})
		return nil
	}
	names := []string{SignatureName, IndexName, IndexSignatureName, ManifestName}
	for n := range sums {
		names = append(names, n)
	}
	for _, n := range names {
		if err := add(KindRelease, n, "release/"+n, "-", filepath.Join(releaseDir, n)); err != nil {
			return err
		}
	}
	for _, im := range images {
		if err := checkOCIArchive(im.Archive, im.Ref); err != nil {
			return err
		}
		if err := add(KindImage, im.Component, "images/"+im.Component+".oci.tar", im.Ref, im.Archive); err != nil {
			return err
		}
	}
	for arch, src := range runsc {
		if err := add(KindRunsc, arch, "gvisor/"+arch+"/gvisor.tar.bz2", "-", src); err != nil {
			return err
		}
	}
	manifest, err := MarshalBundle(b)
	if err != nil {
		return err
	}
	sig, err := SignBundle(priv, manifest)
	if err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(out, BundleManifestName), manifest, 0o644); err != nil { //nolint:gosec // G306: published with the bundle
		return err
	}
	if err := os.WriteFile(filepath.Join(out, BundleSignatureName), sig, 0o644); err != nil { //nolint:gosec // G306: published with the bundle
		return err
	}
	_, _, err = VerifyBundle(out, keys, now)
	return err
}

// checkOCIArchive refuses, naming path, a file that is not an OCI archive
// (a tar of an OCI image layout) whose index.json lists ref's digest.
func checkOCIArchive(path, ref string) error {
	m := imageRef.FindStringSubmatch(ref)
	if m == nil {
		return refuse(path, "%q is not a reference pinned by digest", ref)
	}
	f, err := os.Open(path) //nolint:gosec // G304: an artifact of the bundle
	if err != nil {
		return refuse(path, "%v", err)
	}
	defer func() { _ = f.Close() }()
	tr := tar.NewReader(f)
	layout := false
	var index []byte
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return refuse(path, "not an OCI archive: %v", err)
		}
		switch strings.TrimPrefix(h.Name, "./") {
		case "oci-layout":
			layout = true
		case "index.json":
			if index, err = io.ReadAll(io.LimitReader(tr, maxIndexJSON+1)); err != nil || len(index) > maxIndexJSON {
				return refuse(path, "index.json is unreadable or larger than %d bytes", maxIndexJSON)
			}
		}
	}
	if !layout || index == nil {
		return refuse(path, "not an OCI archive: no oci-layout or index.json")
	}
	var ix struct {
		Manifests []struct {
			Digest string `json:"digest"`
		} `json:"manifests"`
	}
	if err := json.Unmarshal(index, &ix); err != nil {
		return refuse(path, "index.json: %v", err)
	}
	for _, d := range ix.Manifests {
		if d.Digest == m[1] {
			return nil
		}
	}
	return refuse(path, "its index.json does not list %s, the digest %s is pinned to", m[1], ref)
}

func copyHashed(src, dst string) (string, error) {
	in, err := os.Open(src) //nolint:gosec // G304: an input the release job names
	if err != nil {
		return "", err
	}
	defer func() { _ = in.Close() }()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644) //nolint:gosec // G302,G304: the new bundle directory
	if err != nil {
		return "", err
	}
	h := sha256.New()
	_, err = io.Copy(io.MultiWriter(out, h), in)
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	return hex.EncodeToString(h.Sum(nil)), err
}
