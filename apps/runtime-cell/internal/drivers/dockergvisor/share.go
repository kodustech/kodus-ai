package dockergvisor

import (
	"archive/tar"
	"context"
	"errors"
	"io"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/bakecatalog"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockergvisor/remotecache"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/redact"
)

// Shared baked environments (docs/runtime/shared-baked-environments.md).
// With Config.BakeShare set:
//
//   - after a bake publishes its generation, the cell saves each of its
//     images, checks every blob for the setup claim's secret values and
//     pushes it to the org's repository (remotecache.ImageKey), off the
//     bake's path; BakeSpec.Shared hears the digests, the agent tells the hub.
//   - a build whose fingerprint has a digest in UpRequest.SharedImages, and
//     no image of it here, pulls it by that digest (from Config.BakeSharePull
//     when set, a mirror near the cell), loads it under this cell's own name
//     for it and takes it as a baked image. Any failure: the build runs.
//
// Only a bake pushes (S-52: the setup's default-branch output); a claim
// only reads, and the digest comes from the hub, never from the registry.

// imageShare is what the driver needs of the org's registry;
// remotecache.Registry implements it.
type imageShare interface {
	PushImage(ctx context.Context, k remotecache.ImageKey, dir string) (string, remotecache.Stats, error)
	PullImage(ctx context.Context, k remotecache.ImageKey, digest, tarball, tag string) (remotecache.Stats, error)
}

// maxSavedEntries bounds the archive docker save writes: a few blobs per layer.
const maxSavedEntries = 4096

// sharedRepo is this cell's repository of the environment's images it
// pulled from another cell's bake: kodus-shared/<cell>/<org>/<env>.
func sharedRepo(cell, org, env string) (string, bool) {
	repo, ok := bakeRepo(cell, org, env)
	if !ok {
		return "", false
	}
	return "kodus-shared/" + strings.TrimPrefix(repo, "kodus-bake/"), true
}

// shareGeneration pushes g's images to the org's registry, off the bake's
// path, and gives spec.Shared what it pushed. A failure is logged; the bake
// already succeeded.
func (d *Driver) shareGeneration(ctx context.Context, spec driver.BakeSpec, g bakecatalog.Generation) {
	if d.share == nil || len(g.Images) == 0 {
		return
	}
	c, err := d.catalogFor(ctx)
	if err != nil {
		d.log().Warn("bake.share.skipped", "env", g.Environment, "err", err)
		return
	}
	// The generation stays until its images are saved, even if a newer bake retires it meanwhile.
	_, release, ok := c.Hold(g.ID, g.Org, g.Environment)
	if !ok {
		d.log().Warn("bake.share.skipped", "env", g.Environment, "why", "the generation is gone")
		return
	}
	d.transfers.pushes.Add(1)
	if !d.bg.Go("bake share push", func(life context.Context) error {
		defer d.transfers.pushes.Done()
		defer release()
		ctx, cancel := context.WithTimeout(life, remotePushTimeout)
		defer cancel()
		out := driver.SharedBake{OrgID: g.Org, EnvironmentID: g.Environment, SHA: g.SHA, RefsDigest: g.RefsDigest, RecipeSHA: g.RecipeSHA}
		fps := make([]string, 0, len(g.Images))
		for fp := range g.Images {
			fps = append(fps, fp)
		}
		slices.Sort(fps)
		for i, fp := range fps {
			digest, err := d.pushImage(ctx, g, fp, g.Images[fp], spec.Secrets, i)
			if err != nil {
				alarm := errors.Is(err, remotecache.ErrSecretInImage)
				d.log().Warn("bake.share.push_failed", "env", g.Environment, "fingerprint", short(fp), "alarm", alarm, "err", err)
				continue
			}
			out.Images = append(out.Images, driver.SharedImage{Fingerprint: fp, Digest: digest})
		}
		if len(out.Images) > 0 && spec.Shared != nil {
			spec.Shared(out)
		}
		return nil
	}) {
		d.log().Info("bake.share.skipped", "env", g.Environment, "why", "the driver is closing")
		d.transfers.pushes.Done()
		release()
	}
}

