package dockercli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/netip"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
)

// The registry path of a build (docker-gvisor -gvisor-image-transfer
// registry): BuildKit pushes the image to a registry container the cell runs
// for that build, and this Docker pulls it by digest. A registry skips the
// blobs it already has and Docker the layers it already has, so a build whose
// only change is its last layer moves that layer, not the whole image twice
// (the tarball: BuildKit writes every layer into it, docker load reads every
// layer back). dockergvisor/registry.go has the security model.

// BuildPush is where RunBuild pushes the image instead of writing a tarball:
// Registry is host:port on the claim network (plain HTTP), Repo and Tag the
// name there. RunBuild also writes BuildKit's metadata file (BuildMetadata)
// into Out, which names the pushed manifest's digest.
type BuildPush struct {
	Registry, Repo, Tag string
}

// BuildMetadata is where RunBuild leaves buildctl's metadata file, inside Out.
const BuildMetadata = "metadata.json"

var (
	// registryRepo is a distribution repository name (lowercase components).
	registryRepo = regexp.MustCompile(`^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*){0,3}$`)
	registryTag  = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$`)
	// ManifestDigest is the only digest form the cell pulls by.
	ManifestDigest = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)
)

func (p BuildPush) check() error {
	if !mirrorHostPort.MatchString(p.Registry) || len(p.Repo) > 200 || !registryRepo.MatchString(p.Repo) || !registryTag.MatchString(p.Tag) {
		return fmt.Errorf("dockercli: push target %q/%q:%q is not a registry, repository and tag", p.Registry, p.Repo, p.Tag)
	}
	return nil
}

// pushOutput is the build's --output for a push: an OCI manifest and
// uncompressed layers (as the tarball's: they stay on the cell's disk, and
// gzip under the sandbox costs minutes), pushed over plain HTTP.
func (p BuildPush) pushOutput() string {
	return "type=image,name=" + p.Registry + "/" + p.Repo + ":" + p.Tag + ",push=true,registry.insecure=true,oci-mediatypes=true,compression=uncompressed"
}

// buildkitdHTTPRegistry lets BuildKit push to the registry over plain HTTP.
func buildkitdHTTPRegistry(hostPort string) []byte {
	return []byte(fmt.Sprintf("\n[registry.%q]\n  http = true\n", hostPort))
}

// maxMetadataBytes bounds the metadata file the builder leaves.
const maxMetadataBytes = 64 << 10

// BuiltDigest is the manifest digest the build pushed, from the metadata
// file it left in out. The builder writes that file, so it is read as
// untrusted: a regular file (never a link), bounded, one digest of the one
// form the cell pulls by. driver.ErrImageLoad otherwise.
func BuiltDigest(out string) (string, error) {
	p := filepath.Join(out, BuildMetadata)
	info, err := os.Lstat(p)
	if err != nil {
		return "", fmt.Errorf("%w: build metadata: %w", driver.ErrImageLoad, err)
	}
	if !info.Mode().IsRegular() || info.Size() > maxMetadataBytes {
		return "", fmt.Errorf("%w: build metadata is not a regular file of at most %d bytes", driver.ErrImageLoad, maxMetadataBytes)
	}
	f, err := OpenNoFollow(p)
	if err != nil {
		return "", fmt.Errorf("%w: build metadata: %w", driver.ErrImageLoad, err)
	}
	defer func() { _ = f.Close() }()
	raw, err := io.ReadAll(io.LimitReader(f, maxMetadataBytes+1))
	if err != nil || len(raw) > maxMetadataBytes {
		return "", fmt.Errorf("%w: build metadata unreadable", driver.ErrImageLoad)
	}
	var m struct {
		Digest string `json:"containerimage.digest"`
	}
	if err := json.Unmarshal(raw, &m); err != nil {
		return "", fmt.Errorf("%w: build metadata: %w", driver.ErrImageLoad, err)
	}
	if !ManifestDigest.MatchString(m.Digest) {
		return "", fmt.Errorf("%w: build metadata names no sha256 manifest digest", driver.ErrImageLoad)
	}
	return m.Digest, nil
}

// RegistrySpec is the registry container of one build: on Network (the
// cell's registry network, which only the host reaches) and on ClaimNetwork
// at ClaimIP (where the build pushes), its storage at StorageDir, as User,
// under Runtime and the claim's CgroupParent.
type RegistrySpec struct {
	Name, Image, Runtime, Network string
	// ClaimNetwork and ClaimIP are joined before the registry starts: gVisor
	// sets a sandbox's interfaces up at start and takes no network later.
	ClaimNetwork, ClaimIP string
	StorageDir            string
	// User is "uid:gid", the owner of StorageDir.
	User         string
	CgroupParent string
	MemLimit     string
	Labels       map[string]string
}

// DefaultRegistryMemory is a build registry's memory ceiling. The registry
// itself holds little (about 20 MB of its own on the dev cell); what fills its
// cgroup is the host page cache of the blobs a push writes, charged to it
// until written back. At 256m a cold push of a Next.js image's layers was
// killed by the kernel mid-push (dev cell, 2026-11-13 13:45:15: file 239 MB of
// a 256 MiB limit), and the build failed on "connection
// refused". Page cache is reclaimable once written: a higher ceiling costs the
// host no memory it could not take back.
const DefaultRegistryMemory = "1g"

// RegistryPort is where a registry container serves.
const RegistryPort = 5000

var registryUser = regexp.MustCompile(`^[1-9][0-9]{0,9}:[1-9][0-9]{0,9}$`)

// RunRegistry starts a distribution registry, on the claim network before it
// starts (RegistrySpec.ClaimNetwork): no capability, a read-only
// root and no new privileges, deletes refused (a client can add blobs and
// manifests, never remove or replace one: both are content-addressed), and
// its storage the one directory it writes.
func (c CLI) RunRegistry(ctx context.Context, s RegistrySpec) (Container, error) {
	if err := ValidateCgroupParent(s.CgroupParent); err != nil {
		return Container{}, err
	}
	if !registryUser.MatchString(s.User) {
		return Container{}, fmt.Errorf("dockercli: registry user %q is not uid:gid (not root)", s.User)
	}
	if s.ClaimNetwork == "" {
		return Container{}, errors.New("dockercli: a registry needs the claim network its build pushes on")
	}
	if ip, err := netip.ParseAddr(s.ClaimIP); err != nil || !ip.Is4() {
		return Container{}, fmt.Errorf("dockercli: registry address %q is not an IPv4 address", s.ClaimIP)
	}
	mem := s.MemLimit
	if mem == "" {
		mem = DefaultRegistryMemory
	}
	args := []string{
		"create", "--name", s.Name, "--runtime", s.Runtime, "--network", s.Network,
		"--user", s.User, "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only", "--tmpfs", "/tmp:size=64m",
		"--pids-limit", "256", "--memory", mem,
		"-e", "REGISTRY_STORAGE_DELETE_ENABLED=false", "-e", "REGISTRY_HTTP_ADDR=0.0.0.0:" + strconv.Itoa(RegistryPort),
		"-e", "REGISTRY_LOG_LEVEL=warn", "-e", "OTEL_TRACES_EXPORTER=none",
		"-v", s.StorageDir + ":/var/lib/registry",
	}
	if s.CgroupParent != "" {
		args = append(args, "--cgroup-parent", s.CgroupParent)
	}
	args = append(args, labelArgs(s.Labels)...)
	args = append(args, s.Image)
	out, err := c.run(ctx, nil, args...)
	if err != nil {
		return Container{}, err
	}
	id := strings.TrimSpace(string(out))
	if _, err = c.run(ctx, nil, "network", "connect", "--ip", s.ClaimIP, s.ClaimNetwork, id); err == nil {
		_, err = c.run(ctx, nil, "start", id)
	}
	if err != nil {
		_, rerr := c.run(context.WithoutCancel(ctx), nil, "rm", "-f", id)
		return Container{}, errors.Join(err, rerr)
	}
	cs, err := c.Inspect(ctx, id)
	if err != nil {
		_ = c.Remove(context.WithoutCancel(ctx), s.Name)
		return Container{}, err
	}
	if len(cs) != 1 {
		_ = c.Remove(context.WithoutCancel(ctx), s.Name)
		return Container{}, errors.New("dockercli: registry container not found after run")
	}
	return cs[0], nil
}

// PullImage pulls one image by digest (repo@sha256:...); a reference by tag
// is refused, so what is pulled is exactly what the build pushed.
func (c CLI) PullImage(ctx context.Context, ref string) error {
	_, digest, ok := strings.Cut(ref, "@")
	if !ok || !ManifestDigest.MatchString(digest) {
		return fmt.Errorf("dockercli: pull %q is not by sha256 digest", ref)
	}
	if _, err := c.run(ctx, nil, "pull", "-q", ref); err != nil {
		return fmt.Errorf("%w: %w", driver.ErrImageLoad, err)
	}
	return nil
}

// UntagImage removes one reference of an image, never the image another
// reference still names.
func (c CLI) UntagImage(ctx context.Context, ref string) error {
	_, err := c.run(ctx, nil, "image", "rm", ref)
	if NoSuchImage(err) {
		return nil
	}
	return err
}
