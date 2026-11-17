// Command observer is the claim's observer machine (ADR-053): it serves the
// cell agent over mTLS, runs typed HTTP and read-only SQL probes against
// the claim's VM and keeps the request log by method and route.
package main

import (
	"context"
	"errors"
	"flag"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"syscall"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/hubclient"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/lifecycle"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/observer/observersrv"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/telemetry"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/version"
)

// devEnv must be 1 for -insecure-dev, as for the local-docker driver.
const devEnv = "KODY_RUNTIME_DEV"

func main() {
	log := slog.New(telemetry.NewHandler(slog.NewJSONHandler(os.Stderr, nil)))
	if err := run(log); err != nil {
		log.Error("observer.failed", "err", err)
		os.Exit(lifecycle.ExitCode(err))
	}
}

// run serves the cell agent until SIGTERM or SIGINT (observersrv.Run lets
// the requests in flight end). -insecure-dev without its variable is the
// operator's (exit 2). Every defer runs on the way out.
func run(log *slog.Logger) error {
	listen := flag.String("listen", ":7443", "address for the cell agent")
	cellID := flag.String("cell-id", os.Getenv("KODUS_CELL_ID"), "cell id")
	cert := flag.String("cert", "/etc/kodus/observer/cert.pem", "server certificate")
	key := flag.String("key", "/etc/kodus/observer/key.pem", "server key")
	ca := flag.String("ca", "/etc/kodus/observer/ca.pem", "CA of the cell agent's certificate")
	insecure := flag.Bool("insecure-dev", false, "plain HTTP, local development only (needs "+devEnv+"=1)")
	// The read-only user is created at bake from the seed; {address} is the
	// claim VM's host:port.
	dsn := flag.String("sql-dsn", os.Getenv("KODUS_OBSERVER_SQL_DSN"), "DSN template, e.g. postgres://kody_observer@{address}/app?sslmode=disable")
	bridge := flag.String("stdio-bridge", "", "carry one connection between stdin and stdout and this loopback address, then exit (the cell's way in over pods/exec on Kubernetes); serves nothing")
	flag.Parse()
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
	defer stop()
	if *bridge != "" {
		return observersrv.Bridge(ctx, *bridge, os.Stdin, os.Stdout)
	}
	log.Info("observer.start", "version", version.Get())

	if *insecure {
		if os.Getenv(devEnv) != "1" {
			return lifecycle.Usage(errors.New("observer.insecure_dev refused: needs " + devEnv + "=1"))
		}
		log.Warn("observer.insecure_dev")
	}
	l, err := (&net.ListenConfig{}).Listen(ctx, "tcp", *listen)
	if err != nil {
		return err
	}
	return observersrv.Run(ctx, observersrv.Options{
		Listener: l, CellID: *cellID, NewID: hubclient.NewID, Cert: *cert, Key: *key, CA: *ca, Insecure: *insecure, SQLDSN: *dsn, Log: log,
	})
}
