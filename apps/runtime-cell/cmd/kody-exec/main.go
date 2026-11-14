// Command kody-exec runs inside the VM: it reads one JSON request on stdin
// ({"command","cwd","timeoutMs"}) and prints the result as JSON
// ({"exitCode","stdout","stderr","truncated","durationMs"}). Exit 124 on
// timeout, output capped at 16 KiB per stream. It adopts the orphans of the
// command (Linux), so the timeout kills a daemon the command forked too.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/signal"
	"runtime"
	"syscall"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/kodyexec"
)

func main() {
	raw, err := io.ReadAll(io.LimitReader(os.Stdin, 64<<10))
	if err != nil {
		fail(err)
	}
	var req kodyexec.Request
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil || req.Command == "" {
		fail(fmt.Errorf("bad request: %v", err))
	}
	if runtime.GOOS == "linux" {
		if err := kodyexec.BecomeSubreaper(); err != nil {
			fail(fmt.Errorf("subreaper: %w", err))
		}
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
	defer stop()
	res := kodyexec.Run(ctx, req)
	_ = json.NewEncoder(os.Stdout).Encode(res)
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "kody-exec:", err)
	os.Exit(2)
}
