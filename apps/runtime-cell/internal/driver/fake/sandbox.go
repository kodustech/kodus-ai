//go:build unix

package fake

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/guest"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/machinetrust"
)

// Sandboxes is the fake's Sandboxer: each sandbox is a directory under Root
// (Root/<machine>/workspace, where transport.Local runs its commands too)
// and the real guest agent, in process, serves it over a pipe. It isolates
// nothing; the dev cell and the integration run use it to drive the whole
// sandbox path with the real guest agent's bounds and no-follow rules.
type Sandboxes struct {
	Driver *Driver
	Root   string
	// Trust are the cell's trust files (machinetrust). A sandbox made for a
	// claim with SandboxRequest.CellTrust gets the trust variables pointing at
	// them where they are on the host, standing in for the mounts a real
	// driver makes. Zero: none.
	Trust machinetrust.Files
}

var _ driver.Sandboxer = Sandboxes{}

func (s Sandboxes) dir(id string) string { return filepath.Join(s.Root, id, "workspace") }

func (s Sandboxes) CreateSandbox(ctx context.Context, req driver.SandboxRequest) (driver.MachineRef, error) {
	if req.CellTrust && !s.Driver.Capabilities().SandboxCellTrust {
		return driver.MachineRef{}, fmt.Errorf("%w: fake set to give sandboxes no trust files", driver.ErrUnsupported)
	}
	ref, err := s.Driver.Create(ctx, req.Spec)
	if err != nil {
		return driver.MachineRef{}, err
	}
	if err := os.MkdirAll(s.dir(ref.MachineID), 0o700); err != nil {
		return driver.MachineRef{}, errors.Join(err, s.Driver.Destroy(context.WithoutCancel(ctx), ref))
	}
	s.Driver.mu.Lock()
	s.Driver.machines[ref.MachineID].CellTrust = req.CellTrust
	s.Driver.mu.Unlock()
	return ref, nil
}

func (s Sandboxes) DialGuest(ctx context.Context, ref driver.MachineRef) (io.ReadWriteCloser, error) {
	s.Driver.mu.Lock()
	m, ok := s.Driver.machines[ref.MachineID]
	gone := !ok || m.Destroyed
	trusted := ok && m.CellTrust && s.Trust.Set()
	s.Driver.mu.Unlock()
	if gone {
		// A destroyed sandbox's files go with it.
		_ = os.RemoveAll(filepath.Join(s.Root, ref.MachineID))
		return nil, fmt.Errorf("fake: sandbox %s is gone", ref.MachineID)
	}
	fs, err := guest.OpenRoot(s.dir(ref.MachineID))
	if err != nil {
		return nil, err
	}
	fs.WithPath(os.Getenv("PATH")) // the host's tools: the fake runs them on the host
	if trusted {
		fs.WithEnv(machinetrust.Env(s.Trust.Bundle, s.Trust.CellCA))
	}
	cell, machine := net.Pipe()
	go func() {
		_ = guest.Serve(context.WithoutCancel(ctx), machine, machine, fs)
		_ = machine.Close()
		_ = fs.Close()
	}()
	return cell, nil
}