// pushImage saves one baked image, checks it for the claim's secret values
// and pushes it, returning its manifest digest.
func (d *Driver) pushImage(ctx context.Context, g bakecatalog.Generation, fp, image string, secrets []string, i int) (string, error) {
	dir := filepath.Join(d.workDir(), "share", "push-"+g.Nonce+"-"+strconv.Itoa(i))
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	defer func() { _ = os.RemoveAll(dir) }()
	tarball := dir + ".tar"
	defer func() { _ = os.Remove(tarball) }()
	began := time.Now()
	if err := d.d.SaveImage(ctx, image, tarball); err != nil {
		return "", err
	}
	err := extractSaved(tarball, dir)
	_ = os.Remove(tarball)
	if err != nil {
		return "", err
	}
	if err := remotecache.CheckImageSecrets(dir, func(r io.Reader) (bool, error) { return redact.ReaderContains(r, secrets) }); err != nil {
		return "", err
	}
	digest, st, err := d.share.PushImage(ctx, remotecache.ImageKey{Org: g.Org, Env: g.Environment, Fingerprint: fp}, dir)
	if err != nil {
		return "", err
	}
	d.log().Info("bake.share.pushed", "env", g.Environment, "fingerprint", short(fp), "digest", digest, "blobs", st.Blobs, "bytes", st.Bytes,
		"sentBlobs", st.Moved, "sentBytes", st.MovedBytes, "ms", time.Since(began).Milliseconds())
	return digest, nil
}

// extractSaved unpacks the archive docker save wrote into dir: directories
// and regular files only, every name inside dir, bounded in entries.
func extractSaved(tarball, dir string) error {
	f, err := os.Open(tarball) //nolint:gosec // G304: the cell's own docker save output
	if err != nil {
		return err
	}
	defer func() { _ = f.Close() }()
	root, err := os.OpenRoot(dir)
	if err != nil {
		return err
	}
	defer func() { _ = root.Close() }()
	tr := tar.NewReader(f)
	for n := 0; ; n++ {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		if n >= maxSavedEntries {
			return errors.New("dockergvisor: the saved image has too many entries")
		}
		name := path.Clean(strings.TrimPrefix(h.Name, "./"))
		switch h.Typeflag {
		case tar.TypeDir:
			if err := root.MkdirAll(name, 0o700); err != nil {
				return err
			}
		case tar.TypeReg:
			if dir := path.Dir(name); dir != "." {
				if err := root.MkdirAll(dir, 0o700); err != nil {
					return err
				}
			}
			w, err := root.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
			if err != nil {
				return err
			}
			_, err = io.Copy(w, tr) //nolint:gosec // G110: bounded by the image's size, which docker save of the cell's own image wrote
			if err = errors.Join(err, w.Close()); err != nil {
				return err
			}
		default:
			// A link names a blob already in the archive; the push reads blobs only.
		}
	}
}

