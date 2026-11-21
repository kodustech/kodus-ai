package lifecycle

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"
)

// within fails the test unless ch delivers before the watchdog: a guard
// against a deadlock, never a wait for time to pass.
func within(t *testing.T, ch <-chan struct{}, what string) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(10 * time.Second):
		t.Fatal(what)
	}
}

// expired is a deadline that has already passed.
func expired() context.Context {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	return ctx
}

func TestStopEndsEveryPartAndWaitsForIt(t *testing.T) {
	g := New(context.Background())
	ended := make(chan struct{}, 2)
	for _, n := range []string{"a", "b"} {
		g.Go(n, func(ctx context.Context) error {
			<-ctx.Done()
			ended <- struct{}{}
			return ctx.Err()
		})
	}
	if err := g.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(ended) != 2 {
		t.Fatalf("Stop returned with %d of 2 parts ended", len(ended))
	}
	if g.Go("late", func(context.Context) error { return nil }) {
		t.Fatal("a stopped group started a part")
	}
}

func TestAFailingPartEndsTheGroupAndStopReturnsItsError(t *testing.T) {
	g := New(context.Background())
	g.Go("other", func(ctx context.Context) error { <-ctx.Done(); return nil })
	g.Go("listener", func(context.Context) error { return errors.New("port taken") })
	within(t, g.Context().Done(), "the failure did not end the group")
	err := g.Stop(context.Background())
	if err == nil || !strings.Contains(err.Error(), "listener: port taken") {
		t.Fatalf("Stop: %v", err)
	}
}

func TestStopGivesUpAtTheDeadlineAndNamesWhatStillRuns(t *testing.T) {
	g := New(context.Background())
	release := make(chan struct{})
	t.Cleanup(func() { close(release) })
	g.Go("sweep", func(context.Context) error { <-release; return nil }) // ignores its context
	err := g.Stop(expired())
	if !errors.Is(err, ErrGaveUp) || !strings.Contains(err.Error(), "sweep") {
		t.Fatalf("Stop: %v", err)
	}
}

func TestDrainLetsRunningWorkFinishBeforeEndingItsContext(t *testing.T) {
	g := New(context.Background())
	started, release := make(chan struct{}), make(chan struct{})
	var canceledEarly bool
	g.Go("push", func(ctx context.Context) error {
		close(started)
		<-release
		canceledEarly = ctx.Err() != nil
		return nil
	})
	<-started
	drained := make(chan error, 1)
	go func() { drained <- g.Drain(context.Background()) }()
	select {
	case err := <-drained:
		t.Fatalf("Drain returned (%v) while a push runs", err)
	case <-time.After(20 * time.Millisecond):
	}
	if g.Go("push", func(context.Context) error { return nil }) {
		t.Fatal("a draining group started a part")
	}
	close(release)
	if err := <-drained; err != nil {
		t.Fatal(err)
	}
	if canceledEarly {
		t.Fatal("Drain ended the push's context before its deadline")
	}
}

func TestDrainEndsTheContextAtTheDeadline(t *testing.T) {
	g := New(context.Background())
	ended := make(chan struct{})
	g.Go("push", func(ctx context.Context) error { <-ctx.Done(); close(ended); return ctx.Err() })
	if err := g.Drain(expired()); !errors.Is(err, ErrGaveUp) {
		t.Fatalf("Drain: %v", err)
	}
	within(t, ended, "the push's context did not end at the deadline")
}

func TestRunStopsWhatStartedWhenStartFails(t *testing.T) {
	stopped := make(chan struct{})
	var closed bool
	err := Run(context.Background(), Within(time.Minute), func(g *Group) error {
		g.Go("metrics", func(ctx context.Context) error { <-ctx.Done(); close(stopped); return nil })
		return errors.New("control tls: no key")
	}, func(context.Context) error { closed = true; return nil })
	if err == nil || !strings.Contains(err.Error(), "no key") {
		t.Fatalf("Run: %v", err)
	}
	within(t, stopped, "the part started before the failure still runs")
	if !closed {
		t.Fatal("after did not run")
	}
}

