package dockergvisor

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/buildprogress"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
)

// The build cache through the claim's image-store grant (docs/runtime/shared-image-store.md step 3).
//
// A claim whose grant names the org's `cache` repository with a pull right reads the default branch's BuildKit cache
// from the registry (--import-cache type=registry), and only a seeding setup whose grant holds the push right writes
// it (--export-cache). A PR side imports main's cache and never exports (S-52). The token reaches BuildKit's client
// through a docker config in a directory of the claim's own (removed when the build ends, and with the claim's
// builds directory), is rewritten when the claim's grant is renewed, and is never logged or written into the build
// context or the image. With no such grant the cell keeps the cache it moves itself (cache_remote.go) when
// -gvisor-build-cache-remote is set, and has no remote cache otherwise.

// Phase names BuildKit prints for the remote cache (buildprogress/phases.go).
const (
	phaseImportCache = "import cache"
	phaseExportCache = "export cache"
)

// cacheGrantOf is the claim's credential and its cache repository, when the grant lets the machine read it now.
func (d *Driver) cacheGrantOf(machine string) (*driver.StoreCreds, driver.StoreRepo, bool) {
	pr := d.prUseOf(machine)
	if pr == nil || pr.creds == nil {
		return nil, driver.StoreRepo{}, false
	}
	repo, ok := pr.creds.Current().Repo("cache")
	if !ok || !repo.Pull || !pr.creds.Live(d.clock.Now()) {
		return nil, driver.StoreRepo{}, false
	}
	return pr.creds, repo, true
}

// legacyRemote is whether the cell's own transfer of the cache (the static credential of the flag) applies to the
// machine: a grant with cache scope replaces it.
func (d *Driver) legacyRemote(machine string) bool {
	if d.remote == nil {
		return false
	}
	_, _, granted := d.cacheGrantOf(machine)
	return !granted
}

// cacheRefOf is the registry reference of one service's cache: host/<the grant's cache repository>:<tag per service>.
// The repository is the hub's (o-<org>/e-<org,env>/cache), so an org's cache is its own path; the service tag keeps
// two services of one environment apart.
func cacheRefOf(g driver.StoreGrant, repo, service string) (host string, ref string, insecure bool, err error) {
	u, err := url.Parse(g.Endpoint)
	if err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") {
		return "", "", false, errors.New("dockergvisor: the store endpoint is not an http(s) URL")
	}
	sum := sha256.Sum256([]byte(service))
	ref = u.Host + "/" + strings.Trim(repo, "/") + ":s-" + hex.EncodeToString(sum[:])[:32]
	if !dockercli.ValidCacheRef(ref) {
		return "", "", false, errors.New("dockergvisor: the store's cache reference is not valid")
	}
	return u.Host, ref, u.Scheme == "http", nil
}

// dockerConfigJSON is the config BuildKit's client reads the registry's bearer token from.
func dockerConfigJSON(host, token string) ([]byte, error) {
	return json.Marshal(map[string]any{"auths": map[string]any{host: map[string]string{"registrytoken": token}}})
}

// writeDockerConfig replaces dir/config.json atomically, readable by the builder's user only.
func (d *Driver) writeDockerConfig(dir, host, token string) error {
	b, err := dockerConfigJSON(host, token)
	if err != nil {
		return err
	}
	tmp := filepath.Join(dir, ".config.json.tmp")
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	if err := d.dirs.chown(tmp, d.dirs.uid, d.dirs.gid); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, filepath.Join(dir, "config.json")); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// attachRemoteCache sets the build's registry cache refs and the docker config that carries the claim's token.
// read: the build starts without a local cache and so imports main's; write: it may export (only a seeding
// setup whose grant holds the push right). The returned stop ends the token's refresh and removes the config; it is
// safe to call when nothing was attached. A failure leaves the build running without the remote cache.
func (d *Driver) attachRemoteCache(ref driver.MachineRef, service string, run *dockercli.BuildRun, read bool) (stop func()) {
	stop = func() {}
	creds, repo, ok := d.cacheGrantOf(ref.MachineID)
	if !ok {
		return stop
	}
	write := repo.Push && mayWriteRemoteCache(d.peek(ref.MachineID))
	if !read && !write {
		return stop
	}
	log := d.log().With("machine", ref.MachineID, "service", service)
	host, cref, insecure, err := cacheRefOf(creds.Current(), repo.Name, service)
	if err != nil {
		log.Warn("build.cache.grant.skipped", "err", err)
		return stop
	}
	d.transfers.mu.Lock()
	d.transfers.seq++
	n := d.transfers.seq
	d.transfers.mu.Unlock()
	dir := filepath.Join(d.workDir(), "builds", ref.MachineID, service+".dockercfg."+strconv.Itoa(n))
	if err := d.dirs.builderDir(dir); err != nil {
		log.Warn("build.cache.grant.skipped", "err", err)
		return stop
	}
	// The channel first, then the token: a renewal in between is seen by the refresh, never lost.
	changed := creds.Changed()
	if err := d.writeDockerConfig(dir, host, creds.Token()); err != nil {
		_ = os.RemoveAll(dir)
		log.Warn("build.cache.grant.skipped", "err", err)
		return stop
	}
	run.DockerConfig, run.RemoteCacheInsecure = dir, insecure
	if read {
		run.RemoteCacheFrom = cref
	}
	if write {
		run.RemoteCacheTo = cref
	}
	// A build outlives a token (10 minutes by design): each renewal rewrites the file, atomically.
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			select {
			case <-ctx.Done():
				return
			case <-changed:
				changed = creds.Changed()
				if err := d.writeDockerConfig(dir, host, creds.Token()); err != nil {
					log.Warn("build.cache.grant.refresh_failed", "err", err)
				}
			}
		}
	}()
	log.Info("build.cache.grant", "import", read, "export", write)
	return func() {
		cancel()
		<-done
		_ = os.RemoveAll(dir)
	}
}

// remoteCacheFacts is what a build's remote cache cost and gave, from BuildKit's own steps: the time of its
// import and its export, and the share of its steps that came from a cache.
type remoteCacheFacts struct {
	Imported, Exported bool
	ImportMs, ExportMs int64
	Cached, Steps      int
}

func remoteCacheFactsOf(run dockercli.BuildRun, s buildprogress.Summary) remoteCacheFacts {
	f := remoteCacheFacts{Imported: run.RemoteCacheFrom != "", Exported: run.RemoteCacheTo != "", Cached: s.Cached, Steps: s.Steps}
	for _, p := range s.Phases {
		switch p.Name {
		case phaseImportCache:
			f.ImportMs += p.Ms
		case phaseExportCache:
			f.ExportMs += p.Ms
		}
	}
	return f
}

// attrs are the facts as log attributes of build.timing; a build with no remote cache adds none.
func (f remoteCacheFacts) attrs() []any {
	if !f.Imported && !f.Exported {
		return nil
	}
	out := []any{"cacheRemoteImport", f.Imported, "cacheRemoteExport", f.Exported, "cacheImportMs", f.ImportMs, "cacheExportMs", f.ExportMs,
		"layersCached", f.Cached, "layersTotal", f.Steps}
	if f.Steps > 0 {
		out = append(out, "layerHitRate", fmt.Sprintf("%.2f", float64(f.Cached)/float64(f.Steps)))
	}
	return out
}
