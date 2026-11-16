// Package lifecycle owns a process's long-lived work: its servers, its
// loops and a driver's background work. Every goroutine it starts has an
// owner that waits for it, and every wait has a deadline: a process that
// stops gives its parts a bounded time to end, then gives up on them.
package lifecycle

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"
)

// ErrGaveUp is a stop whose deadline passed with work still running.
var ErrGaveUp = errors.New("lifecycle: gave up waiting")

// Group runs named parts under one context. The context ends when the
// parent's does, when a part fails, or when Stop is called; every part must
// return once it ends. The zero value is not usable: see New.
type Group struct {
	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup

	mu      sync.Mutex
	closing bool
	running map[string]int
	err     error
}

// New is a group whose context ends with parent's.
func New(parent context.Context) *Group {
	ctx, cancel := context.WithCancel(parent)
	return &Group{ctx: ctx, cancel: cancel, running: map[string]int{}}
}

// Context is the context every part runs under.
func (g *Group) Context() context.Context { return g.ctx }

// Go runs part on a goroutine the group waits for. A part that fails while
// the group runs ends the group, and its error is what Stop returns. Once the
// group is stopping, Go starts nothing and returns false.
func (g *Group) Go(name string, part func(context.Context) error) bool {
	g.mu.Lock()
	if g.closing {
		g.mu.Unlock()
		return false
	}
	g.running[name]++
	g.wg.Add(1)
	g.mu.Unlock()
	go func() {
		defer g.wg.Done()
		err := part(g.ctx)
		g.mu.Lock()
		defer g.mu.Unlock()
		if g.running[name]--; g.running[name] == 0 {
			delete(g.running, name)
		}
		if err != nil && g.err == nil && (g.ctx.Err() == nil || !errors.Is(err, context.Canceled)) {
			g.err = fmt.Errorf("%s: %w", name, err)
			g.cancel()
		}
	}()
	return true
}

// Stop ends the group's context and waits for its parts until deadline
// ends. It returns the first part's failure, joined with ErrGaveUp (naming
// the parts still running) when the deadline passed first.
func (g *Group) Stop(deadline context.Context) error {
	g.close()
	g.cancel()
	return g.wait(deadline)
}

// Drain refuses new parts and lets the running ones end on their own until
// deadline ends; then it ends the group's context, so a part that honors it
// returns, and gives up on them (ErrGaveUp). For work worth finishing (a
// push of a build cache) that must still not hold a stop forever.
func (g *Group) Drain(deadline context.Context) error {
	g.close()
	err := g.wait(deadline)
	g.cancel()
	return err
}

func (g *Group) close() {
	g.mu.Lock()
	g.closing = true
	g.mu.Unlock()
}

func (g *Group) wait(deadline context.Context) error {
	err := WaitWithin(deadline, "", g.wg.Wait)
	g.mu.Lock()
	defer g.mu.Unlock()
	if err != nil {
		names := make([]string, 0, len(g.running))
		for n := range g.running {
			names = append(names, n)
		}
		slices.Sort(names)
		err = fmt.Errorf("%w for %s", ErrGaveUp, strings.Join(names, ", "))
	}
	return errors.Join(g.err, err)
}

// WaitWithin runs wait (a WaitGroup's Wait, a store's) until it returns or
// deadline ends, whichever is first; then ErrGaveUp naming what. A wait it
// gave up on goes on until it returns: what it waits for is already running.
func WaitWithin(deadline context.Context, what string, wait func()) error {
	done := make(chan struct{})
	go func() {
		defer close(done)
		wait()
	}()
	select {
	case <-done:
		return nil
	case <-deadline.Done():
		select {
		case <-done:
			return nil
		default:
		}
		if what == "" {
			return ErrGaveUp
		}
		return fmt.Errorf("%w for %s", ErrGaveUp, what)
	}
}

// Deadline is how long a stopping process gives its parts: a context that
// ends at the deadline, derived from (but never ended by) the process's own.
type Deadline func(context.Context) (context.Context, context.CancelFunc)

// Within is a deadline grace after the stop began.
func Within(grace time.Duration) Deadline {
	return func(ctx context.Context) (context.Context, context.CancelFunc) {
		return context.WithTimeout(context.WithoutCancel(ctx), grace)
	}
}

// Run starts a process's parts with start and keeps them running until ctx
// ends (a signal) or one fails; then it stops them all, and runs each of
// after (what releases what the parts used, such as a driver's Close), all
// within the deadline. It returns start's error, or the first part's, joined
// with what the stop and after returned.
func Run(ctx context.Context, within Deadline, start func(*Group) error, after ...func(context.Context) error) error {
	g := New(ctx)
	err := start(g)
	if err == nil {
		<-g.Context().Done()
	}
	deadline, cancel := within(ctx)
	defer cancel()
	err = errors.Join(err, g.Stop(deadline))
	for _, f := range after {
		if f != nil {
			err = errors.Join(err, f(deadline))
		}
	}
	return err
}

// ServeHTTP is a part that serves srv on l (TLS when srv.TLSConfig is set,
// with its certificates). Once the group ends, the server takes no new
// connection and waits for the requests in flight up to grace, then closes
// what is left.
func ServeHTTP(srv *http.Server, l net.Listener, grace time.Duration) func(context.Context) error {
	return func(ctx context.Context) error {
		served := make(chan error, 1)
		go func() {
			if srv.TLSConfig != nil {
				served <- srv.ServeTLS(l, "", "")
				return
			}
			served <- srv.Serve(l)
		}()
		select {
		case err := <-served:
			if errors.Is(err, http.ErrServerClosed) {
				return nil
			}
			return err
		case <-ctx.Done():
		}
		sctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), grace)
		defer cancel()
		err := srv.Shutdown(sctx)
		if err != nil {
			err = errors.Join(err, srv.Close())
		}
		if serr := <-served; serr != nil && !errors.Is(serr, http.ErrServerClosed) {
			err = errors.Join(err, serr)
		}
		return err
	}
}

// usageError is the operator's mistake: a bad flag or setting.
type usageError struct{ err error }

func (u usageError) Error() string { return u.err.Error() }
func (u usageError) Unwrap() error { return u.err }

// Usage marks err as the operator's (a bad flag or setting): the process
// exits 2. Nil stays nil.
func Usage(err error) error {
	if err == nil {
		return nil
	}
	return usageError{err}
}

// ExitCode is the exit code of a run that returned err: 0 for nil, 2 for a
// Usage error, 1 for any other.
func ExitCode(err error) int {
	var u usageError
	switch {
	case err == nil:
		return 0
	case errors.As(err, &u):
		return 2
	}
	return 1
}
