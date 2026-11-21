package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/lifecycle"
)

func startMirrorServer(t *testing.T, idle time.Duration, perSource int) string {
	t.Helper()
	l, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ms, ml := newMirrorServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("ok")) }), l, idle, perSource)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); _ = lifecycle.ServeHTTP(ms, ml, time.Second)(ctx) }()
	t.Cleanup(func() { cancel(); <-done })
	return l.Addr().String()
}

// get sends one keep-alive request and leaves the connection open.
func get(t *testing.T, addr string) (net.Conn, error) {
	t.Helper()
	c, err := net.DialTimeout("tcp4", addr, time.Second)
	if err != nil {
		return nil, err
	}
	t.Cleanup(func() { c.Close() })
	_ = c.SetDeadline(time.Now().Add(2 * time.Second))
	fmt.Fprintf(c, "GET /v2/ HTTP/1.1\r\nHost: mirror.cell.internal\r\n\r\n")
	resp, err := http.ReadResponse(bufio.NewReader(c), nil)
	if err != nil {
		return c, err
	}
	_ = resp.Body.Close()
	return c, nil
}

// One machine holds at most perSource connections to the mirror, which
// serves every claim network from the process every claim depends on; a
// closed one frees its slot.
func TestTheMirrorBoundsTheConnectionsOfOneSource(t *testing.T) {
	addr := startMirrorServer(t, time.Minute, 2)
	first, err := get(t, addr)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := get(t, addr); err != nil {
		t.Fatal(err)
	}
	if _, err := get(t, addr); err == nil {
		t.Fatal("a third connection from one source was served")
	}
	first.Close()
	deadline := time.Now().Add(2 * time.Second)
	for {
		if _, err := get(t, addr); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("a closed connection never freed its slot")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// A keep-alive connection with no request is closed after idle.
func TestTheMirrorClosesAnIdleConnection(t *testing.T) {
	addr := startMirrorServer(t, 100*time.Millisecond, 8)
	c, err := get(t, addr)
	if err != nil {
		t.Fatal(err)
	}
	_ = c.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, err = c.Read(make([]byte, 1))
	if ne := net.Error(nil); errors.As(err, &ne) && ne.Timeout() {
		t.Fatal("the idle connection is still open")
	}
}
