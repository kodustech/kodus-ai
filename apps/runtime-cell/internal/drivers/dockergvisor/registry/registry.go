// Package registry is docker-gvisor's registry image transfer: BuildKit
// pushes a build's image to a registry container the cell runs for that one
// build, and this Docker pulls it by the digest the build reported. The
// registry skips the blobs it has, Docker the layers it has: what moves is
// what changed. A build that does not seed and finds the environment's
// registry never seeded gets ErrUnseeded (the driver sends a tarball).
//
// Security model. The builder is untrusted: its RUN steps are the pull
// request's code, and BuildKit runs them in its own PID namespace (no process
// sandbox), so whatever the builder can reach, the pull request can.
//
//   - Reach. The registry is one container per build, on two networks: the
//     claim's own (at a fixed address, registryHost), where only that
//     claim's builder is, for the length of the build; and the cell's
//     registry network, internal, with the host on it and no traffic
//     between its containers, where only the cell dials it. It has no way
//     out (both networks are internal), and no other claim reaches it. It is
//     removed once its image is pulled.
//   - Storage, per environment. A build that seeds (the default branch's
//     setup) pushes into the environment's seed storage. Any other build (a
//     pull request, a base that is not a setup) gets storage of its own: a
//     fresh directory where the cell links the seed's sealed blobs (made the
//     cell's, read-only, once the seeding build is pulled) and names them in
//     the build's repository, so its push skips them. It can read the
//     default branch's layers, as it already reads the environment's
//     BuildKit state; it never sees another pull request's, and nothing it
//     writes outlives its build.
//   - Integrity. The registry refuses deletes; blobs and manifests are
//     content-addressed. The cell pulls by digest only (never by tag), the
//     digest from the build's metadata file, read as untrusted (a regular
//     file, bounded, one sha256 digest). Docker checks every blob it pulls
//     against its digest, so a registry that served other bytes (even one
//     the build took over) fails the pull: it never changes what boots.
//     Pulled by digest, the image carries no name of its own: unlike a
//     tarball, it cannot replace another image on the host.
//   - Size. What a build adds to its storage is bounded by the cell's image
//     bound (Pull's maxBytes, driver.ErrImageTooLarge); the seed storage is
//     wiped when it passes Config.KeepBytes, with no build holding it (a
//     cache: the next seeding build pushes again).
//   - Privileges. The registry runs under the cell's runtime (runsc), as the
//     builder's uid, with no capability, no new privileges and a read-only
//     root; its storage is the one directory it writes.
//   - The pull. Docker pulls plain HTTP only from loopback, so the cell
//     forwards a loopback port of its own to the registry for the pull and
//     closes it after. The cell and Docker share the host's network
//     namespace (as the cell already does to reach the observers).
package registry

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
)

// ErrUnseeded is a build that would not seed the environment's registry and
// finds no sealed blob of a seed to link: the registry was never seeded (no
// setup of the default branch pushed into it yet), or its seed was wiped past
// its bound, or a seeding build is still writing it. Its push would carry the
// whole image, and a pull request against an empty registry measured worse
// than the tarball (docs/runtime/measurements-2026-11-11.md), so the build
// sends a tarball instead; the registry stays the transfer of every build that
// seeds and of every build a seed serves.
var ErrUnseeded = errors.New("dockergvisor: the environment's registry was never seeded")

// Docker is what the registry transfer runs on this Docker.
type Docker interface {
	RunRegistry(ctx context.Context, s dockercli.RegistrySpec) (dockercli.Container, error)
	PullImage(ctx context.Context, ref string) error
	TagImage(ctx context.Context, src, dst string) error
	UntagImage(ctx context.Context, ref string) error
	Remove(ctx context.Context, name string) error
}

// HostDirs is how the cell owns the host directories a registry writes.
type HostDirs interface {
	// BuilderDir makes p a directory of the builder's alone.
	BuilderDir(p string) error
	// Builder is the builder's host uid and gid; Self the cell's uid.
	Builder() (uid, gid int)
	Self() int
	// Chown gives path to uid and gid, never through a link.
	Chown(path string, uid, gid int) error
	// Owner is the uid that owns info; false when unknown.
	Owner(info fs.FileInfo) (int, bool)
}

