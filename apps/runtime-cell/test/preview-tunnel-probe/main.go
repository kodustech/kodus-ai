// Command preview-tunnel-probe is a dev-only stand-in for a cell holding one
// preview claim, for the edge's cross-language tests (Node edge <-> the real
// Go tunnel): it starts an app on the loopback, routes one preview id to it
// through the observer's preview proxy exactly as a cell does, dials the
// edge's tunnel URL with a client certificate and a ticket, and serves until
// the tunnel closes or it is signalled. Never built into the cell image (the
// Dockerfile builds ./cmd only).
//
// The app answers:
//
//	/small            "hello"
//	/large?mb=N       N MiB of random bytes, streamed
//	/slow             "slow" after 500 ms
//	/echo-headers     JSON {"path","method","headers","body"} of what it got
//	/set-cookie       a host cookie and a Domain cookie (the edge drops the second)
//
// It prints one JSON line to stdout when the tunnel is up: {"ready":true,"app":"127.0.0.1:port"}.
package main

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/observer"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/preview"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/tlsutil"
)

func main() {
	url := flag.String("url", "", "the edge's tunnel URL (wss://host:port/v1/cells/tunnel)")
	cert := flag.String("cert", "", "the cell's client certificate (PEM)")
	key := flag.String("key", "", "its key (PEM)")
	ca := flag.String("ca", "", "the CA the edge's tunnel certificate chains to (PEM)")
	serverName := flag.String("server-name", "", "the name to verify on the edge's certificate (default: the URL's host)")
	ticket := flag.String("ticket", "", "the one-time tunnel ticket (43 base64url characters)")
	previewID := flag.String("preview-id", "", "the preview id to route (prv_ + 26 base32)")
	flag.Parse()
	log := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	if err := run(log, *url, *cert, *key, *ca, *serverName, *ticket, *previewID); err != nil {
		log.Error("probe.failed", "err", err)
		os.Exit(1)
	}
}

func run(log *slog.Logger, url, cert, key, ca, serverName, ticket, previewID string) error {
	tlsCfg, err := tlsutil.Client(cert, key, ca)
	if err != nil {
		return err
	}
	tlsCfg.ServerName = serverName
	l, err := new(net.ListenConfig).Listen(context.Background(), "tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	appSrv := &http.Server{Handler: appHandler(), ReadHeaderTimeout: 10 * time.Second}
	go func() { _ = appSrv.Serve(l) }()
	defer func() { _ = appSrv.Close() }()
	addr := l.Addr().(*net.TCPAddr)

	svc := preview.New(preview.Config{TLS: func() *tls.Config { return tlsCfg }, Log: log})
	defer svc.Close()
	targets := []observer.Target{{Service: "web", Port: addr.Port, Kind: "http", Address: addr.String()}}
	if err := svc.Route(preview.Route{PreviewID: previewID, ClaimID: "claim-probe", Target: preview.Target{Service: "web", Port: addr.Port}, Until: time.Now().Add(time.Hour), Upstream: observer.PreviewHandler(targets)}); err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if err := svc.Tunnel(ctx, url, ticket); err != nil {
		return err
	}
	_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"ready": true, "app": addr.String()})
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(100 * time.Millisecond):
			if _, up := svc.Connected(); !up {
				return nil
			}
		}
	}
}

func appHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/small", func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "hello") })
	mux.HandleFunc("/large", func(w http.ResponseWriter, r *http.Request) {
		mb, _ := strconv.Atoi(r.URL.Query().Get("mb"))
		buf := make([]byte, 64<<10)
		_, _ = rand.Read(buf)
		w.Header().Set("Content-Length", strconv.Itoa(mb<<20))
		for range mb * 16 {
			if _, err := w.Write(buf); err != nil {
				return
			}
		}
	})
	mux.HandleFunc("/slow", func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-time.After(500 * time.Millisecond):
			_, _ = io.WriteString(w, "slow")
		case <-r.Context().Done():
		}
	})
	mux.HandleFunc("/echo-headers", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"path": r.URL.RequestURI(), "method": r.Method, "host": r.Host, "headers": r.Header, "body": string(body)})
	})
	mux.HandleFunc("/set-cookie", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Add("Set-Cookie", "app_sid=1; Path=/; HttpOnly")
		w.Header().Add("Set-Cookie", "wide=1; Domain=preview.example; Path=/")
		_, _ = fmt.Fprint(w, "cookies")
	})
	return mux
}
