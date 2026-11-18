package dockergvisor

import (
	"context"
	"errors"
	"time"
)

// closeTimeout bounds Close: what the reclaim and the pushes in flight get
// to end.
const closeTimeout = 30 * time.Second

// Shutdown stops the driver's background work, then closes it. No reclaim
// or push starts any more; the running ones, and the build state's own
// (a spare's clone, a released view's removal), get until deadline ends to
// finish. Then the pushes' context ends and the driver gives up on what is
// left (lifecycle.ErrGaveUp, naming it). The bake catalog closes last, in
// every case.
func (d *Driver) Shutdown(deadline context.Context) error {
	d.bg.Go("build state", func(context.Context) error { d.states.Settle(); return nil })
	return errors.Join(d.bg.Drain(deadline), d.closeCatalog())
}

// Close is Shutdown within closeTimeout.
func (d *Driver) Close() error {
	ctx, cancel := context.WithTimeout(context.Background(), closeTimeout)
	defer cancel()
	return d.Shutdown(ctx)
}