// Config is what the cell's registries run with.
type Config struct {
	CellID string
	// Image is the distribution registry's image, Runtime the runtime it
	// runs under.
	Image, Runtime string
	// Root holds every storage: <env>/seed, claims/, wiped/.
	Root string
	// KeepBytes bounds an environment's seed storage.
	KeepBytes int64
	// EnvKey names an environment's seed storage under Root.
	EnvKey func(org, env string) string
	Docker Docker
	Dirs   HostDirs
	// Network makes the cell's registry network (host-only) and names it.
	Network func(ctx context.Context) (string, error)
	// Parent is the cgroup parent of a claim's containers.
	Parent func(ctx context.Context, ref driver.MachineRef) (string, error)
	// Dial dials a registry from the host.
	Dial func(ctx context.Context, network, addr string) (net.Conn, error)
	Now  func() time.Time
	Log  func() *slog.Logger
}

// Registries runs the builds' registries of one cell and counts the builds
// on each environment's seed storage.
type Registries struct {
	cfg Config
	mu  sync.Mutex
	// holds counts the builds on each environment's seed storage.
	holds map[string]int
	hooks hooks
}

// hooks are the seams only tests set; nil in production.
type hooks struct {
	// seedWiping and seedLinking run right before a seed storage is removed
	// and right before a seed blob is linked: where another build or a
	// swapped path may interleave.
	seedWiping  func()
	seedLinking func(path string)
}

// New is the registries of a cell on cfg.
func New(cfg Config) *Registries {
	return &Registries{cfg: cfg, holds: map[string]int{}}
}

func (s *Registries) log() *slog.Logger { return s.cfg.Log() }

// Clear removes what a cell that stopped left: a build's own storage is
// nothing's, nor is a seed it was wiping. No build may run.
func (s *Registries) Clear() error {
	for _, left := range []string{filepath.Join(s.cfg.Root, "claims"), s.wiped()} {
		if err := os.RemoveAll(left); err != nil {
			return err
		}
	}
	return nil
}

// registryHost is the registry's fixed address in the claim subnet, next to
// the builder's and below the services'.
const registryHost = 8

func registryAddress(subnet netip.Prefix) netip.Addr {
	a := subnet.Masked().Addr()
	for range registryHost {
		a = a.Next()
	}
	return a
}

// Registry is the registry of one build.
type Registry struct {
	s          *Registries
	name       string
	claimAddr  string // where the builder pushes
	hostAddr   string // where the cell dials, on the registry network
	dir        string // what the registry writes
	seed       bool   // dir is the environment's seed storage
	envKey     string
	repo, tag  string
	before     int64
	wipe       bool
	release    func()
	started    bool
	stopped    bool
	linkedSeed int
}

// Push is where the build pushes its image.
func (r *Registry) Push() *dockercli.BuildPush {
	return &dockercli.BuildPush{Registry: net.JoinHostPort(r.claimAddr, strconv.Itoa(dockercli.RegistryPort)), Repo: r.repo, Tag: r.tag}
}

// Discard keeps what the build pushed out of the seed: Stop wipes it.
func (r *Registry) Discard() { r.wipe = true }

// Pushed is what the build added to its storage so far, in bytes; past
// MaxStorageEntries it fails with an EntriesError.
func (r *Registry) Pushed() (int64, error) {
	size, err := TreeBytes(r.dir, "registry storage", MaxStorageEntries)
	return size - r.before, err
}

