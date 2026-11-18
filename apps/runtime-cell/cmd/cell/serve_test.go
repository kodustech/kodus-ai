package main

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver/fake"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/lifecycle"
)

// gatedSweeper is a driver's sweep over the fake that, once started, runs
// until the test lets it go, whatever its context says: the in-flight
// background work a stopping cell must wait for.
type gatedSweeper struct {
	d        *fake.Driver
	sweeping chan struct{}
	release  chan struct{}
}

func (s *gatedSweeper) Sweep(ctx context.Context, now time.Time) ([]string, error) {
	select {
	case s.sweeping <- struct{}{}:
	default:
	}
	<-s.release
	refs, err := s.d.List(context.WithoutCancel(ctx), map[string]string{driver.TagCell: "cell-1"})
	if err != nil {
		return nil, err
	}
	var gone []string
	for _, r := range refs {
		if driver.Expired(r.Tags, now) {
			if err := s.d.Destroy(context.WithoutCancel(ctx), r); err != nil {
				return gone, err
			}
			gone = append(gone, r.MachineID)
		}
	}
	return gone, nil
}

// stoppingCell is the cell over the fake driver, with one machine past its
// ceiling for the sweep and an agent that takes claims until its Run ends.
type stoppingCell struct {
	d        *fake.Driver
	sweep    *gatedSweeper
	expired  string
	taking   chan struct{} // closed once the agent takes claims
	stopped  chan struct{} // closed once the agent's Run returned
	closedAt atomic.Value  // what the driver held when it was closed
	closed   chan struct{}
}

func newStoppingCell(t *testing.T) *stoppingCell {
	t.Helper()
	d := fake.NewForCell("cell-1")
	m := d.PlantTags(map[string]string{driver.TagCell: "cell-1", driver.TagHardExpires: driver.FormatTime(time.Now().Add(-time.Hour))})
	return &stoppingCell{
		d: d, expired: m.MachineID,
		sweep:  &gatedSweeper{d: d, sweeping: make(chan struct{}, 1), release: make(chan struct{})},
		taking: make(chan struct{}), stopped: make(chan struct{}), closed: make(chan struct{}),
	}
}

func (c *stoppingCell) parts() cellParts {
	return cellParts{
		log: slog.New(slog.DiscardHandler), kind: fake.Kind, sweeper: c.sweep,
		build: func() (func(context.Context) error, func(context.Context) error, error) {
			return func(ctx context.Context) error {
				close(c.taking)
				<-ctx.Done()
				close(c.stopped)
				return nil
			}, nil, nil
		},
		closeDriver: func(context.Context) error {
			var ids []string
			for _, m := range c.d.Machines() {
				ids = append(ids, m.Ref.MachineID)
			}
			c.closedAt.Store(ids)
			close(c.closed)
			return nil
		},
	}
}

func receive(t *testing.T, ch <-chan struct{}, what string) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(10 * time.Second):
		t.Fatal(what)
	}
}

// main used to start the sweep on a bare goroutine and, on SIGTERM, close
// the driver as the agent's Run returned, with a sweep still destroying
// machines.
func TestOnSIGTERMTheCellStopsTakingClaimsWaitsForTheSweepThenClosesTheDriver(t *testing.T) {
	c := newStoppingCell(t)
	sigterm, signal := context.WithCancel(context.Background())
	served := make(chan error, 1)
	go func() { served <- serveCell(sigterm, lifecycle.Within(time.Minute), c.parts()) }()
	receive(t, c.taking, "the agent never ran")
	receive(t, c.sweep.sweeping, "the sweep never ran")

	signal()
	receive(t, c.stopped, "the agent kept taking claims after SIGTERM")
	select {
	case <-c.closed:
		t.Fatal("the driver was closed with its sweep in flight")
	case err := <-served:
		t.Fatalf("the cell stopped (%v) with its sweep in flight", err)
	case <-time.After(20 * time.Millisecond):
	}
	close(c.sweep.release)
	if err := <-served; err != nil {
		t.Fatal(err)
	}
	if left := c.closedAt.Load().([]string); len(left) != 0 {
		t.Fatalf("the driver was closed before the sweep destroyed %v", left)
	}
}

func TestAStoppingCellGivesUpOnItsSweepAtTheDeadlineAndClosesTheDriver(t *testing.T) {
	c := newStoppingCell(t)
	t.Cleanup(func() { close(c.sweep.release) })
	sigterm, signal := context.WithCancel(context.Background())
	deadline, passed := context.WithCancel(context.Background())
	within := func(context.Context) (context.Context, context.CancelFunc) { return deadline, func() {} }
	served := make(chan error, 1)
	go func() { served <- serveCell(sigterm, within, c.parts()) }()
	receive(t, c.sweep.sweeping, "the sweep never ran")
	signal()
	receive(t, c.stopped, "the agent kept taking claims after SIGTERM")
	passed()
	err := <-served
	if !errors.Is(err, lifecycle.ErrGaveUp) || !strings.Contains(err.Error(), "sweep") {
		t.Fatalf("serveCell: %v", err)
	}
	receive(t, c.closed, "the driver was never closed")
}

// A part that fails (the agent could not be made) stops the cell, and the
// driver opened for it is still closed.
func TestACellThatCannotMakeItsAgentClosesItsDriver(t *testing.T) {
	c := newStoppingCell(t)
	close(c.sweep.release)
	p := c.parts()
	p.build = func() (func(context.Context) error, func(context.Context) error, error) {
		return nil, nil, errors.New("agent: no isolation")
	}
	err := serveCell(context.Background(), lifecycle.Within(time.Minute), p)
	if err == nil || !strings.Contains(err.Error(), "no isolation") {
		t.Fatalf("serveCell: %v", err)
	}
	receive(t, c.closed, "the driver was never closed")
}
