package dockergvisor

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"path"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose/sandbox"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockergvisor/toollayer"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// Tool layers on docker-gvisor (docs/runtime/persistent-state.md section 4).
// The store, key, extractor and verifier are package toollayer; this file is
// the driver's side: the image digest layers are keyed on (U6), the read-only
// bind of a verified layer into a review sandbox and the hold that keeps it
// from garbage collection while that sandbox lives, the tmpfs of a builder,
// and the tar stream that carries a builder's layer into the store.

// labelToolLayers names, on a sandbox container, the digests of the layers it
// mounts, so a sweep knows what is still in use.
const labelToolLayers = "kodus.tool-layers"

// ToolLayerConfig turns the feature on (-gvisor-toollayer) and sizes it. Zero
// limits take the design's defaults (toollayer.Default*).
type ToolLayerConfig struct {
	Enabled                                  bool
	MaxLayerBytes, MaxOrgBytes, MaxCellBytes int64
	// Now is the store's clock (tests); the wall clock when nil.
	Now func() time.Time
}

// layerKeeper is the driver's tool layer state; nil when the feature is off.
type layerKeeper struct {
	store  *toollayer.Store
	builds *toollayer.Builds
	// digest is the sandbox image's content digest; empty when it could not
	// be resolved: no layer is built or mounted, every request answers miss.
	digest string
	// maxLayer sizes a builder's tmpfs.
	maxLayer int64
	// gcAt is when the store was last collected; sweeps run it every gcEvery.
	gcMu sync.Mutex
	gcAt time.Time
}

const toolLayerGCEvery = 10 * time.Minute

