// Package kit is the microVM kit (docs/runtime/isolation-architecture.md,
// "Is the self-hosted image different?"): firecracker and the jailer, the
// pinned guest kernel and the base root file systems, as one signed OCI
// artifact the cell pulls by digest, laid out on disk as
//
//	manifest.json          what is in the kit, each file by size and sha256
//	bin/firecracker        bin/jailer
//	kernel/vmlinux         kernel/config
//	rootfs/sandbox.ext4    rootfs/environment.ext4
//
// The cell is given the manifest's digest. Load refuses a kit whose
// manifest is not that digest, a file whose bytes are not the manifest's,
// a path that leaves the kit, and a kit of another architecture: what
// boots a machine is exactly what was signed.
package kit

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// ManifestName is the manifest's file in the kit.
const ManifestName = "manifest.json"

// SchemaVersion is the manifest format this cell reads.
const SchemaVersion = 1

// maxManifest bounds the manifest file.
const maxManifest = 1 << 20

// File is one file of the kit.
type File struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}

// Rootfs is one base root file system: a profile of internal/guestinit.
type Rootfs struct {
	File
	// NestedDocker: the image ships Docker (an environment's base).
	NestedDocker bool `json:"nestedDocker"`
}

// Manifest says what the kit holds.
type Manifest struct {
	SchemaVersion int    `json:"schemaVersion"`
	Arch          string `json:"arch"`
	// FirecrackerVersion is the release firecracker and the jailer come
	// from (the jailer must be the same release).
	FirecrackerVersion string `json:"firecrackerVersion"`
	Firecracker        File   `json:"firecracker"`
	Jailer             File   `json:"jailer"`
	KernelVersion      string `json:"kernelVersion"`
	Kernel             File   `json:"kernel"`
	KernelConfig       File   `json:"kernelConfig"`
	// Rootfs maps a profile name (sandbox, environment) to its image.
	Rootfs map[string]Rootfs `json:"rootfs"`
}

// Kit is a verified kit: absolute paths of files whose bytes matched.
type Kit struct {
	Dir      string
	Digest   string
	Manifest Manifest
}

// Path is the absolute path of a kit file.
func (k *Kit) Path(f File) string { return filepath.Join(k.Dir, filepath.FromSlash(f.Path)) }

// NestedDocker reports whether the kit has an environment base with Docker.
func (k *Kit) NestedDocker() bool {
	r, ok := k.Manifest.Rootfs["environment"]
	return ok && r.NestedDocker
}

var (
	digestRE  = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
	hexRE     = regexp.MustCompile(`^[0-9a-f]{64}$`)
	versionRE = regexp.MustCompile(`^v?[0-9]+\.[0-9]+(\.[0-9]+)?$`)
)

// Error is a kit the cell refuses, naming what is wrong.
type Error struct{ Reason string }

func (e *Error) Error() string { return "kit: " + e.Reason }

func refuse(format string, a ...any) error { return &Error{Reason: fmt.Sprintf(format, a...)} }

// Load reads and verifies the kit in dir against the manifest digest the
// cell was given, for the host's arch ("x86_64", "arm64").
func Load(dir, digest, arch string) (*Kit, error) {
	if !digestRE.MatchString(digest) {
		return nil, refuse("the kit digest %q is not sha256:<64 hex>", digest)
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		return nil, refuse("no kit at %s: %v", dir, err)
	}
	defer func() { _ = root.Close() }()
	raw, err := readSmall(root, ManifestName)
	if err != nil {
		return nil, refuse("%s: %v", ManifestName, err)
	}
	sum := sha256.Sum256(raw)
	if got := "sha256:" + hex.EncodeToString(sum[:]); got != digest {
		return nil, refuse("%s is %s, not the pinned %s", ManifestName, got, digest)
	}
	var m Manifest
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&m); err != nil {
		return nil, refuse("%s: %v", ManifestName, err)
	}
	if err := m.Validate(); err != nil {
		return nil, err
	}
	if m.Arch != arch {
		return nil, refuse("the kit is for %s, this host is %s", m.Arch, arch)
	}
	for _, f := range m.files() {
		if err := verify(root, f); err != nil {
			return nil, err
		}
	}
	abs, err := filepath.Abs(dir)
	if err != nil {
		return nil, err
	}
	return &Kit{Dir: abs, Digest: digest, Manifest: m}, nil
}

// files is every file of the manifest, in a fixed order.
func (m Manifest) files() []File {
	fs := []File{m.Firecracker, m.Jailer, m.Kernel, m.KernelConfig}
	names := make([]string, 0, len(m.Rootfs))
	for n := range m.Rootfs {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		fs = append(fs, m.Rootfs[n].File)
	}
	return fs
}

