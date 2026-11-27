package dockergvisor

import (
	"context"
	"errors"
	"maps"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"sync"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/bakecatalog"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockergvisor/remotecache"
)

// The PR image in the shared store (docs/runtime/shared-image-store.md section 5).
//
//   - The claim whose grant holds a push right on the PR repository (the Run's PR side) pushes
//     each image it built, by fingerprint, after its builds, off the boot's path, and tells
//     the hub the digests (UpRequest.PRPushed).
//   - A claim whose acquire carries PRImages (a suite shard) pulls an image of its build's
//     fingerprint by the hub's digest instead of building it, and builds as before when the
//     pull fails in any way.
//
// The credential is the claim's own, held in memory and asked for on every request, so a
// renewal reaches a push in flight. The builder runs the code under test and gets neither the
// credential nor a route to the store: the cell moves the files.

// PhasePullPRImage is the boot phase of a pull of the PR image (the hub's PHASE_PULL_PR_IMAGE).
const PhasePullPRImage = "pull pr image"

// prUse is what one machine's builds may do in the store.
type prUse struct {
	creds   *driver.StoreCreds
	pull    map[string]string // fingerprint -> digest of the PR image to pull
	pushed  func(driver.PRPush)
	secrets []string

	mu    sync.Mutex
	built []builtImage // images this machine built (not reused), pushed once the builds end
}

// bindPRStore ties the request's store credential and digests to the machine for its builds.
// A request with neither, or a machine that is a spare's, uses none.
func (d *Driver) bindPRStore(ref driver.MachineRef, req driver.UpRequest) {
	if req.ImageStore == nil {
		return
	}
	u := &prUse{creds: req.ImageStore, pull: map[string]string{}, pushed: req.PRPushed}
	for _, s := range req.PRImages {
		u.pull[s.Fingerprint] = s.Digest
	}
	// What a layer must not hold: the placeholders the build was given and the Run's decoys.
	u.secrets = slices.Sorted(maps.Values(req.BuildSecrets))
	for _, c := range req.Canaries {
		u.secrets = append(u.secrets, c.Value)
	}
	o := d.machineOutput(ref.MachineID)
	d.mu.Lock()
	o.pr = u
	d.mu.Unlock()
}

func (d *Driver) prUseOf(machine string) *prUse {
	d.mu.Lock()
	defer d.mu.Unlock()
	if m := d.machines[machine]; m != nil && m.output != nil {
		return m.output.pr
	}
	return nil
}

func (u *prUse) noteBuilt(im builtImage) {
	u.mu.Lock()
	u.built = append(u.built, im)
	u.mu.Unlock()
}

// registryOf is the store the grant names, asked for its token on every request.
func registryOf(creds *driver.StoreCreds) (*remotecache.Registry, error) {
	g := creds.Current()
	u, err := url.JoinPath(g.Endpoint, g.Prefix)
	if err != nil {
		return nil, err
	}
	return remotecache.New(remotecache.Config{URL: u, Token: creds.Token})
}

