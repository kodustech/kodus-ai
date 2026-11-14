package admincli

import (
	"bytes"
	"context"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"
	"time"
)

const syntheticSecret = "Bearer synthetic-local-cli-secret"

func TestOwnerCLIUsesStdinWithoutEcho(t *testing.T) {
	var output, diagnostic bytes.Buffer
	input := `{"organizationId":"org-a","environmentId":"env-a","id":"payments","version":1,"value":"` + syntheticSecret + `","expiresAt":"2030-01-01T00:00:00Z"}`
	called := false
	code := Run(context.Background(), []string{"-socket", "/private/admin.sock", "-operation", "put"}, testInput(input), &output, &diagnostic,
		func(ctx context.Context, socket, operation string, body []byte) ([]byte, error) {
			called = true
			if socket != "/private/admin.sock" || operation != "put" || string(body) != input || ctx.Err() != nil {
				t.Fatal("request did not preserve explicit owner-local inputs")
			}
			if _, ok := ctx.Deadline(); !ok {
				t.Fatal("missing bounded request deadline")
			}
			return nil, nil
		})
	if code != 0 || !called || output.Len() != 0 || diagnostic.Len() != 0 {
		t.Fatalf("write result: exit=%d called=%v output=%q diagnostic=%q", code, called, output.String(), diagnostic.String())
	}
}

func TestOwnerCLIRefusesUnsafeInvocationBeforeCallingVault(t *testing.T) {
	for name, args := range map[string][]string{
		"no flags":           {},
		"no socket":          {"-operation", "put"},
		"no operation":       {"-socket", "/private/admin.sock"},
		"unknown operation":  {"-socket", "/private/admin.sock", "-operation", "credential"},
		"secret in flag":     {"-socket", "/private/admin.sock", "-operation", "put", "-value", syntheticSecret},
		"secret in argument": {"-socket", "/private/admin.sock", "-operation", "put", syntheticSecret},
		"repeated operation": {"-socket", "/private/admin.sock", "-operation", "put", "-operation", "list"},
	} {
		t.Run(name, func(t *testing.T) {
			var output, diagnostic bytes.Buffer
			called := false
			code := Run(context.Background(), args, testInput(`{}`), &output, &diagnostic,
				func(context.Context, string, string, []byte) ([]byte, error) { called = true; return nil, nil })
			if code == 0 || called || output.Len() != 0 || strings.Contains(diagnostic.String(), syntheticSecret) {
				t.Fatalf("unsafe invocation accepted or leaked: exit=%d called=%v", code, called)
			}
		})
	}
}

func TestOwnerCLIRefusesEmptyOversizeAndReadFailure(t *testing.T) {
	for name, input := range map[string]io.ReadCloser{
		"empty":        testInput(" \n"),
		"oversize":     testInput(strings.Repeat("x", (16<<10)+1)),
		"read failure": failingReader{},
	} {
		t.Run(name, func(t *testing.T) {
			var output, diagnostic bytes.Buffer
			called := false
			code := Run(context.Background(), []string{"-socket", "/private/admin.sock", "-operation", "put"}, input, &output, &diagnostic,
				func(context.Context, string, string, []byte) ([]byte, error) { called = true; return nil, nil })
			if code == 0 || called || strings.Contains(diagnostic.String(), syntheticSecret) {
				t.Fatalf("bad stdin accepted or leaked: exit=%d called=%v", code, called)
			}
		})
	}
}

type failingReader struct{}

func (failingReader) Read([]byte) (int, error) { return 0, errors.New(syntheticSecret) }

func TestOwnerCLIDoesNotPrintTransportErrorOrResponseBody(t *testing.T) {
	var output, diagnostic bytes.Buffer
	code := Run(context.Background(), []string{"-socket", "/private/admin.sock", "-operation", "put"}, testInput(`{}`), &output, &diagnostic,
		func(context.Context, string, string, []byte) ([]byte, error) {
			return []byte(syntheticSecret), errors.New(syntheticSecret)
		})
	if code == 0 || output.Len() != 0 || diagnostic.Len() == 0 || strings.Contains(diagnostic.String(), syntheticSecret) {
		t.Fatal("failed request leaked private transport information")
	}
}

