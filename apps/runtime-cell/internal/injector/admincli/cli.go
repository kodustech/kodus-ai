// Package admincli reads owner-local vault requests from stdin. No value is
// accepted in flags, returned in errors, or written to the command's output.
package admincli

import (
	"bytes"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"time"
)

// Call must authenticate the owner-local peer and return only validated
// metadata for list. Other operations return no response body.
type Call func(context.Context, string, string, []byte) ([]byte, error)

// Run owns input for cancellation: a stalled stdin pipe is closed when the
// request deadline or signal context expires, before any transport is called.
func Run(ctx context.Context, args []string, input io.ReadCloser, output, diagnostic io.Writer, call Call) int {
	var socket, operation string
	flags := flag.NewFlagSet("injector-admin", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	setOnce := func(target *string) func(string) error {
		seen := false
		return func(value string) error {
			if seen || value == "" {
				return errors.New("invalid flag")
			}
			seen = true
			*target = value
			return nil
		}
	}
	flags.Func("socket", "existing owner-local management socket", setOnce(&socket))
	flags.Func("operation", "put, register-external, list, bind, revoke-version or revoke-claim", setOnce(&operation))
	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			_, _ = io.WriteString(output, "injector-admin -socket /private/owner/admin.sock -operation put|register-external|list|bind|revoke-version|revoke-claim\nRead one JSON request from stdin. Values never belong in command arguments.\n")
			return 0
		}
		return failed(diagnostic, "Invalid arguments; use -help.", 2)
	}
	if flags.NArg() != 0 || socket == "" || !validOperation(operation) {
		return failed(diagnostic, "Invalid arguments; use -help.", 2)
	}
	if call == nil || ctx.Err() != nil {
		return failed(diagnostic, "Owner-local vault request unavailable.", 1)
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	body, err := readInput(ctx, input)
	defer clear(body)
	if ctx.Err() != nil {
		return failed(diagnostic, "Owner-local vault request cancelled or timed out.", 1)
	}
	if err != nil || len(body) > 16<<10 || len(bytes.TrimSpace(body)) == 0 {
		return failed(diagnostic, "Provide one JSON request of at most 16 KiB on stdin.", 2)
	}
	response, err := call(ctx, socket, operation, body)
	defer clear(response)
	if err != nil {
		return failed(diagnostic, "Owner-local vault request refused or unavailable.", 1)
	}
	if operation != "list" {
		if len(response) != 0 {
			return failed(diagnostic, "Unexpected vault response.", 1)
		}
		return 0
	}
	if len(response) == 0 || len(response) > 256<<10 {
		return failed(diagnostic, "Unexpected vault metadata response.", 1)
	}
	if _, err = fmt.Fprintln(output, string(response)); err != nil {
		return failed(diagnostic, "Could not write vault metadata.", 1)
	}
	return 0
}

func readInput(ctx context.Context, input io.ReadCloser) ([]byte, error) {
	type result struct {
		body []byte
		err  error
	}
	completed := make(chan result, 1)
	go func() {
		body, err := io.ReadAll(io.LimitReader(input, (16<<10)+1))
		if ctx.Err() != nil {
			clear(body)
			return
		}
		select {
		case completed <- result{body, err}:
		case <-ctx.Done():
			clear(body)
		}
	}()
	select {
	case r := <-completed:
		return r.body, r.err
	case <-ctx.Done():
		// An inherited blocking file may not interrupt its read on Close.
		// Return independently; this one-shot command exits after Run, which
		// also ends that bounded reader. No server uses this CLI adapter.
		_ = input.Close()
		return nil, ctx.Err()
	}
}

func validOperation(s string) bool {
	switch s {
	case "put", "register-external", "list", "bind", "revoke-version", "revoke-claim":
		return true
	default:
		return false
	}
}

func failed(diagnostic io.Writer, message string, code int) int {
	_, _ = fmt.Fprintln(diagnostic, message)
	return code
}
