package main

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/lifecycle"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/metrics"
)

// shutdownGrace is what a stopping cell gives its parts and its driver's
// background work (a sweep, a disk reclaim, a cache push) before it closes
// the driver anyway: under Kubernetes' default 30 s grace, inside systemd's
// default 90 s.
const shutdownGrace = 25 * time.Second

// part is one long-lived piece of the cell beside the agent.
type part struct {
	name string
	run  func(context.Context) error
	// release frees what the part holds when it never ran (nil: nothing).
	release func()
}

// cellParts is what the cell runs once its driver is open.
type cellParts struct {
	log *slog.Logger
	// kind names the driver in the sweep's log lines; sweeper is its sweep
	// (driver.Parts.Sweeper), nil when the reaper alone ends machines.
	kind    string
	sweeper driver.Sweeper
	// loops run beside the agent: the certificate's renewal, /metrics.
	loops []part
	// build makes the agent once the driver is open (what may still fail:
	// observers, egress control, memory admission). It returns the agent's
	// Run, which takes claims until its context ends, and what to release
	// once the agent stopped (nil: nothing).
	build func() (run func(context.Context) error, release func(context.Context) error, err error)
	// closeDriver releases what the driver's Open started, its background
	// work first (nil: nothing).
	closeDriver func(context.Context) error
}

// serveCell runs the cell until ctx ends (SIGTERM, SIGINT) or a part
// fails: the agent, which takes the claims, the driver's sweep and the
// loops beside them. Then it stops them all (the agent takes no claim once
// its Run returned), waits for them, releases what the agent used, and
// closes the driver, which waits for its own background work: all within
// the one deadline.
func serveCell(ctx context.Context, within lifecycle.Deadline, c cellParts) error {
	var release func(context.Context) error
	return lifecycle.Run(ctx, within, func(g *lifecycle.Group) error {
		for _, l := range c.loops {
			g.Go(l.name, l.run)
		}
		if c.sweeper != nil {
			g.Go("sweep", func(ctx context.Context) error {
				sweepExpired(ctx, c.log, c.kind, c.sweeper.Sweep)
				return nil
			})
		}
		run, rel, err := c.build()
		release = rel
		if err != nil {
			return err
		}
		g.Go("agent", run)
		return nil
	}, func(ctx context.Context) error {
		if release == nil {
			return nil
		}
		return release(ctx)
	}, c.closeDriver)
}

// sweepExpired runs the driver's Sweeper (Parts.Sweeper) at start and every
// minute until ctx ends: what a crashed or killed cell left past its
// claims' ceilings. For docker-gvisor it also starts the reclaim of the disk
// no build holds (its BuildKit states below the disk floor), which runs as
// the driver's own background work and never holds this loop.
func sweepExpired(ctx context.Context, log *slog.Logger, driver string, sweep func(context.Context, time.Time) ([]string, error)) {
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	for {
		gone, err := sweep(ctx, time.Now())
		if len(gone) > 0 || (err != nil && ctx.Err() == nil) {
			log.Warn(driver+".sweep", "destroyed", gone, "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// metricsServer listens for /metrics on addr and returns the part that
// serves it ("" or "off": no part, and nothing listens).
func metricsServer(ctx context.Context, log *slog.Logger, addr string, reg *metrics.Registry) (*part, error) {
	if addr == "" || addr == "off" {
		return nil, nil //nolint:nilnil // no address is no server, not a failure
	}
	l, err := new(net.ListenConfig).Listen(ctx, "tcp", addr)
	if err != nil {
		return nil, err
	}
	mux := http.NewServeMux()
	mux.Handle("GET /metrics", reg.Handler())
	srv := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	log.Info("metrics.listening", "addr", l.Addr().String())
	serve := lifecycle.ServeHTTP(srv, l, 5*time.Second)
	return &part{name: "metrics", run: func(ctx context.Context) error {
		if err := serve(ctx); err != nil && !errors.Is(err, context.Canceled) {
			log.Error("metrics.serve", "err", err)
		}
		return nil // the cell keeps taking claims without /metrics
	}, release: func() { _ = l.Close() }}, nil
}