// Start runs the build's registry on its storage and waits until it
// answers. seeds: the build writes the environment's seed storage.
func (s *Registries) Start(ctx context.Context, ref driver.MachineRef, service, network string, subnet netip.Prefix, seeds bool) (*Registry, error) {
	if s.cfg.Image == "" {
		return nil, errors.New("dockergvisor: the registry image transfer needs a registry image (-gvisor-registry-image)")
	}
	key := s.cfg.EnvKey(ref.Tags[driver.TagOrg], ref.Tags[driver.TagEnv])
	seedDir := filepath.Join(s.cfg.Root, key, "seed")
	r := &Registry{
		s: s, seed: seeds, envKey: key, repo: Repo(service), tag: registryTag(ref.MachineID),
		name: "kodus-registry-" + strconv.FormatInt(s.cfg.Now().UnixNano(), 36),
	}
	r.release = s.hold(key, seedDir)
	fail := func(err error) (*Registry, error) {
		r.Stop(context.WithoutCancel(ctx))
		return nil, fmt.Errorf("%w: image registry: %w", driver.ErrImageLoad, err)
	}
	if seeds {
		r.dir = seedDir
		if err := s.cfg.Dirs.BuilderDir(r.dir); err != nil {
			return fail(err)
		}
	} else {
		r.dir = filepath.Join(s.cfg.Root, "claims", ref.MachineID+"-"+shortHash(service))
		if err := os.RemoveAll(r.dir); err != nil {
			return fail(err)
		}
		if err := s.cfg.Dirs.BuilderDir(r.dir); err != nil {
			return fail(err)
		}
		n, err := s.linkSeed(seedDir, r.dir, r.repo)
		if err != nil {
			s.log().Warn("build.registry.seed_link_failed", "machine", ref.MachineID, "service", service, "err", err)
		}
		r.linkedSeed = n
		if n == 0 {
			// Nothing to skip: the push would carry the whole image.
			r.Stop(context.WithoutCancel(ctx))
			return nil, ErrUnseeded
		}
	}
	size, err := storageSize(r.dir)
	if err != nil {
		return fail(err)
	}
	r.before = size
	regNet, err := s.cfg.Network(ctx)
	if err != nil {
		return fail(err)
	}
	parent, err := s.cfg.Parent(ctx, ref)
	if err != nil {
		return fail(err)
	}
	r.claimAddr = registryAddress(subnet).String()
	uid, gid := s.cfg.Dirs.Builder()
	c, err := s.cfg.Docker.RunRegistry(ctx, dockercli.RegistrySpec{
		Name: r.name, Image: s.cfg.Image, Runtime: s.cfg.Runtime, Network: regNet, ClaimNetwork: network, ClaimIP: r.claimAddr, StorageDir: r.dir,
		User: strconv.Itoa(uid) + ":" + strconv.Itoa(gid), CgroupParent: parent,
		Labels: toLabels(map[string]string{driver.TagCell: s.cfg.CellID, driver.TagClaim: ref.Tags[driver.TagClaim], driver.TagHardExpires: ref.Tags[driver.TagHardExpires]}),
	})
	if err != nil {
		return fail(err)
	}
	r.started = true
	if r.hostAddr = c.Networks[regNet]; r.hostAddr == "" {
		return fail(fmt.Errorf("the registry has no address on %s", regNet))
	}
	if err := s.waitRegistry(ctx, r.hostAddr); err != nil {
		return fail(err)
	}
	s.log().Info("build.registry.ready", "machine", ref.MachineID, "service", service, "seed", seeds, "linkedBlobs", r.linkedSeed, "storageBytes", r.before)
	return r, nil
}

func toLabels(tags map[string]string) map[string]string {
	out := make(map[string]string, len(tags))
	for k, v := range tags {
		out[dockercli.LabelFromTag(k)] = v
	}
	return out
}