func TestRunStopsOnTheSignalThenRunsAfter(t *testing.T) {
	ctx, signal := context.WithCancel(context.Background())
	var order []string
	done := make(chan error, 1)
	go func() {
		done <- Run(ctx, Within(time.Minute), func(g *Group) error {
			g.Go("loop", func(ctx context.Context) error { <-ctx.Done(); order = append(order, "loop"); return nil })
			return nil
		}, func(context.Context) error { order = append(order, "close"); return nil })
	}()
	signal()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(order) != "[loop close]" {
		t.Fatalf("order %v", order)
	}
}

// A stopping server finishes the request it is serving, then refuses.
func TestServeHTTPFinishesTheRequestInFlight(t *testing.T) {
	l, err := new(net.ListenConfig).Listen(context.Background(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	inHandler, release := make(chan struct{}), make(chan struct{})
	srv := &http.Server{ReadHeaderTimeout: time.Second, Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		close(inHandler)
		<-release
		_, _ = io.WriteString(w, "done")
	})}
	g := New(context.Background())
	g.Go("http", ServeHTTP(srv, l, time.Minute))
	url := "http://" + l.Addr().String()
	got := make(chan string, 1)
	go func() {
		req, _ := http.NewRequestWithContext(context.Background(), http.MethodGet, url, nil)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			got <- err.Error()
			return
		}
		defer func() { _ = resp.Body.Close() }()
		b, _ := io.ReadAll(resp.Body)
		got <- string(b)
	}()
	within(t, inHandler, "the request never reached the handler")
	stopped := make(chan error, 1)
	go func() { stopped <- g.Stop(context.Background()) }()
	close(release)
	if b := <-got; b != "done" {
		t.Fatalf("the request in flight got %q", b)
	}
	if err := <-stopped; err != nil {
		t.Fatal(err)
	}
	req, _ := http.NewRequestWithContext(context.Background(), http.MethodGet, url, nil)
	if resp, err := http.DefaultClient.Do(req); err == nil {
		_ = resp.Body.Close()
		t.Fatal("a stopped server answered")
	}
}

func TestExitCodes(t *testing.T) {
	for _, c := range []struct {
		err  error
		want int
	}{{nil, 0}, {errors.New("listen: busy"), 1}, {Usage(errors.New("-driver: unknown")), 2}, {fmt.Errorf("settings: %w", Usage(errors.New("bad"))), 2}} {
		if got := ExitCode(c.err); got != c.want {
			t.Errorf("ExitCode(%v) = %d, want %d", c.err, got, c.want)
		}
	}
	if Usage(nil) != nil {
		t.Fatal("Usage(nil) is an error")
	}
}

// A stopping server lets the work that ends within its grace end on its
// own, and cuts the work past it: the work's context ends, and the drain
// returns once that work has.
func TestDrainThenCutLetsQuickWorkEndAndCutsTheRest(t *testing.T) {
	var cuts int
	quick, cutQuick := context.WithCancel(context.Background())
	var work sync.WaitGroup
	work.Go(func() {})
	DrainThenCut(&work, cutQuick, time.Hour, func() { cuts++ })
	if cuts != 0 || quick.Err() == nil {
		t.Fatalf("work that ended was cut %d times, or its context outlived the drain", cuts)
	}

	slow, cutSlow := context.WithCancel(context.Background())
	ended := make(chan struct{})
	work.Go(func() { <-slow.Done(); close(ended) })
	done := make(chan struct{})
	go func() { DrainThenCut(&work, cutSlow, 10*time.Millisecond, func() { cuts++ }); close(done) }()
	within(t, done, "the drain never cut the work past its grace")
	select {
	case <-ended:
	default:
		t.Fatal("the drain returned before the work it cut")
	}
	if cuts != 1 {
		t.Fatalf("cut %d times", cuts)
	}
}
