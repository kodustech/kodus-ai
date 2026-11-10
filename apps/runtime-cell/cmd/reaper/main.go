// Command reaper destroys this cell's machines past kodus:hard-expires. On
// AWS it runs once per EventBridge tick (-once) with its own role, outside
// the cell's VPC; on Kubernetes it is a CronJob with its own service
// account; on a docker-gvisor host it is a systemd timer (-once, deploy/
// docker-gvisor) that reads only Docker and the cell's work directory, so it
// runs whether the cell agent is alive or not. Elsewhere it loops.
package main

import (
	"context"
	"errors"
	"flag"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/ec2"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/awsec2"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockergvisor"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/k8ssandbox"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/reaper"
)

func main() {
	cellID := flag.String("cell-id", os.Getenv("KODUS_CELL_ID"), "cell id (kodus:cell tag)")
	drv := flag.String("driver", "", "aws-ec2 | k8s-sandbox | docker-gvisor (required)")
	var gv gvisorFlags
	flag.StringVar(&gv.workDir, "workdir", "/var/lib/kodus-cell", "docker-gvisor: the cell's -workdir (builds, caches and resolv.conf under compose/)")
	flag.StringVar(&gv.egress, "gvisor-egress-container", "", "docker-gvisor: the cell's egress container, which leaves a claim network before it goes")
	once := flag.Bool("once", false, "run one pass and exit (Lambda, cron)")
	every := flag.Duration("every", time.Minute, "interval when looping")
	flag.Parse()
	log := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
	defer stop()

	d, err := newDriver(ctx, *drv, *cellID, gv)
	if errors.Is(err, errUnsupported) {
		log.Error("unsupported driver", "driver", *drv, "supported", "aws-ec2, k8s-sandbox, docker-gvisor")
		os.Exit(2)
	}
	if err != nil {
		log.Error("driver", "driver", *drv, "err", err)
		os.Exit(1)
	}
	r := &reaper.Reaper{CellID: *cellID, Log: log, Driver: d}
	if *once {
		rep, err := r.Run(ctx)
		log.Info("reaper.pass", "seen", rep.Seen, "terminated", len(rep.Terminated), "err", err)
		if err != nil {
			os.Exit(1)
		}
		return
	}
	r.Loop(ctx, *every)
}

var errUnsupported = errors.New("reaper: unsupported driver")

// gvisorFlags are what the docker-gvisor reaper reads of the cell's setup.
type gvisorFlags struct{ workDir, egress string }

// newDriver is the reaper's list-and-destroy driver. No fake: a reaper on
// an in-memory driver reaps nothing and would look healthy.
func newDriver(ctx context.Context, name, cellID string, gv gvisorFlags) (reaper.MachineReaper, error) {
	switch name {
	case "aws-ec2":
		cfg, err := config.LoadDefaultConfig(ctx)
		if err != nil {
			return nil, err
		}
		return awsec2.NewForReaper(ec2.NewFromConfig(cfg), cellID), nil
	case "k8s-sandbox":
		// In the cluster, with the reaper's service account: list, get and
		// delete pods, nothing else (deploy/chart rbac.yaml).
		k, err := k8ssandbox.InClusterPodClient()
		if err != nil {
			return nil, err
		}
		return k8ssandbox.NewForReaper(k, cellID), nil
	case dockergvisor.Kind:
		// On the host, with the Docker socket: the cell's containers,
		// volumes, images and networks, found by their kodus.cell label.
		return dockergvisor.NewForReaper(dockercli.CLI{}, dockergvisor.ReaperConfig{
			CellID: cellID, WorkDir: filepath.Join(gv.workDir, "compose"), EgressContainer: gv.egress,
			Log: slog.New(slog.NewJSONHandler(os.Stderr, nil)).With("driver", dockergvisor.Kind),
		})
	}
	return nil, errUnsupported
}
