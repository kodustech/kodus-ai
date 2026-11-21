package dockergvisor

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockergvisor/remotecache"
)

// The build cache off the cell (docs/runtime/build-cache.md). The
// environment's BuildKit state stays the fast path; the disk floor may evict
// it (buildstate), and then every build of the environment ran cold until a
// setup again. With a remote store set (Config.BuildCacheRemote):
//
//   - the default branch's setup also exports its cache (mode=max) when it
//     seeds the state, and the cell pushes it, off the setup's path, to the
//     org's repository of the environment (remotecache.Key);
//   - a build that has neither the state nor an exported cache on this cell
//     pulls it into a generation of the environment's exported cache and
//     imports it; so does a seed whose state is new (evicted, or a cell that
//     never had it).
//
// The builder never sees the store: the cell moves the files. Only a seeding
// setup pushes (S-52): a pull request reads the default branch's layers and
// writes nothing that outlives it.

// remoteCache is what the driver needs of the store; remotecache.Registry
// implements it.
type remoteCache interface {
	Push(ctx context.Context, k remotecache.Key, dir string) (remotecache.Stats, error)
	Pull(ctx context.Context, k remotecache.Key, dir string) (remotecache.Stats, error)
}

// remotePushTimeout bounds one background push.
const remotePushTimeout = 30 * time.Minute

// remoteTransfers keeps one pull per environment's service at a time (a
// second build waits for it and reads what it pulled) and tracks the pushes,
// so a stopping cell can wait for them.
type remoteTransfers struct {
	mu      sync.Mutex
	pulling map[string]chan struct{}
	pushes  sync.WaitGroup
	seq     int
}

func (d *Driver) remoteKey(org, env, service string) remotecache.Key {
	return remotecache.Key{Org: org, Env: env, Service: service}
}

// pullRemote makes the remote cache of (org, env, service) the environment's
// exported cache on this cell, unless one is already there. It returns
// whether it pulled one; a failure is logged and the build runs as it would
// have (cold).
func (d *Driver) pullRemote(ctx context.Context, machine, org, env, service string) bool {
	if d.remote == nil || org == "" || env == "" {
		return false
	}
	dir := d.envCacheDir(org, env, service)
	for {
		d.transfers.mu.Lock()
		if d.transfers.pulling == nil {
			d.transfers.pulling = map[string]chan struct{}{}
		}
		wait, busy := d.transfers.pulling[dir]
		if !busy {
			done := make(chan struct{})
			d.transfers.pulling[dir] = done
			d.transfers.mu.Unlock()
			defer func() { //nolint:gocritic // deferInLoop: runs once, the loop breaks right after
				d.transfers.mu.Lock()
				delete(d.transfers.pulling, dir)
				d.transfers.mu.Unlock()
				close(done)
			}()
			break
		}
		d.transfers.mu.Unlock()
		select {
		case <-wait:
		case <-ctx.Done():
			return false
		}
	}
	// Another build pulled it while this one waited.
	if gen, release := d.caches.Acquire(dir); gen != "" {
		release()
		return true
	}
	d.transfers.mu.Lock()
	d.transfers.seq++
	tmp := filepath.Join(d.workDir(), "cache", "pull", machine+"-"+service+"-"+strconv.Itoa(d.transfers.seq))
	d.transfers.mu.Unlock()
	if err := os.MkdirAll(filepath.Dir(tmp), 0o700); err != nil {
		d.log().Warn("build.cache.remote.pull_failed", "machine", machine, "service", service, "err", err)
		return false
	}
	defer func() { _ = os.RemoveAll(tmp) }()
	pctx, cancel := context.WithTimeout(ctx, remotecache.DefaultPullTimeout)
	defer cancel()
	began := time.Now()
	st, err := d.remote.Pull(pctx, d.remoteKey(org, env, service), tmp)
	switch {
	case errors.Is(err, remotecache.ErrNotFound):
		d.log().Info("build.cache.remote.none", "machine", machine, "service", service)
		return false
	case err != nil:
		d.log().Warn("build.cache.remote.pull_failed", "machine", machine, "service", service, "ms", time.Since(began).Milliseconds(), "err", err)
		return false
	}
	// The builder reads it read-only, as its own export: every entry the
	// builder's (the pull wrote only directories and regular files).
	if err := d.builderOwnedTree(tmp); err != nil {
		d.log().Warn("build.cache.remote.pull_failed", "machine", machine, "service", service, "err", err)
		return false
	}
	if err := d.caches.Promote(tmp, dir); err != nil {
		d.log().Warn("build.cache.remote.pull_failed", "machine", machine, "service", service, "err", err)
		return false
	}
	d.log().Info("build.cache.remote.pulled", "machine", machine, "service", service, "blobs", st.Blobs, "bytes", st.Bytes, "ms", time.Since(began).Milliseconds())
	return true
}

// pushRemote sends a seeding setup's exported cache in dir to the store, off
// the build's path, then calls done (which removes or releases dir).
func (d *Driver) pushRemote(machine, org, env, service, dir string, done func()) {
	if d.remote == nil || org == "" || env == "" {
		done()
		return
	}
	d.transfers.pushes.Add(1)
	// The driver's lifetime, not the build's: Shutdown waits for the push,
	// then ends it at its deadline.
	if !d.bg.Go("build cache push", func(life context.Context) error {
		defer d.transfers.pushes.Done()
		defer done()
		ctx, cancel := context.WithTimeout(life, remotePushTimeout)
		defer cancel()
		began := time.Now()
		st, err := d.remote.Push(ctx, d.remoteKey(org, env, service), dir)
		if err != nil {
			d.log().Warn("build.cache.remote.push_failed", "machine", machine, "service", service, "ms", time.Since(began).Milliseconds(), "err", err)
			return nil
		}
		d.log().Info("build.cache.remote.pushed", "machine", machine, "service", service, "blobs", st.Blobs, "bytes", st.Bytes,
			"sentBlobs", st.Moved, "sentBytes", st.MovedBytes, "ms", time.Since(began).Milliseconds())
		return nil
	}) {
		d.log().Info("build.cache.remote.push_skipped", "machine", machine, "service", service, "why", "the driver is closing")
		d.transfers.pushes.Done()
		done()
	}
}

// builderOwnedTree gives a tree the cell wrote to the builder's uid.
func (d *Driver) builderOwnedTree(root string) error {
	return filepath.WalkDir(root, func(p string, e os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !e.IsDir() && !e.Type().IsRegular() {
			return errors.New("dockergvisor: a pulled cache holds a file that is not regular")
		}
		return d.dirs.chown(p, d.dirs.uid, d.dirs.gid)
	})
}

// WaitRemotePushes returns once every background push has ended (a test, a
// cell that stops).
func (d *Driver) WaitRemotePushes() { d.transfers.pushes.Wait() }