// takeShared gives the claim's build of service the image another cell of
// the org baked for fingerprint fp, by digest: this cell's copy when it has
// one, else pulled and loaded under this cell's name for it. False on any
// failure, logged: the build runs as it would have.
func (d *Driver) takeShared(ctx context.Context, ref driver.MachineRef, service, fp, digest, tag string, keep []driver.SharedImage) bool {
	org, env := ref.Tags[driver.TagOrg], ref.Tags[driver.TagEnv]
	repo, ok := sharedRepo(d.cfg.CellID, org, env)
	if d.sharePull == nil || !ok || !bakecatalog.IsHex(fp, 64) || !dockercli.ManifestDigest.MatchString(digest) {
		return false
	}
	name := repo + ":" + fp
	log := d.log().With("machine", ref.MachineID, "service", service, "fingerprint", short(fp))
	if err := d.d.TagImage(ctx, name, tag); err == nil {
		return true
	} else if !errors.Is(err, dockercli.ErrNoSuchImage) {
		log.Warn("build.shared.failed", "err", err)
		return false
	}
	done, ok := d.sharedPullTurn(ctx, name)
	if !ok {
		return false
	}
	defer done()
	// Another claim pulled it while this one waited.
	if err := d.d.TagImage(ctx, name, tag); err == nil {
		return true
	}
	d.transfers.mu.Lock()
	d.transfers.seq++
	tarball := filepath.Join(d.workDir(), "share", "pull-"+ref.MachineID+"-"+service+"-"+strconv.Itoa(d.transfers.seq)+".tar")
	d.transfers.mu.Unlock()
	if err := os.MkdirAll(filepath.Dir(tarball), 0o700); err != nil {
		log.Warn("build.shared.pull_failed", "err", err)
		return false
	}
	defer func() { _ = os.Remove(tarball) }()
	pctx, cancel := context.WithTimeout(ctx, remotecache.DefaultPullTimeout)
	defer cancel()
	began := time.Now()
	st, err := d.sharePull.PullImage(pctx, remotecache.ImageKey{Org: org, Env: env, Fingerprint: fp}, digest, tarball, name)
	if err == nil {
		err = d.d.LoadImage(ctx, dockercli.ImageLoad{Tarball: tarball, Tag: name, MaxBytes: d.maxImageBytes()})
	}
	if err == nil {
		err = d.d.TagImage(ctx, name, tag)
	}
	if err != nil {
		// A registry that serves other bytes than the hub's digest is an alarm; a missing one is not.
		log.Warn("build.shared.pull_failed", "digest", digest, "ms", time.Since(began).Milliseconds(), "alarm", errors.Is(err, remotecache.ErrDigestMismatch), "err", err)
		return false
	}
	log.Info("build.shared.pulled", "digest", digest, "blobs", st.Blobs, "bytes", st.Bytes, "ms", time.Since(began).Milliseconds())
	d.pruneShared(ctx, repo, keep)
	return true
}

// sharedPullTurn keeps one pull per name at a time: a second claim waits for
// the first and then takes what it loaded. False: ctx ended while waiting.
func (d *Driver) sharedPullTurn(ctx context.Context, name string) (func(), bool) {
	for {
		d.transfers.mu.Lock()
		if d.transfers.pulling == nil {
			d.transfers.pulling = map[string]chan struct{}{}
		}
		wait, busy := d.transfers.pulling[name]
		if !busy {
			done := make(chan struct{})
			d.transfers.pulling[name] = done
			d.transfers.mu.Unlock()
			return func() {
				d.transfers.mu.Lock()
				delete(d.transfers.pulling, name)
				d.transfers.mu.Unlock()
				close(done)
			}, true
		}
		d.transfers.mu.Unlock()
		select {
		case <-wait:
		case <-ctx.Done():
			return nil, false
		}
	}
}

// pruneShared drops this cell's copies of the environment's shared images
// the hub no longer names (keep: the claim's sharedImages, the hub's last
// bakes). A claim holds its image under its own name, which stays.
func (d *Driver) pruneShared(ctx context.Context, repo string, keep []driver.SharedImage) {
	refs, err := d.d.ImageRefs(ctx, repo)
	if err != nil {
		return
	}
	for _, r := range refs {
		fp := strings.TrimPrefix(r, repo+":")
		if slices.ContainsFunc(keep, func(s driver.SharedImage) bool { return s.Fingerprint == fp }) {
			continue
		}
		if err := d.d.RemoveImage(ctx, r); err != nil {
			d.log().Warn("build.shared.prune_failed", "image", r, "err", err)
		}
	}
}

// sharedDigest is the digest the claim's shared images name for fp, or "".
func sharedDigest(shared []driver.SharedImage, fp string) string {
	for _, s := range shared {
		if s.Fingerprint == fp {
			return s.Digest
		}
	}
	return ""
}

// sharePullWhere is where pulls of shared images go, for the start log.
func (d *Driver) sharePullWhere() string {
	if r, ok := d.sharePull.(*remotecache.Registry); ok {
		return r.Where()
	}
	return ""
}
