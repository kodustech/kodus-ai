package dockergvisor

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"path/filepath"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockergvisor/buildstate"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockergvisor/registry"
)

// How a build's image reaches this Docker (Config.ImageTransfer).
//
// tarball: BuildKit writes the whole image as a docker
// tarball into the build's output directory and the cell loads it. Every
// build writes every layer and docker load reads every layer back, so a pull
// request whose only change is its last COPY still moves the whole image
// twice through the sandbox's I/O.
//
// registry (the cell's default, cmd/cell): BuildKit pushes the image to a
// registry container the cell runs for that one build, and this Docker pulls
// it by the digest the build reported (package registry, which holds the
// security model of that path). A build that does not seed and finds the
// environment's registry never seeded sends a tarball (registry.ErrUnseeded).
const (
	TransferTarball  = "tarball"
	TransferRegistry = "registry"
)

// DefaultRegistryKeepBytes bounds an environment's seed storage when the
// cell sets none.
const DefaultRegistryKeepBytes int64 = 40 << 30

func (d *Driver) registryMode() bool { return d.cfg.ImageTransfer == TransferRegistry }

func (d *Driver) registryNetwork() string { return "kodus-registries-" + d.cfg.CellID }

func (d *Driver) registryRoot() string { return filepath.Join(d.workDir(), "registry") }

func (d *Driver) registryKeep() int64 {
	if d.cfg.RegistryKeepBytes > 0 {
		return d.cfg.RegistryKeepBytes
	}
	return DefaultRegistryKeepBytes
}

// newRegistries is the registry transfer of this driver. What it reads of
// the driver (its host directories, logger, clock and dialer) it reads at
// each call.
func (d *Driver) newRegistries() *registry.Registries {
	return registry.New(registry.Config{
		CellID: d.cfg.CellID, Image: d.cfg.RegistryImage, Runtime: d.cfg.Runtime,
		Root: d.registryRoot(), KeepBytes: d.registryKeep(),
		EnvKey: func(org, env string) string { return buildstate.EnvKey(d.cfg.CellID, org, env) },
		Docker: d.d, Dirs: registryDirs{d},
		Network: func(ctx context.Context) (string, error) { return d.ensureHostOnlyNetwork(ctx, d.registryNetwork()) },
		Parent:  d.parentFor,
		Dial:    d.dialRegistry,
		Now:     func() time.Time { return d.clock.Now() },
		Log:     d.log,
	})
}

// registryDirs is the driver's host directories as the registry asks them.
type registryDirs struct{ d *Driver }

func (r registryDirs) BuilderDir(p string) error          { return r.d.dirs.builderDir(p) }
func (r registryDirs) Builder() (uid, gid int)            { return r.d.dirs.uid, r.d.dirs.gid }
func (r registryDirs) Self() int                          { return r.d.dirs.self }
func (r registryDirs) Chown(p string, uid, gid int) error { return r.d.dirs.chown(p, uid, gid) }
func (r registryDirs) Owner(info fs.FileInfo) (int, bool) { return r.d.dirs.owner(info) }

// ensureHostOnlyNetwork creates one of the cell's host-only networks once
// (internal, the host on it, no traffic between its containers).
func (d *Driver) ensureHostOnlyNetwork(ctx context.Context, name string) (string, error) {
	owned := func() (bool, error) {
		labels, err := d.d.NetworkLabels(ctx, name)
		if err != nil || labels == nil {
			return false, err
		}
		if labels[dockercli.LabelFromTag(driver.TagCell)] != d.cfg.CellID {
			return false, fmt.Errorf("%w: network %s", driver.ErrNotOwned, name)
		}
		return true, nil
	}
	if ok, err := owned(); ok || err != nil {
		return name, err
	}
	err := d.d.NetworkCreate(ctx, dockercli.NetworkSpec{
		Name: name, HostOnly: true,
		Labels: toLabels(map[string]string{driver.TagCell: d.cfg.CellID}),
	})
	if err != nil {
		// Another build made it first.
		if ok, oerr := owned(); ok {
			return name, nil
		} else if oerr != nil {
			return "", errors.Join(err, oerr)
		}
		return "", err
	}
	return name, nil
}
