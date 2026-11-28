// Command reaper destroys this cell's machines past kodus:hard-expires. On a
// docker-gvisor host it is a systemd timer (-once, deploy/docker-gvisor) that
// reads only Docker and the cell's work directory, so it runs whether the
// cell agent is alive or not. Elsewhere it loops.
package main

import (
	"context"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/telemetry"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockergvisor"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/microvm"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/lifecycle"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/reaper"
)

func main() {
	log := slog.New(telemetry.NewHandler(slog.NewJSONHandler(os.Stderr, nil)))
	if err := run(log); err != nil {
		log.Error("reaper.failed", "err", err)
		os.Exit(lifecycle.ExitCode(err))
	}
}

// run reaps once (-once) or every -every until SIGTERM or SIGINT; a pass in
// flight ends with the signal's context. A missing cell id or an unknown
// driver is the operator's (exit 2). Every defer runs on the way out.
func run(log *slog.Logger) error {
	cellID := flag.String("cell-id", os.Getenv("KODUS_CELL_ID"), "cell id (kodus:cell tag)")
	drv := flag.String("driver", "", "docker-gvisor | microvm (required)")
	var gv gvisorFlags
	flag.StringVar(&gv.workDir, "workdir", "/var/lib/kodus-cell", "docker-gvisor: the cell's -workdir (builds, caches and resolv.conf under compose/)")
	flag.StringVar(&gv.egress, "gvisor-egress-container", "", "docker-gvisor: the cell's egress container, which leaves a claim network before it goes")
	cellCert := flag.String("cell-cert", "", "the cell's identity certificate (cert.pem cell register wrote): its CN is the cell id, when -cell-id is empty (a cell's id exists only after it registered)")
	flag.StringVar(&gv.microvmState, "firecracker-state-dir", "/var/lib/kodus-cell/state/microvm", "microvm: the cell's -firecracker-state-dir (its records, jails and states; default the cell's <workdir>/state/microvm)")
	once := flag.Bool("once", false, "run one pass and exit (systemd timer, cron)")
	every := flag.Duration("every", time.Minute, "interval when looping")
	flag.Parse()
	if *cellID == "" && *cellCert != "" {
		id, err := cellIDFromCert(*cellCert)
		if err != nil {
			return fmt.Errorf("cell id from %s: %w", *cellCert, err)
		}
		*cellID = id
	}
	if *cellID == "" {
		return lifecycle.Usage(errors.New("cell id: -cell-id or -cell-cert is required"))
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
	defer stop()

	d, orphans, err := newDriver(ctx, *drv, *cellID, gv)
	if errors.Is(err, errUnsupported) {
		return lifecycle.Usage(fmt.Errorf("unsupported driver %q (supported: docker-gvisor, microvm)", *drv))
	}
	if err != nil {
		return fmt.Errorf("driver %s: %w", *drv, err)
	}
	r := &reaper.Reaper{CellID: *cellID, Log: log, Driver: d, Orphans: orphans}
	if *once {
		rep, err := r.Run(ctx)
		log.Info("reaper.pass", "seen", rep.Seen, "terminated", len(rep.Terminated), "orphans", len(rep.Orphans), "err", err)
		return err
	}
	r.Loop(ctx, *every)
	return nil
}

var errUnsupported = errors.New("reaper: unsupported driver")

// cellIDFromCert is the CN of the cell's identity certificate.
func cellIDFromCert(path string) (string, error) {
	b, err := os.ReadFile(path) //nolint:gosec // G304: the operator's -cell-cert
	if err != nil {
		return "", err
	}
	blk, _ := pem.Decode(b)
	if blk == nil {
		return "", errors.New("reaper: no PEM certificate")
	}
	c, err := x509.ParseCertificate(blk.Bytes)
	if err != nil {
		return "", err
	}
	if c.Subject.CommonName == "" {
		return "", errors.New("reaper: the certificate has no CN")
	}
	return c.Subject.CommonName, nil
}

// gvisorFlags are what the docker-gvisor and microvm reapers read of the
// cell's setup.
type gvisorFlags struct{ workDir, egress, microvmState string }

// newDriver is the reaper's list-and-destroy driver and its orphan pass (nil
// for a driver with none). No fake: a reaper on an in-memory driver reaps
// nothing and would look healthy.
func newDriver(_ context.Context, name, cellID string, gv gvisorFlags) (reaper.MachineReaper, reaper.OrphanReaper, error) {
	switch name {
	case dockergvisor.Kind:
		// On the host, with the Docker socket: the cell's containers,
		// volumes, images and networks, found by their kodus.cell label.
		r, err := dockergvisor.NewForReaper(dockercli.CLI{}, dockergvisor.ReaperConfig{
			CellID: cellID, WorkDir: filepath.Join(gv.workDir, "compose"), EgressContainer: gv.egress,
			Log: slog.New(telemetry.NewHandler(slog.NewJSONHandler(os.Stderr, nil))).With("driver", dockergvisor.Kind),
		})
		if err != nil {
			return nil, nil, err
		}
		return r, r, nil
	case microvm.Kind:
		// On the KVM host, as root: the cell's machine records, their VMMs,
		// cgroups, jails and taps, and whatever of those no record names.
		r, err := microvm.NewForReaper(cellID, gv.microvmState)
		if err != nil {
			return nil, nil, err
		}
		return r, r, nil
	}
	return nil, nil, errUnsupported
}