// Pull takes the image the build pushed into this Docker as tag, by the
// digest of the build's metadata file in out, and returns what the build
// added to its storage, in bytes; past maxBytes it is refused.
func (r *Registry) Pull(ctx context.Context, out, tag string, maxBytes int64) (int64, error) {
	s := r.s
	digest, err := dockercli.BuiltDigest(out)
	if err != nil {
		return 0, err
	}
	after, err := storageSize(r.dir)
	if err != nil {
		r.wipe = true
		return 0, err
	}
	added := max(after-r.before, 0)
	if added > maxBytes {
		r.wipe = true
		return added, fmt.Errorf("%w: the build pushed %d bytes, over %d", driver.ErrImageTooLarge, added, maxBytes)
	}
	local, stop, err := s.forward(ctx, net.JoinHostPort(r.hostAddr, strconv.Itoa(dockercli.RegistryPort)))
	if err != nil {
		return added, fmt.Errorf("%w: image registry: %w", driver.ErrImageLoad, err)
	}
	defer stop()
	src := local + "/" + r.repo + "@" + digest
	if err := s.cfg.Docker.PullImage(ctx, src); err != nil {
		return added, err
	}
	if err := s.cfg.Docker.TagImage(ctx, src, tag); err != nil {
		return added, fmt.Errorf("%w: %w", driver.ErrImageLoad, err)
	}
	// The pull's own name (a loopback port that is gone) is not kept.
	if err := s.cfg.Docker.UntagImage(context.WithoutCancel(ctx), src); err != nil {
		s.log().Warn("build.registry.untag_failed", "ref", src, "err", err)
	}
	return added, nil
}

// Stop removes the registry container and settles its storage: a seed is
// sealed (or wiped past its bound), a build's own is removed.
func (r *Registry) Stop(ctx context.Context) {
	if r.stopped {
		return
	}
	r.stopped = true
	s := r.s
	defer r.release()
	if r.started {
		rctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
		err := s.cfg.Docker.Remove(rctx, r.name)
		cancel()
		if err != nil {
			s.log().Warn("build.registry.remove_failed", "name", r.name, "err", err)
		}
	}
	if r.dir == "" {
		return
	}
	if !r.seed {
		if err := os.RemoveAll(r.dir); err != nil {
			s.log().Warn("build.registry.storage_remove_failed", "err", err)
		}
		return
	}
	if !r.wipe {
		sealed, err := s.sealSeed(r.dir)
		if err != nil {
			s.log().Warn("build.registry.seal_failed", "err", err)
			r.wipe = true
		} else {
			s.log().Info("build.registry.sealed", "blobs", sealed)
		}
	}
	if size, err := storageSize(r.dir); r.wipe || err != nil || size > s.cfg.KeepBytes {
		s.wipeSeed(r.envKey, r.dir)
	}
}

// hold counts a build on an environment's seed storage until the returned
// release. The first holder wipes a seed past its bound.
func (s *Registries) hold(key, seedDir string) func() {
	s.mu.Lock()
	first := s.holds[key] == 0
	s.holds[key]++
	s.mu.Unlock()
	if first {
		if size, err := storageSize(seedDir); err != nil || size > s.cfg.KeepBytes {
			s.log().Info("build.registry.seed_past_bound", "bytes", size, "keepBytes", s.cfg.KeepBytes, "err", err)
			s.wipeSeed(key, seedDir)
		}
	}
	var once sync.Once
	return func() {
		once.Do(func() {
			s.mu.Lock()
			if s.holds[key]--; s.holds[key] <= 0 {
				delete(s.holds, key)
			}
			s.mu.Unlock()
		})
	}
}

// wipeSeed removes a seed storage no other build holds (the caller holds it).
// Whether another holds it and taking the storage away happen under one lock:
// the storage is moved aside there (a rename), so a build that holds it after
// finds none and makes a fresh one, and what was moved is removed after,
// outside the lock (a large seed takes a while).
func (s *Registries) wipeSeed(key, dir string) {
	s.mu.Lock()
	var moved string
	var err error
	if s.holds[key] <= 1 {
		moved, err = s.moveAside(dir)
	}
	s.mu.Unlock()
	if err != nil {
		s.log().Warn("build.registry.seed_wipe_failed", "err", err)
		return
	}
	if moved == "" {
		return
	}
	if s.hooks.seedWiping != nil {
		s.hooks.seedWiping()
	}
	if err := os.RemoveAll(moved); err != nil {
		s.log().Warn("build.registry.seed_wipe_failed", "err", err)
		return
	}
	s.log().Info("build.registry.seed_wiped")
}