func TestOwnerCLIOutputsOnlyListMetadata(t *testing.T) {
	var output, diagnostic bytes.Buffer
	code := Run(context.Background(), []string{"-socket", "/private/admin.sock", "-operation", "list"}, testInput(`{}`), &output, &diagnostic,
		func(context.Context, string, string, []byte) ([]byte, error) { return []byte(`{"versions":[]}`), nil })
	if code != 0 || output.String() != "{\"versions\":[]}\n" || diagnostic.Len() != 0 {
		t.Fatal("metadata not returned to local owner")
	}
	output.Reset()
	code = Run(context.Background(), []string{"-socket", "/private/admin.sock", "-operation", "put"}, testInput(`{}`), &output, &diagnostic,
		func(context.Context, string, string, []byte) ([]byte, error) { return []byte(syntheticSecret), nil })
	if code == 0 || output.Len() != 0 {
		t.Fatal("unexpected write response was printed")
	}
}

func TestOwnerCLIRefusesCancelledContextAndMissingTransport(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	for _, call := range []Call{nil, func(context.Context, string, string, []byte) ([]byte, error) {
		t.Fatal("cancelled request sent")
		return nil, nil
	}} {
		var output, diagnostic bytes.Buffer
		if code := Run(ctx, []string{"-socket", "/private/admin.sock", "-operation", "list"}, testInput(`{}`), &output, &diagnostic, call); code == 0 {
			t.Fatal("cancelled/unconfigured request accepted")
		}
	}
}

type observedInput struct {
	io.ReadCloser
	started chan struct{}
	once    sync.Once
}

func (r *observedInput) Read(p []byte) (int, error) {
	r.once.Do(func() { close(r.started) })
	return r.ReadCloser.Read(p)
}

// Signal cancellation used to leave the command blocked on stdin forever.
func TestOwnerCLICancellationInterruptsStalledStdin(t *testing.T) {
	reader, writer := io.Pipe()
	defer reader.Close()
	defer writer.Close()
	input := &observedInput{ReadCloser: reader, started: make(chan struct{})}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var output, diagnostic bytes.Buffer
	done := make(chan int, 1)
	go func() {
		done <- Run(ctx, []string{"-socket", "/private/admin.sock", "-operation", "put"}, input, &output, &diagnostic, func(context.Context, string, string, []byte) ([]byte, error) {
			t.Error("stalled cancelled request sent")
			return nil, nil
		})
	}()
	select {
	case <-input.started:
	case <-time.After(time.Second):
		t.Fatal("stdin read did not start")
	}
	cancel()
	select {
	case code := <-done:
		if code == 0 || output.Len() != 0 {
			t.Fatal("cancelled input succeeded")
		}
	case <-time.After(time.Second):
		_ = reader.Close()
		<-done
		t.Fatal("cancelled command remained blocked on stdin")
	}
}

func testInput(s string) io.ReadCloser { return io.NopCloser(strings.NewReader(s)) }
func (failingReader) Close() error     { return nil }

type blockingInheritedInput struct{ started, release, finished chan struct{} }

func (r *blockingInheritedInput) Read([]byte) (int, error) {
	close(r.started)
	<-r.release
	close(r.finished)
	return 0, io.EOF
}
func (*blockingInheritedInput) Close() error { return nil }

// Closing inherited blocking os.Stdin did not interrupt its syscall.Read.
// A command must return on cancellation independently of the reader's Close.
func TestOwnerCLIStopsWhenCloseCannotInterruptStdin(t *testing.T) {
	input := &blockingInheritedInput{make(chan struct{}), make(chan struct{}), make(chan struct{})}
	defer func() { close(input.release); <-input.finished }()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var output, diagnostic bytes.Buffer
	done := make(chan int, 1)
	go func() {
		done <- Run(ctx, []string{"-socket", "/private/admin.sock", "-operation", "put"}, input, &output, &diagnostic, func(context.Context, string, string, []byte) ([]byte, error) {
			t.Error("cancelled request sent")
			return nil, nil
		})
	}()
	select {
	case <-input.started:
	case <-time.After(time.Second):
		t.Fatal("input read did not start")
	}
	cancel()
	select {
	case code := <-done:
		if code == 0 || output.Len() != 0 {
			t.Fatal("cancelled command succeeded")
		}
	case <-time.After(time.Second):
		t.Fatal("command awaited an uninterruptible read")
	}
}
