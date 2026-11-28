package dockergvisor

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation/gvisor"
)

// Code sandboxes on docker-gvisor (docs/runtime/sandbox.md): one machine of
// the tool image (Config.SandboxImage) on the claim's network, made by the
// isolation backend (under runsc on gvisor, like every container of the
// cell), as user 1000, with /workspace and /tmp in its own memory. The guest
// agent (cmd/kody-guest) inside it serves the cell over the backend's stream
// (docker exec -i on gvisor, vsock on a microVM): the cell never reads the
// machine's files from the host, so the same guest agent serves both.

// ErrNoSandboxImage means the cell runs no sandboxes (no -gvisor-sandbox-image).
var ErrNoSandboxImage = errors.New("dockergvisor: no sandbox image configured")

var _ driver.Sandboxer = (*Driver)(nil)

// SandboxesEnabled reports whether the driver makes sandboxes: a tool image
// and a backend that reaches a guest agent.
func (d *Driver) SandboxesEnabled() bool {
	return d.cfg.SandboxImage != "" && d.backend.Capabilities().Guest != ""
}

// CreateSandbox makes the sandbox machine for req.Spec, with the checks
// Create makes (the spec, the cell, the claim's own network) and the
// claim's resource group.
func (d *Driver) CreateSandbox(ctx context.Context, req driver.SandboxRequest) (driver.MachineRef, error) {
	spec := req.Spec
	if !d.SandboxesEnabled() {
		return driver.MachineRef{}, ErrNoSandboxImage
	}
	if req.Build != nil && req.CellTrust {
		// A builder reaches one registry host and holds nothing of an org's.
		return driver.MachineRef{}, fmt.Errorf("%w: a layer builder takes no secret and no trust files", driver.ErrToolLayerRequest)
	}
	if req.CellTrust && !d.cfg.Trust.Set() {
		return driver.MachineRef{}, fmt.Errorf("%w: dockergvisor: the sandbox needs the cell's trust files and this cell has none", driver.ErrUnsupported)
	}
	if spec.Role != driver.RolePool {
		spec.Role = driver.RoleWorkload // a blank pool sandbox keeps its role until a claim takes it
	}
	spec.ImageID, spec.ImageRef = "sandbox", d.cfg.SandboxImage
	if err := d.checkMachineSpec(spec); err != nil {
		return driver.MachineRef{}, err
	}
	tags := spec.AllTags()
	name := machineName(spec)
	labels := toLabels(tags)
	g, err := d.groupFor(ctx, spec.ClaimGroupID, spec.OrgID, spec.ClaimSize)
	if err != nil {
		return driver.MachineRef{}, err
	}
	g.label(labels)
	labels["kodus.image"] = spec.ImageID
	labels[labelMachine] = name
	resolv, err := d.claimResolv(spec.ClaimGroupID)
	if err != nil {
		return driver.MachineRef{}, err
	}
	mem := d.cfg.MemLimit
	if spec.ClaimSize.MemoryMB > 0 {
		mem = strconv.Itoa(spec.ClaimSize.MemoryMB) + "m"
	}
	cpus := d.cfg.CPUs
	if spec.ClaimSize.CPUs > 0 {
		cpus = strconv.Itoa(spec.ClaimSize.CPUs)
	}
	// A claim with org secrets: the cell's trust files, over the tool
	// image's system store too (machinetrust.SandboxMounts).
	var mounts []string
	if req.CellTrust {
		mounts = d.cfg.Trust.SandboxMounts()
	}
	// The layers a review asks for, as read-only binds of trees the cell
	// verified, or the tmpfs a layer builder installs into (toollayers.go).
	layers, err := d.prepareToolLayers(ctx, spec.OrgID, req)
	if err != nil {
		return driver.MachineRef{}, err
	}
	if len(layers.digests) > 0 {
		labels[labelToolLayers] = strings.Join(layers.digests, ",")
	}
	mounts = append(mounts, layers.mounts...)
	c, err := d.backend.Create(ctx, isolation.Spec{
		Shape: isolation.ShapeSandbox, Name: name, Image: d.cfg.SandboxImage, Network: spec.ClaimGroupID, Mounts: mounts, Tmpfs: layers.tmpfs,
		PidsLimit: d.cfg.PidsLimit, Labels: labels, Resolv: resolv, CgroupParent: g.parent, DiskSize: d.cfg.ContainerDiskSize,
		User: gvisor.GuestUser, Memory: mem, CPUs: cpus,
		// What the commands write lives in the sandbox's memory: half of it
		// for the checkout, a little for /tmp, never the cell's disk.
		WorkspaceSize: halfOf(mem), TmpSize: "512m",
		Rates: d.ratesFor(spec.ClaimSize),
	})
	if err != nil {
		layers.release()
		return driver.MachineRef{}, err
	}
	if d.cfg.ClaimLimits != nil {
		if err := d.cfg.ClaimLimits.Verify(g.key, c.PID); err != nil {
			layers.release()
			cleanup, cancel := cleanupContext(ctx)
			defer cancel()
			return driver.MachineRef{}, errors.Join(ErrResourceEnforcement, err, d.backend.Discard(cleanup, name))
		}
	}
	d.mu.Lock()
	m := d.machineLocked(name)
	m.expires, m.size = spec.ExpiresAt, spec.ClaimSize
	m.layerStates, m.layerRelease, m.builder = layers.states, layers.releases, layers.builder
	d.mu.Unlock()
	return driver.MachineRef{MachineID: name, DriverRef: c.ID, PrivateAddress: c.IP(spec.ClaimGroupID), ImageID: spec.ImageID, Tags: tags}, nil
}

// halfOf is half of a docker memory size ("4g" -> "2048m"); "" stays "".
func halfOf(mem string) string {
	mb, err := parseMemMB(mem)
	if err != nil || mb < 2 {
		return ""
	}
	return strconv.Itoa(mb/2) + "m"
}

// DialGuest opens the backend's stream to the guest agent in this cell's
// sandbox machine.
func (d *Driver) DialGuest(ctx context.Context, ref driver.MachineRef) (io.ReadWriteCloser, error) {
	if d.backend.Capabilities().Guest == "" {
		return nil, ErrNoSandboxImage
	}
	exists, err := d.owned(ctx, ref.MachineID)
	if err != nil {
		return nil, err
	}
	if !exists {
		return nil, fmt.Errorf("dockergvisor: sandbox %s is gone", ref.MachineID)
	}
	return d.backend.DialGuest(ctx, ref.MachineID)
}

// ratesFor is a workload's disk and network rates (Config.IOLimits) for
// its size, or the cell's default CPUs; zero when the cell bounds none.
func (d *Driver) ratesFor(size driver.ClaimSize) driver.IORates {
	if d.cfg.IOLimits == nil {
		return driver.IORates{}
	}
	cpus := size.CPUs
	if cpus <= 0 {
		f, _ := strconv.ParseFloat(d.cfg.CPUs, 64)
		cpus = max(1, int(f+0.5))
	}
	return d.cfg.IOLimits.For(cpus)
}