// wiped is where wipeSeed moves a seed before removing it: in the registry
// root, so on its filesystem, and removed whole when the cell starts (a cell
// that stopped mid-wipe leaves one).
func (s *Registries) wiped() string { return filepath.Join(s.cfg.Root, "wiped") }

// moveAside moves dir into a directory of its own under wiped and returns
// that directory; "" when there is no dir.
func (s *Registries) moveAside(dir string) (string, error) {
	if err := os.MkdirAll(s.wiped(), 0o700); err != nil {
		return "", err
	}
	tomb, err := os.MkdirTemp(s.wiped(), "seed-")
	if err != nil {
		return "", err
	}
	moved := filepath.Join(tomb, "seed")
	if err := os.Rename(dir, moved); err != nil {
		_ = os.Remove(tomb)
		if errors.Is(err, fs.ErrNotExist) {
			return "", nil
		}
		return "", err
	}
	return tomb, nil
}

// V2 is the registry's filesystem layout (distribution's storage driver).
const V2 = "docker/registry/v2"

var hexDigest = regexp.MustCompile(`^[a-f0-9]{64}$`)

// sealSeed makes every blob of a seed storage the cell's and read-only, so
// a later build's registry, which runs as the builder's uid, can read a
// link to it but never change it. It never follows a link.
func (s *Registries) sealSeed(dir string) (int, error) {
	n := 0
	err := walkBlobs(dir, func(path, _ string, info fs.FileInfo) error {
		f, err := dockercli.OpenNoFollow(path)
		if err != nil {
			return err
		}
		defer func() { _ = f.Close() }() // read-only: Chown and Chmod act on the fd
		if st, err := f.Stat(); err != nil || !os.SameFile(st, info) {
			return fmt.Errorf("blob %s changed while sealed", filepath.Base(filepath.Dir(path)))
		}
		// The group stays: 0444 leaves it nothing to write.
		if err := f.Chown(s.cfg.Dirs.Self(), -1); err != nil {
			return err
		}
		if err := f.Chmod(0o444); err != nil {
			return err
		}
		n++
		return nil
	})
	return n, err
}

// linkSeed gives a build's own storage every sealed blob of the seed: a
// hard link to it, and a link in the build's repository, so its push finds
// the blob there and skips it. A blob the cell has not sealed (a seeding
// build may be writing it) is left out.
//
// The seed's directories are the builder's (its registry wrote them), so any
// of them may turn into a link between the walk and the hard link, which
// follows links in the path above the file. A blob is linked only through
// real directories, and only when what was linked is the very file the walk
// checked; anything else is unlinked and left out.
func (s *Registries) linkSeed(seedDir, dir, repo string) (int, error) {
	n := 0
	dirs := s.cfg.Dirs
	err := walkBlobs(seedDir, func(path, sum string, info fs.FileInfo) error {
		if uid, ok := dirs.Owner(info); !ok || uid != dirs.Self() || info.Mode().Perm()&0o222 != 0 {
			return nil
		}
		if !realDirsTo(seedDir, filepath.Dir(path)) {
			return nil
		}
		blobDir := filepath.Join(dir, V2, "blobs", "sha256", sum[:2], sum)
		layer := filepath.Join(dir, V2, "repositories", filepath.FromSlash(repo), "_layers", "sha256", sum)
		if err := s.builderTree(dir, blobDir, layer); err != nil {
			return err
		}
		if s.hooks.seedLinking != nil {
			s.hooks.seedLinking(path)
		}
		data := filepath.Join(blobDir, "data")
		if err := os.Link(path, data); err != nil {
			return err
		}
		if linked, err := os.Lstat(data); err != nil || !os.SameFile(linked, info) {
			if rmErr := os.Remove(data); rmErr != nil {
				return errors.Join(fmt.Errorf("blob %s changed while linked", sum[:12]), rmErr)
			}
			s.log().Warn("build.registry.seed_blob_changed", "blob", sum[:12])
			return nil
		}
		link := filepath.Join(layer, "link")
		if err := os.WriteFile(link, []byte("sha256:"+sum), 0o600); err != nil {
			return err
		}
		uid, gid := dirs.Builder()
		if err := dirs.Chown(link, uid, gid); err != nil {
			return err
		}
		n++
		return nil
	})
	return n, err
}

