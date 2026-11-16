package localdocker

import (
	"context"
	"fmt"
	"path/filepath"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/kodyexec"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/transport"
)

// Transport is the local directory transport plus the boot: when the cell
// uploads the extracted checkout into the workload, the driver brings its
// compose project up from there. Exec runs on the host, in the checkout,
// with no isolation (like the fake cell).
type Transport struct {
	Local  transport.Local
	Driver *Driver
}

// Transport returns the transport that goes with this driver: machine files
// under Config.MachinesDir.
func (d *Driver) Transport() Transport {
	return Transport{Local: transport.Local{Root: d.cfg.MachinesDir}, Driver: d}
}

func (t Transport) Exec(ctx context.Context, ref driver.MachineRef, req kodyexec.Request) (kodyexec.Result, error) {
	return t.Local.Exec(ctx, ref, req)
}

func (t Transport) Upload(ctx context.Context, ref driver.MachineRef, srcDir, dst string, output func(line string)) error {
	if t.Local.Root == "" {
		return fmt.Errorf("localdocker: transport needs a machines dir")
	}
	if err := t.Local.Upload(ctx, ref, srcDir, dst, nil); err != nil {
		return err
	}
	if !isWorkload(ref) || dst != "workspace" {
		return nil
	}
	// The boot's compose commands tee their lines to output.
	return t.Driver.Boot(dockercli.WithOutput(ctx, output), ref, filepath.Join(t.Local.Root, ref.MachineID, dst))
}

var _ transport.Transport = Transport{}
