// Command injector-admin provisions the running injector over its optional
// owner-local socket. Requests arrive on stdin; no secret is a flag or output.
package main

import (
	"context"
	"os"
	"os/signal"
	"syscall"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/injector/admincli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/injector/management"
)

func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	code := admincli.Run(ctx, os.Args[1:], os.Stdin, os.Stdout, os.Stderr, management.Call)
	cancel()
	os.Exit(code)
}