// realDirsTo reports whether every directory from root down to dir is a real
// one, never a link (Lstat, nothing followed).
func realDirsTo(root, dir string) bool {
	rel, err := filepath.Rel(root, dir)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return false
	}
	p := root
	for _, part := range append([]string{"."}, strings.Split(rel, string(filepath.Separator))...) {
		p = filepath.Join(p, part)
		if info, err := os.Lstat(p); err != nil || !info.IsDir() {
			return false
		}
	}
	return true
}

// builderTree makes each dir (under root) and the ones between, the
// builder's, as the registry that runs as its uid writes them.
func (s *Registries) builderTree(root string, dirs ...string) error {
	for _, dir := range dirs {
		rel, err := filepath.Rel(root, dir)
		if err != nil || strings.HasPrefix(rel, "..") {
			return fmt.Errorf("dockergvisor: %s is outside %s", dir, root)
		}
		p := root
		for _, part := range strings.Split(rel, string(filepath.Separator)) {
			p = filepath.Join(p, part)
			if info, err := os.Lstat(p); err == nil && info.IsDir() {
				continue
			}
			if err := s.cfg.Dirs.BuilderDir(p); err != nil {
				return err
			}
		}
	}
	return nil
}

// MaxStorageEntries bounds a walk of a registry's storage: a build that
// left more is refused (and its storage removed).
const MaxStorageEntries = 200_000

// walkBlobs calls fn for every regular blob data file of a storage, by its
// hex digest. Nothing is followed: a link or anything else in its place is
// skipped.
func walkBlobs(dir string, fn func(path, sum string, info fs.FileInfo) error) error {
	root := filepath.Join(dir, V2, "blobs", "sha256")
	entries := 0
	err := filepath.WalkDir(root, func(path string, e fs.DirEntry, err error) error {
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				return nil
			}
			return err
		}
		if entries++; entries > MaxStorageEntries {
			return fmt.Errorf("registry storage has more than %d entries", MaxStorageEntries)
		}
		if e.Name() != "data" || !e.Type().IsRegular() {
			return nil
		}
		sum := filepath.Base(filepath.Dir(path))
		if !hexDigest.MatchString(sum) || filepath.Base(filepath.Dir(filepath.Dir(path))) != sum[:2] {
			return nil
		}
		info, err := e.Info()
		if err != nil {
			return err
		}
		return fn(path, sum, info)
	})
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	return err
}

// storageSize is the bytes of the regular files under dir (0 when it is not
// there), never following a link, refused past MaxStorageEntries.
func storageSize(dir string) (int64, error) {
	return TreeBytes(dir, "registry storage", MaxStorageEntries)
}

// EntriesError is a walk of What refused past its bound on entries (Max).
type EntriesError struct {
	What string
	Max  int
}

func (e EntriesError) Error() string {
	return fmt.Sprintf("%s has more than %d entries", e.What, e.Max)
}

// TreeBytes is the bytes of the regular files under dir (0 when it is not
// there), never following a link, refused past maxEntries (EntriesError,
// naming what dir is).
// What goes away while it walks (a file a running build renamed) is not
// counted, and the walk goes on.
func TreeBytes(dir, what string, maxEntries int) (int64, error) {
	var total int64
	entries := 0
	err := filepath.WalkDir(dir, func(path string, e fs.DirEntry, err error) error {
		if err != nil {
			if path != dir && errors.Is(err, fs.ErrNotExist) {
				return nil
			}
			return err
		}
		if entries++; entries > maxEntries {
			return EntriesError{What: what, Max: maxEntries}
		}
		if !e.Type().IsRegular() {
			return nil
		}
		info, err := e.Info()
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		if err != nil {
			return err
		}
		total += info.Size()
		return nil
	})
	if errors.Is(err, fs.ErrNotExist) {
		return 0, nil
	}
	return total, err
}