// takePR gives the claim's build of service the PR image of fingerprint fp, by the hub's digest,
// loaded under the build's own tag. False on any failure, logged: the build runs.
func (d *Driver) takePR(ctx context.Context, ref driver.MachineRef, service, fp, digest, tag string, pr *prUse) bool {
	log := d.log().With("machine", ref.MachineID, "service", service, "fingerprint", short(fp))
	repo, ok := pr.creds.Current().Repo("pr")
	if !ok || !repo.Pull || !pr.creds.Live(d.clock.Now()) || !bakecatalog.IsHex(fp, 64) || !dockercli.ManifestDigest.MatchString(digest) {
		log.Info("build.pr_image.skipped", "granted", ok)
		return false
	}
	reg, err := registryOf(pr.creds)
	if err != nil {
		log.Warn("build.pr_image.failed", "err", err)
		return false
	}
	org, env := ref.Tags[driver.TagOrg], ref.Tags[driver.TagEnv]
	d.transfers.mu.Lock()
	d.transfers.seq++
	n := d.transfers.seq
	d.transfers.mu.Unlock()
	tarball := filepath.Join(d.workDir(), "share", "prpull-"+ref.MachineID+"-"+service+"-"+strconv.Itoa(n)+".tar")
	if err := os.MkdirAll(filepath.Dir(tarball), 0o700); err != nil {
		log.Warn("build.pr_image.failed", "err", err)
		return false
	}
	defer func() { _ = os.Remove(tarball) }()
	pctx, cancel := context.WithTimeout(ctx, remotecache.DefaultPullTimeout)
	defer cancel()
	began := time.Now()
	st, err := reg.PullImage(pctx, remotecache.ImageKey{Org: org, Env: env, Fingerprint: fp, Repo: repo.Name}, digest, tarball, tag)
	if err == nil {
		err = d.d.LoadImage(ctx, dockercli.ImageLoad{Tarball: tarball, Tag: tag, MaxBytes: d.maxImageBytes()})
	}
	if err != nil {
		// A registry that serves other bytes than the hub's digest is an alarm; a missing one is not.
		log.Warn("build.pr_image.failed", "digest", digest, "ms", time.Since(began).Milliseconds(), "alarm", errors.Is(err, remotecache.ErrDigestMismatch), "err", err)
		return false
	}
	log.Info("build.pr_image.pulled", "digest", digest, "blobs", st.Blobs, "bytes", st.Bytes, "ms", time.Since(began).Milliseconds())
	return true
}

// startPRPush pushes the images the machine built to the PR repository its grant names, off the
// boot's path, and tells PRPushed. Nothing happens for a claim without a push right on it.
func (d *Driver) startPRPush(ref driver.MachineRef) {
	pr := d.prUseOf(ref.MachineID)
	if pr == nil || pr.pushed == nil {
		return
	}
	repo, ok := pr.creds.Current().Repo("pr")
	if !ok || !repo.Push {
		return
	}
	pr.mu.Lock()
	built := slices.Clone(pr.built)
	pr.mu.Unlock()
	if len(built) == 0 {
		pr.pushed(driver.PRPush{Reason: "nothing_built"})
		return
	}
	d.transfers.pushes.Add(1)
	if !d.bg.Go("pr image push", func(life context.Context) error {
		defer d.transfers.pushes.Done()
		ctx, cancel := context.WithTimeout(life, remotePushTimeout)
		defer cancel()
		pr.pushed(d.pushPRImages(ctx, ref, pr, repo, built))
		return nil
	}) {
		d.transfers.pushes.Done()
		pr.pushed(driver.PRPush{Reason: "cell_closing"})
	}
}

func (d *Driver) pushPRImages(ctx context.Context, ref driver.MachineRef, pr *prUse, repo driver.StoreRepo, built []builtImage) driver.PRPush {
	reg, err := registryOf(pr.creds)
	if err != nil {
		return driver.PRPush{Reason: "push_failed"}
	}
	org, env := ref.Tags[driver.TagOrg], ref.Tags[driver.TagEnv]
	var out driver.PRPush
	reason := "push_failed"
	for i, im := range built {
		if im.fp == "" || !pr.creds.Live(d.clock.Now()) {
			continue
		}
		began := time.Now()
		digest, st, err := d.savePush(ctx, reg, remotecache.ImageKey{Org: org, Env: env, Fingerprint: im.fp, Repo: repo.Name}, im.tag, pr.secrets, "prpush-"+ref.MachineID+"-"+strconv.Itoa(i))
		if err != nil {
			alarm := errors.Is(err, remotecache.ErrSecretInImage)
			if alarm {
				reason = "secret_in_image"
			}
			d.log().Warn("build.pr_image.push_failed", "machine", ref.MachineID, "service", im.service, "fingerprint", short(im.fp), "alarm", alarm, "err", err)
			continue
		}
		ms := time.Since(began).Milliseconds()
		d.log().Info("build.pr_image.pushed", "machine", ref.MachineID, "service", im.service, "fingerprint", short(im.fp), "digest", digest, "blobs", st.Blobs, "bytes", st.Bytes, "sentBytes", st.MovedBytes, "ms", ms)
		out.Images = append(out.Images, driver.PushedImage{Fingerprint: im.fp, Digest: digest, Bytes: st.Bytes, PushMs: ms})
	}
	if len(out.Images) == 0 {
		out.Reason = reason
		return out
	}
	out.OK = true
	return out
}