// Validate checks the manifest's shape: versions, paths inside the kit,
// digests, and a sandbox base at least.
func (m Manifest) Validate() error {
	if m.SchemaVersion != SchemaVersion {
		return refuse("manifest schema %d; this cell reads %d", m.SchemaVersion, SchemaVersion)
	}
	if m.Arch != "x86_64" && m.Arch != "arm64" {
		return refuse("arch %q", m.Arch)
	}
	if !versionRE.MatchString(m.FirecrackerVersion) || !versionRE.MatchString(m.KernelVersion) {
		return refuse("versions %q and %q", m.FirecrackerVersion, m.KernelVersion)
	}
	if _, ok := m.Rootfs["sandbox"]; !ok {
		return refuse("no sandbox rootfs")
	}
	for name := range m.Rootfs {
		if name != "sandbox" && name != "environment" {
			return refuse("rootfs profile %q", name)
		}
	}
	if r, ok := m.Rootfs["sandbox"]; ok && r.NestedDocker {
		return refuse("the sandbox base cannot ship Docker")
	}
	seen := map[string]bool{}
	for _, f := range m.files() {
		if err := checkPath(f.Path); err != nil {
			return err
		}
		if seen[f.Path] {
			return refuse("%s is listed twice", f.Path)
		}
		seen[f.Path] = true
		if !hexRE.MatchString(f.SHA256) || f.Size <= 0 {
			return refuse("%s has no sha256 or size", f.Path)
		}
	}
	return nil
}

func checkPath(p string) error {
	if p == "" || strings.HasPrefix(p, "/") || path.Clean(p) != p || p == ManifestName || strings.HasPrefix(p, "../") || p == ".." {
		return refuse("path %q is not a plain path inside the kit", p)
	}
	return nil
}

func readSmall(root *os.Root, name string) ([]byte, error) {
	f, err := root.Open(name)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	b, err := io.ReadAll(io.LimitReader(f, maxManifest+1))
	if err != nil {
		return nil, err
	}
	if len(b) > maxManifest {
		return nil, errors.New("too large")
	}
	return b, nil
}

// verify hashes a kit file through the root, so a link cannot take it out.
func verify(root *os.Root, f File) error {
	fi, err := root.Lstat(filepath.FromSlash(f.Path))
	if err != nil {
		return refuse("%s: %v", f.Path, err)
	}
	if !fi.Mode().IsRegular() {
		return refuse("%s is not a regular file", f.Path)
	}
	if fi.Size() != f.Size {
		return refuse("%s is %d bytes, the manifest says %d", f.Path, fi.Size(), f.Size)
	}
	h, err := hashFile(root, f.Path)
	if err != nil {
		return refuse("%s: %v", f.Path, err)
	}
	if h != f.SHA256 {
		return refuse("%s is sha256 %s, the manifest says %s", f.Path, h, f.SHA256)
	}
	return nil
}

func hashFile(root *os.Root, p string) (string, error) {
	r, err := root.Open(filepath.FromSlash(p))
	if err != nil {
		return "", err
	}
	defer func() { _ = r.Close() }()
	h := sha256.New()
	if _, err := io.Copy(h, r); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// Layout is where Make finds each file of a kit being built.
var Layout = struct {
	Firecracker, Jailer, Kernel, KernelConfig string
	Rootfs                                    map[string]string
}{
	Firecracker: "bin/firecracker", Jailer: "bin/jailer", Kernel: "kernel/vmlinux", KernelConfig: "kernel/config",
	Rootfs: map[string]string{"sandbox": "rootfs/sandbox.ext4", "environment": "rootfs/environment.ext4"},
}

// Make writes the manifest of the kit laid out in dir (Layout; the
// environment base is optional) and returns its digest, the value the
// cell pins.
func Make(dir, arch, firecrackerVersion, kernelVersion string) (string, error) {
	root, err := os.OpenRoot(dir)
	if err != nil {
		return "", err
	}
	defer func() { _ = root.Close() }()
	file := func(p string) (File, error) {
		fi, err := root.Lstat(filepath.FromSlash(p))
		if err != nil {
			return File{}, err
		}
		h, err := hashFile(root, p)
		return File{Path: p, SHA256: h, Size: fi.Size()}, err
	}
	m := Manifest{SchemaVersion: SchemaVersion, Arch: arch, FirecrackerVersion: firecrackerVersion, KernelVersion: kernelVersion, Rootfs: map[string]Rootfs{}}
	for p, dst := range map[string]*File{Layout.Firecracker: &m.Firecracker, Layout.Jailer: &m.Jailer, Layout.Kernel: &m.Kernel, Layout.KernelConfig: &m.KernelConfig} {
		if *dst, err = file(p); err != nil {
			return "", err
		}
	}
	for name, p := range Layout.Rootfs {
		f, err := file(p)
		if errors.Is(err, os.ErrNotExist) && name == "environment" {
			continue
		}
		if err != nil {
			return "", err
		}
		m.Rootfs[name] = Rootfs{File: f, NestedDocker: name == "environment"}
	}
	if err := m.Validate(); err != nil {
		return "", err
	}
	raw, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return "", err
	}
	raw = append(raw, '\n')
	if err := root.WriteFile(ManifestName, raw, 0o644); err != nil {
		return "", err
	}
	sum := sha256.Sum256(raw)
	return "sha256:" + hex.EncodeToString(sum[:]), nil
}
