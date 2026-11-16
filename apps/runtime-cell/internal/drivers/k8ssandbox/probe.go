package k8ssandbox

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

// RunProbe is `cell probe`, the preflight's probe pod: it writes the
// kernel release it runs under and whether dialing -dial connected to
// -out (the container's termination message), and exits 0 when it could
// write them. It decides nothing: the cell reads the result.
func RunProbe(args []string, stderr io.Writer) int {
	fs := flag.NewFlagSet("cell probe", flag.ContinueOnError)
	fs.SetOutput(stderr)
	target := fs.String("dial", "", "host:port the namespace's policies must refuse")
	timeout := fs.Duration("timeout", 3*time.Second, "how long the dial may take")
	out := fs.String("out", "/dev/termination-log", "where the result goes")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *target == "" {
		fmt.Fprintln(stderr, "cell probe: -dial is required")
		return 2
	}
	res := ProbeResult{Kernel: kernelRelease(), Target: *target, Dial: dialOutcome(*target, *timeout, (&net.Dialer{}).DialContext)}
	b, _ := json.Marshal(res)
	if err := os.WriteFile(*out, b, 0o600); err != nil {
		fmt.Fprintln(stderr, "cell probe:", err)
		return 1
	}
	fmt.Fprintln(stderr, string(b))
	return 0
}

func kernelRelease() string {
	var u unix.Utsname
	if err := unix.Uname(&u); err != nil {
		return "unknown"
	}
	return unix.ByteSliceToString(u.Release[:])
}

type dialFunc func(ctx context.Context, network, address string) (net.Conn, error)

// dialOutcome is connected, refused (the policy rejected it, or nothing
// listens) or timeout (the policy dropped it).
func dialOutcome(target string, timeout time.Duration, dial dialFunc) string {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	c, err := dial(ctx, "tcp", target)
	if err == nil {
		_ = c.Close()
		return "connected"
	}
	if errors.Is(err, syscall.ECONNREFUSED) {
		return "refused"
	}
	return "timeout"
}