// waitRegistry waits until the registry answers its API root, or ctx ends
// (at most registryStartTimeout).
func (s *Registries) waitRegistry(ctx context.Context, host string) error {
	ctx, cancel := context.WithTimeout(ctx, registryStartTimeout)
	defer cancel()
	client := &http.Client{Transport: &http.Transport{DialContext: s.cfg.Dial, Proxy: nil, DisableKeepAlives: true}, Timeout: 2 * time.Second}
	url := "http://" + net.JoinHostPort(host, strconv.Itoa(dockercli.RegistryPort)) + "/v2/"
	var last error
	for {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			return err
		}
		resp, err := client.Do(req)
		if err == nil {
			_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
			_ = resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return nil
			}
			err = fmt.Errorf("registry answered %d", resp.StatusCode)
		}
		last = err
		select {
		case <-ctx.Done():
			return fmt.Errorf("the registry did not answer: %w", last)
		case <-time.After(100 * time.Millisecond):
		}
	}
}

const registryStartTimeout = 20 * time.Second

// forward listens on a loopback port and hands every connection to target,
// for this Docker's pull; stop closes the port and every connection.
func (s *Registries) forward(ctx context.Context, target string) (string, func(), error) {
	var lc net.ListenConfig
	ln, err := lc.Listen(ctx, "tcp", "127.0.0.1:0")
	if err != nil {
		return "", nil, err
	}
	f := &forwarder{conns: map[net.Conn]bool{}}
	f.wg.Add(1)
	go func() {
		defer f.wg.Done()
		for {
			in, err := ln.Accept()
			if err != nil {
				return
			}
			if !f.track(in) {
				_ = in.Close()
				return
			}
			f.wg.Add(1)
			go func() {
				defer f.wg.Done()
				defer f.untrack(in)
				out, err := s.cfg.Dial(ctx, "tcp", target)
				if err != nil {
					return
				}
				if !f.track(out) {
					_ = out.Close()
					return
				}
				defer f.untrack(out)
				done := make(chan struct{}, 2)
				go func() { _, _ = io.Copy(out, in); done <- struct{}{} }()
				go func() { _, _ = io.Copy(in, out); done <- struct{}{} }()
				<-done
			}()
		}
	}()
	stop := func() {
		_ = ln.Close()
		f.closeAll()
		f.wg.Wait()
	}
	return ln.Addr().String(), stop, nil
}

// forwarder is the connections of one forward, closed together.
type forwarder struct {
	mu     sync.Mutex
	closed bool
	conns  map[net.Conn]bool
	wg     sync.WaitGroup
}

// track keeps c until untrack; false once the forward is closed.
func (f *forwarder) track(c net.Conn) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.closed {
		return false
	}
	f.conns[c] = true
	return true
}

func (f *forwarder) untrack(c net.Conn) {
	_ = c.Close()
	f.mu.Lock()
	delete(f.conns, c)
	f.mu.Unlock()
}

func (f *forwarder) closeAll() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.closed = true
	for c := range f.conns {
		_ = c.Close()
	}
}

var notRepoChar = regexp.MustCompile(`[^a-z0-9]+`)

// Repo is a service's repository: its name as a repository allows it, and a
// hash of the name so two services never share one.
func Repo(service string) string {
	s := strings.Trim(notRepoChar.ReplaceAllString(strings.ToLower(service), "-"), "-")
	if len(s) > 48 {
		s = strings.Trim(s[:48], "-")
	}
	if s == "" {
		s = "service"
	}
	return "kodus/" + s + "-" + shortHash(service)
}

var notTagChar = regexp.MustCompile(`[^A-Za-z0-9_.-]+`)

// registryTag is a machine's tag (the tag names nothing the cell pulls).
func registryTag(machine string) string {
	s := notTagChar.ReplaceAllString(machine, "-")
	if s == "" || strings.HasPrefix(s, ".") || strings.HasPrefix(s, "-") {
		s = "m" + s
	}
	if len(s) > 128 {
		s = s[:128]
	}
	return s
}

func shortHash(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])[:12]
}