var (
	layerIDPattern  = regexp.MustCompile(protocol.ToolLayerIDPattern)
	layerKeyPattern = regexp.MustCompile(protocol.ToolLayerKeyPattern)
	registryHost    = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$`)
	layerBinary     = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)
)

// openToolLayers opens the store under the work dir, as one of the cell's
// private roots, and resolves the sandbox image to its content digest.
func (d *Driver) openToolLayers(ctx context.Context) error {
	if d.cfg.SandboxImage == "" {
		return errors.New("dockergvisor: tool layers need a sandbox image")
	}
	cfg := d.cfg.ToolLayers
	root := filepath.Join(d.workDir(), "toollayers")
	if err := d.dirs.privateRoot(root); err != nil {
		return err
	}
	st, err := toollayer.New(toollayer.Config{
		Root: root, MaxLayerBytes: cfg.MaxLayerBytes, MaxOrgBytes: cfg.MaxOrgBytes, MaxCellBytes: cfg.MaxCellBytes, Now: cfg.Now,
	})
	if err != nil {
		return err
	}
	k := &layerKeeper{store: st, builds: toollayer.NewBuilds(cfg.Now), maxLayer: cfg.MaxLayerBytes}
	if k.maxLayer <= 0 {
		k.maxLayer = toollayer.DefaultMaxLayerBytes
	}
	// The image's content id, whatever tag or digest reference names it: a
	// layer is keyed on it and never meets an image it was not built for (U6).
	// No id, no layers: every request answers miss.
	if id, err := d.d.ImageID(ctx, d.cfg.SandboxImage); err != nil {
		d.log().Warn("toollayer.off", "reason", "no_image_digest", "err", err)
	} else {
		k.digest = id
	}
	d.layers = k
	return nil
}

// toolLayerPart is the driver.ToolLayers of a docker-gvisor driver.
type toolLayerPart struct{ d *Driver }

var _ driver.ToolLayers = toolLayerPart{}

func (p toolLayerPart) ImageDigest() string { return p.d.layers.digest }

// CheckBuild refuses anything the install validator refuses, and a key that
// is not the one this cell computes for the request: a layer is stored only
// under the name its inputs give it, for this cell's image and arch.
func (p toolLayerPart) CheckBuild(b driver.ToolLayerBuild) error {
	k := p.d.layers
	switch {
	case k.digest == "":
		return &toollayer.RefusalError{Reason: "no_image_digest"}
	case !layerIDPattern.MatchString(b.ID):
		return fmt.Errorf("%w: layer id %q", driver.ErrToolLayerRequest, b.ID)
	case !layerKeyPattern.MatchString(b.Key):
		return fmt.Errorf("%w: layer key", driver.ErrToolLayerRequest)
	case !layerBinary.MatchString(b.Binary):
		return fmt.Errorf("%w: binary %q is not a bare name", driver.ErrToolLayerRequest, b.Binary)
	case !registryHost.MatchString(b.Registry):
		return fmt.Errorf("%w: registry %q is not a host name", driver.ErrToolLayerRequest, b.Registry)
	}
	chk := toollayer.CheckInstall(strings.Join(b.Argv, " "))
	switch {
	case !chk.OK:
		return fmt.Errorf("%w: %s", driver.ErrToolLayerRequest, chk.Reason)
	case chk.Installer != b.Installer:
		return fmt.Errorf("%w: installer %s is not %s", driver.ErrToolLayerRequest, chk.Installer, b.Installer)
	case !slices.Equal(chk.Argv, b.Argv):
		// A word with a space in it splits differently once joined.
		return fmt.Errorf("%w: the install argv is not one word per argument", driver.ErrToolLayerRequest)
	}
	key, err := toollayer.ComputeKey(toollayer.KeyInput{
		Installer: b.Installer, Argv: b.Argv, Binary: b.Binary, ImageDigest: k.digest, Arch: p.d.arch(), Registry: b.Registry,
	})
	if err != nil {
		return err
	}
	if key != b.Key {
		return fmt.Errorf("%w: the key is not this cell's for the request", driver.ErrToolLayerRequest)
	}
	return nil
}

func (p toolLayerPart) States(ref driver.MachineRef) []driver.ToolLayerState {
	m := p.d.peek(ref.MachineID)
	return slices.Clone(m.layerStates)
}

func (p toolLayerPart) BeginBuild(org, key string) (func(failed bool), error) {
	end, err := p.d.layers.builds.Begin(org, key)
	var r *toollayer.BuildRefusal
	if errors.As(err, &r) {
		return nil, &driver.ErrBuildRefused{Reason: r.Reason}
	}
	return end, err
}

// Ingest streams /opt/kcli/<id> out of the builder as a tar through the
// machine's exec stream (docker exec -i, the tool image's own tar; nothing
// reaches a shell on the host) into the org's store, whose extractor refuses
// anything but a plain tree. ctx bounds the whole transfer.
func (p toolLayerPart) Ingest(ctx context.Context, org string, ref driver.MachineRef, b driver.ToolLayerBuild, in driver.ToolLayerIntegrity) (driver.ToolLayerBuilt, error) {
	built, err := p.ingest(ctx, org, ref, b, in)
	if err == nil {
		return built, nil
	}
	reason := toollayer.RefusalReason(err)
	switch {
	case reason != "":
	case errors.Is(err, driver.ErrToolLayerRequest):
		reason = "invalid_request"
	default:
		reason = "ingest_failed"
	}
	return driver.ToolLayerBuilt{}, &driver.ToolLayerError{Reason: reason, Err: err}
}

func (p toolLayerPart) ingest(ctx context.Context, org string, ref driver.MachineRef, b driver.ToolLayerBuild, in driver.ToolLayerIntegrity) (driver.ToolLayerBuilt, error) {
	d := p.d
	if err := p.CheckBuild(b); err != nil {
		return driver.ToolLayerBuilt{}, err
	}
	exists, err := d.owned(ctx, ref.MachineID)
	if err != nil {
		return driver.ToolLayerBuilt{}, err
	}
	if !exists {
		return driver.ToolLayerBuilt{}, fmt.Errorf("dockergvisor: builder %s is gone", ref.MachineID)
	}
	if !d.isBuilder(ref.MachineID, b.ID) {
		return driver.ToolLayerBuilt{}, fmt.Errorf("%w: %s is not the builder of layer %s", driver.ErrToolLayerRequest, ref.MachineID, b.ID)
	}
	sctx, cancel := context.WithCancel(ctx)
	defer cancel()
	rw, err := d.backend.ExecStream(sctx, ref.MachineID, "tar", "-cf", "-", "-C", path.Join(driver.ToolLayerMountDir, b.ID), ".")
	if err != nil {
		return driver.ToolLayerBuilt{}, err
	}
	defer func() { _ = rw.Close() }() // the stream is read to its end above; a close error loses nothing
	tr := &trailerReader{r: rw}
	layer, err := d.layers.store.Ingest(sctx, toollayer.IngestInput{
		Org: org, Key: b.Key, ImageDigest: d.layers.digest, Binary: b.Binary, Tar: tr,
		Integrity: toollayer.Integrity{
			LockfileIntegrity: in.LockfileIntegrity, SignaturesVerified: in.SignaturesVerified,
			SignaturesMissing: in.SignaturesMissing, SignaturesInvalid: in.SignaturesInvalid,
		},
	})
	if err != nil {
		return driver.ToolLayerBuilt{}, err
	}
	return driver.ToolLayerBuilt{Digest: layer.Digest, Bytes: layer.Bytes, Unsigned: in.SignaturesMissing}, nil
}

func (p toolLayerPart) PurgeOrg(org string) error { return p.d.layers.store.PurgeOrg(org) }

// trailerReader refuses a tar that ends at the stream's end instead of with
// its two zero blocks. tar that failed halfway ends at a block boundary,
// which Go's reader takes for the end of the archive; a reader that sees
// the stream end without the trailer before it returns an error, so the
// store never commits a partial layer. A clean archive's reader stops
// after the trailer and never asks for more.
type trailerReader struct {
	r    io.Reader
	tail []byte
}

var errNoTrailer = &toollayer.RefusalError{Reason: "tar_truncated"}

func (t *trailerReader) Read(p []byte) (int, error) {
	n, err := t.r.Read(p)
	if n > 0 {
		t.tail = append(t.tail, p[:n]...)
		if len(t.tail) > 1024 {
			t.tail = t.tail[len(t.tail)-1024:]
		}
	}
	if err == io.EOF && (len(t.tail) != 1024 || bytes.Count(t.tail, []byte{0}) != 1024) {
		return n, errNoTrailer
	}
	return n, err
}

// isBuilder says the machine was made as the builder of layer id.
func (d *Driver) isBuilder(machine, id string) bool {
	m := d.peek(machine)
	return m.builder == id
}

// arch is the cell's architecture as hello capabilities.arch names it
// (x86_64, arm64), what a key is built for.
func (d *Driver) arch() string {
	if a := d.Capabilities().HostArch; a != "" {
		return a
	}
	if a := isolation.ArchOf(runtime.GOARCH); a != "" {
		return a
	}
	return runtime.GOARCH
}

// mountedLayers is what CreateSandbox decided for a request's layers.
type mountedLayers struct {
	mounts   []string
	tmpfs    []isolation.Tmpfs
	states   []driver.ToolLayerState
	digests  []string
	releases []func()
	builder  string
}

func (m *mountedLayers) release() {
	for _, r := range m.releases {
		r()
	}
}

// prepareToolLayers resolves a sandbox request's layers: for each ask the
// verified, held layer as a read-only bind of a host path this cell built, or
// a recorded miss; for a builder the tmpfs its install writes to. A request
// that is not well formed is an error; a layer that is not there never is.
func (d *Driver) prepareToolLayers(ctx context.Context, org string, req driver.SandboxRequest) (*mountedLayers, error) {
	out := &mountedLayers{}
	if len(req.ToolLayers) == 0 && req.Build == nil {
		return out, nil
	}
	if req.Build != nil && len(req.ToolLayers) > 0 {
		return nil, fmt.Errorf("%w: a builder mounts no layer", driver.ErrToolLayerRequest)
	}
	k := d.layers
	if req.Build != nil {
		if k == nil || k.digest == "" {
			return nil, fmt.Errorf("%w: this cell builds no layers", driver.ErrUnsupported)
		}
		if err := (toolLayerPart{d}).CheckBuild(*req.Build); err != nil {
			return nil, err
		}
		out.builder = req.Build.ID
		out.tmpfs = []isolation.Tmpfs{{Dir: path.Join(driver.ToolLayerMountDir, req.Build.ID), Size: tmpfsMB(k.maxLayer)}}
		return out, nil
	}
	seen := map[string]bool{}
	for _, ref := range req.ToolLayers {
		// The id becomes a mount path: nothing but a short safe name.
		if !layerIDPattern.MatchString(ref.ID) || !layerKeyPattern.MatchString(ref.Key) || seen[ref.ID] {
			out.release()
			return nil, fmt.Errorf("%w: layer id %q", driver.ErrToolLayerRequest, ref.ID)
		}
		seen[ref.ID] = true
		st := d.mountLayer(ctx, org, ref, out)
		out.states = append(out.states, st)
	}
	return out, nil
}

// mountLayer is one requested layer: a bind and a hold on a hit, a recorded
// miss otherwise.
func (d *Driver) mountLayer(ctx context.Context, org string, ref driver.ToolLayerRef, out *mountedLayers) driver.ToolLayerState {
	k := d.layers
	miss := func(reason string) driver.ToolLayerState {
		st := driver.ToolLayerState{ID: ref.ID, Reason: reason}
		if k != nil && k.digest != "" {
			if err := k.store.RecordMiss(org, ref.Key); err != nil {
				d.log().Warn("toollayer.miss.record_failed", "err", err)
			}
			st.Build = k.store.ShouldBuild(org, ref.Key)
		}
		return st
	}
	switch {
	case k == nil:
		return miss("disabled")
	case k.digest == "":
		return miss("no_image_digest")
	}
	hit, err := k.store.Lookup(ctx, org, ref.Key)
	if err != nil {
		reason := toollayer.MissReason(err)
		if reason == "" {
			reason = "error"
			d.log().Warn("toollayer.lookup.failed", "err", err)
		}
		if reason == "corrupt" {
			d.log().Warn("toollayer.corrupt", "alarm", true)
		}
		return miss(reason)
	}
	tree, err := d.layerTree(hit.TreePath)
	if err != nil || hit.ImageDigest != k.digest {
		hit.Release()
		if err != nil {
			d.log().Warn("toollayer.mount.refused", "err", err)
			return miss("error")
		}
		return miss("image_changed")
	}
	out.mounts = append(out.mounts, tree+":"+path.Join(driver.ToolLayerMountDir, ref.ID))
	out.digests = append(out.digests, hit.Digest)
	out.releases = append(out.releases, hit.Release)
	return driver.ToolLayerState{
		ID: ref.ID, Hit: true, Digest: hit.Digest, Interpreter: hit.Interpreter,
		BinaryPath: path.Join(driver.ToolLayerMountDir, ref.ID, hit.BinaryPath),
	}
}

// layerTree is the host path to bind, checked once more as a path inside the
// store's root through real directories only, and fit for a -v argument.
func (d *Driver) layerTree(tree string) (string, error) {
	root := d.layers.store.Root()
	rel, err := filepath.Rel(root, tree)
	if err != nil {
		return "", err
	}
	abs, err := sandbox.ResolveInside(root, rel)
	if err != nil {
		return "", err
	}
	if strings.ContainsAny(abs, ":,\n\x00") {
		return "", errors.New("dockergvisor: a layer path with a character a bind cannot carry")
	}
	return abs, nil
}

// tmpfsMB is a size in docker's units, rounded up to a whole MiB.
func tmpfsMB(bytes int64) string {
	return fmt.Sprintf("%dm", (bytes+(1<<20)-1)>>20)
}

// releaseLayers ends a machine's holds on its layers.
func releaseLayers(rs []func()) {
	for _, r := range rs {
		r()
	}
}

// sweepToolLayers lets go of the holds of sandboxes whose container is gone
// without a Destroy (an operator's docker rm), then collects the store, at
// most every toolLayerGCEvery.
func (d *Driver) sweepToolLayers(ctx context.Context, now time.Time) error {
	k := d.layers
	if k == nil {
		return nil
	}
	k.gcMu.Lock()
	due := now.Sub(k.gcAt) >= toolLayerGCEvery
	if due {
		k.gcAt = now
	}
	k.gcMu.Unlock()
	if !due {
		return nil
	}
	live, err := d.d.LabelsOf(ctx, labelToolLayers)
	if err != nil {
		return err
	}
	alive := map[string]bool{}
	for _, c := range live {
		if c.Labels[labelToolLayers] == "" {
			continue
		}
		for _, n := range c.Names {
			alive[strings.TrimPrefix(n, "/")] = true
		}
	}
	var gone [][]func()
	d.mu.Lock()
	for id, m := range d.machines {
		if len(m.layerRelease) > 0 && !alive[id] {
			gone = append(gone, m.layerRelease)
			m.layerRelease = nil
		}
	}
	d.mu.Unlock()
	for _, rs := range gone {
		releaseLayers(rs)
	}
	rep, err := k.store.GC(ctx)
	if err != nil {
		return err
	}
	d.log().Info("toollayer.gc", slog.Any("report", rep))
	return nil
}
