//go:build unix

// Command kody-guest is the guest agent of a code sandbox (internal/guest):
// it runs inside the machine and serves the cell's sandbox.op frames on a
// byte stream, its stdio (-stdio, what docker exec -i gives the cell), a
// unix socket (-listen) or a vsock port (-vsock, in a microVM), the root of
// every file operation being -root.
//
// As a microVM's first process (PID 1, the kernel's init=) it sets the
// machine up from its profile and boot values (internal/guestinit) and
// starts itself again as the -vsock server.
//
// "kody-guest observer -vsock PORT ..." is a claim's observer (ADR-053) in an
// observer microVM: the cell starts it there through the guest agent and
// reaches it over the VM's vsock only; it probes the claim's machines on
// their bridge, and nothing on that network can reach its control channel.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/guest"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/guestinit"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/lifecycle"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/observer/observersrv"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/vsock"
)

func main() {
	if os.Getpid() == 1 {
		// Nothing before guestinit.Run may read /proc or rely on PATH: the
		// kernel gives PID 1 neither.
		err := guestinit.Run()
		// PID 1 returning ends the machine (panic=1): say why first.
		fmt.Fprintln(os.Stderr, "kody-guest: init:", err)
		os.Exit(1)
	}
	if len(os.Args) > 1 && os.Args[1] == "observer" {
		os.Exit(observe(os.Args[2:]))
	}
	root := flag.String("root", "/workspace", "the directory every file operation stays under")
	stdio := flag.Bool("stdio", false, "serve one stream on stdin and stdout")
	listen := flag.String("listen", "", "serve every connection of this unix socket path")
	vport := flag.Uint("vsock", 0, "serve every host connection on this vsock port (in a microVM)")
	flag.Parse()
	if *vport > 1<<32-1 {
		fmt.Fprintln(os.Stderr, "kody-guest: -vsock is a 32-bit port")
		os.Exit(2)
	}
	if err := run(*root, *stdio, *listen, uint32(*vport)); err != nil { //nolint:gosec // G115: bounded to 32 bits just above
		fmt.Fprintln(os.Stderr, "kody-guest:", err)
		os.Exit(1)
	}
}

func run(root string, stdio bool, listen string, vport uint32) error {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	modes := 0
	for _, on := range []bool{stdio, listen != "", vport != 0} {
		if on {
			modes++
		}
	}
	if modes != 1 {
		return errors.New("give exactly one of -stdio, -listen and -vsock")
	}
	// Before any stream opens: the sandbox's commands run as this process's
	// user and must not open its fds or trace it (internal/guest Undumpable).
	if err := guest.Undumpable(); err != nil {
		return fmt.Errorf("undumpable: %w", err)
	}
	fs, err := guest.OpenRoot(root)
	if err != nil {
		return err
	}
	defer func() { _ = fs.Close() }()
	// The cell mounts its CA only into the sandbox of a claim with org
	// secrets; the commands then trust it through the usual variables.
	fs.WithEnv(guest.MountedTrustEnv())
	if stdio {
		return guest.Serve(ctx, os.Stdin, os.Stdout, fs)
	}
	var accept func() (io.ReadWriteCloser, error)
	var closer io.Closer
	if vport != 0 {
		l, err := vsock.Listen(vport)
		if err != nil {
			return err
		}
		accept, closer = l.Accept, l
	} else {
		l, err := (&net.ListenConfig{}).Listen(ctx, "unix", listen)
		if err != nil {
			return err
		}
		accept, closer = func() (io.ReadWriteCloser, error) { return l.Accept() }, l
	}
	defer func() { _ = closer.Close() }()
	stopAccepting := context.AfterFunc(ctx, func() { _ = closer.Close() })
	defer stopAccepting()
	// Every stream is joined before the root closes (the deferred fs.Close
	// runs after this), for at most streamsGrace once a stop began.
	var streams sync.WaitGroup
	defer func() {
		deadline, cancel := lifecycle.Within(streamsGrace)(ctx)
		defer cancel()
		if err := lifecycle.WaitWithin(deadline, "streams", streams.Wait); err != nil {
			fmt.Fprintln(os.Stderr, "kody-guest:", err)
		}
	}()
	slots := make(chan struct{}, maxStreams)
	for {
		select {
		case slots <- struct{}{}:
		case <-ctx.Done():
			return nil
		}
		conn, err := accept()
		if err != nil {
			<-slots
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		streams.Add(1)
		go func() {
			defer streams.Done()
			defer func() { <-slots }()
			defer func() { _ = conn.Close() }()
			_ = guest.Serve(ctx, conn, conn, fs)
		}()
	}
}

const (
	// maxStreams bounds the connections served at once; the next one waits
	// in the listen backlog until a stream ends. The cell holds a few per
	// sandbox (its guest client, a file transfer).
	maxStreams = 64
	// streamsGrace is what the streams in flight get to end once the guest
	// stops.
	streamsGrace = 5 * time.Second
)

// observe runs the claim's observer on a vsock port of an observer microVM.
func observe(args []string) int {
	fs := flag.NewFlagSet("observer", flag.ContinueOnError)
	port := fs.Uint("vsock", 7443, "the vsock port the cell reaches the observer on")
	cellID := fs.String("cell-id", "", "cell id")
	cert := fs.String("cert", "", "server certificate")
	key := fs.String("key", "", "server key")
	ca := fs.String("ca", "", "CA of the cell agent's certificate")
	if err := fs.Parse(args); err != nil || *port == 0 || *port > 1<<32-1 || *cert == "" || *key == "" || *ca == "" {
		fmt.Fprintln(os.Stderr, "kody-guest observer: -vsock, -cert, -key and -ca are required")
		return 2
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	l, err := vsock.ListenNet(uint32(*port))
	if err != nil {
		fmt.Fprintln(os.Stderr, "kody-guest observer:", err)
		return 1
	}
	if err := observersrv.Run(ctx, observersrv.Options{Listener: l, CellID: *cellID, NewID: guest.NewID, Cert: *cert, Key: *key, CA: *ca}); err != nil {
		fmt.Fprintln(os.Stderr, "kody-guest observer:", err)
		return 1
	}
	return 0
}
