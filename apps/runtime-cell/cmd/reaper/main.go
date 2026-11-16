// Command reaper destroys this cell's machines past kodus:hard-expires. On
// AWS it runs once per EventBridge tick (-once) with its own role, outside
// the cell's VPC; on Kubernetes it is a CronJob with its own service
// account; on a docker-gvisor host it is a systemd timer (-once, deploy/
// docker-gvisor) that reads only Docker and the cell's work directory, so it
// runs whether the cell agent is alive or not. Elsewhere it loops.
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

	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/ec2"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/awsec2"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockergvisor"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/k8ssandbox"
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
	drv := flag.String("driver", "", "aws-ec2 | k8s-sandbox | docker-gvisor | microvm (required)")
	var gv gvisorFlags
	flag.StringVar(&gv.workDir, "workdir", "/var/lib/kodus-cell", "docker-gvisor: the cell's -workdir (builds, caches and resolv.conf under compose/)")
	flag.StringVar(&gv.egress, "gvisor-egress-container", "", "docker-gvisor: the cell's egress container, which leaves a claim network before it goes")
	flag.StringVar(&gv.k8sNamespace, "k8s-namespace", "", "k8s-sandbox: the cell's sandbox namespace, the only one the reaper's Role reaches (required)")
	cellCert := flag.String("cell-cert", "", "the cell's identity certificate (cert.pem cell register wrote): its CN is the cell id, when -cell-id is empty (a Kubernetes cell's id exists only after it registered)")
	flag.StringVar(&gv.microvmState, "firecracker-state-dir", "/var/lib/kodus-cell/state/microvm", "microvm: the cell's -firecracker-state-dir (its records, jails and states; default the cell's <workdir>/state/microvm)")
	once := flag.Bool("once", false, "run one pass and exit (Lambda, cron)")
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
		return lifecycle.Usage(fmt.Errorf("unsupported driver %q (supported: aws-ec2, k8s-sandbox, docker-gvisor, microvm)", *drv))
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

// gvisorFlags are what the docker-gvisor, k8s-sandbox and microvm reapers
// read of the cell's setup.
type gvisorFlags struct{ workDir, egress, k8sNamespace, microvmState string }

// newDriver is the reaper's list-and-destroy driver and its orphan pass (nil
// for a driver with none). No fake: a reaper on an in-memory driver reaps
// nothing and would look healthy.
func newDriver(ctx context.Context, name, cellID string, gv gvisorFlags) (reaper.MachineReaper, reaper.OrphanReaper, error) {
	switch name {
	case awsec2.Kind:
		cfg, err := config.LoadDefaultConfig(ctx)
		if err != nil {
			return nil, nil, err
		}
		return awsec2.NewForReaper(ec2.NewFromConfig(cfg), cellID), nil, nil
	case k8ssandbox.Kind:
		// In the cluster, with the reaper's service account: list, get and
		// delete pods in the sandbox namespace, nothing else (the
		// kodus-runtime chart's reaper Role).
		if gv.k8sNamespace == "" {
			return nil, nil, errors.New("reaper: k8s-sandbox needs -k8s-namespace, the cell's sandbox namespace")
		}
		k, err := k8ssandbox.InClusterClient()
		if err != nil {
			return nil, nil, err
		}
		return k8ssandbox.NewForReaper(k, cellID, gv.k8sNamespace), nil, nil
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
