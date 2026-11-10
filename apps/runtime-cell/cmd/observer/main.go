// Command observer is the claim's observer machine (ADR-053): it serves the
// cell agent over mTLS, runs typed HTTP and read-only SQL probes against
// the claim's VM and keeps the request log by method and route.
package main

import (
	"context"
	"database/sql"
	"errors"
	"flag"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/hubclient"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/observer"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/tlsutil"
)

var version = "dev"

// devEnv must be 1 for -insecure-dev, as for the local-docker driver.
const devEnv = "KODY_RUNTIME_DEV"

func main() {
	listen := flag.String("listen", ":7443", "address for the cell agent")
	cellID := flag.String("cell-id", os.Getenv("KODUS_CELL_ID"), "cell id")
	cert := flag.String("cert", "/etc/kodus/observer/cert.pem", "server certificate")
	key := flag.String("key", "/etc/kodus/observer/key.pem", "server key")
	ca := flag.String("ca", "/etc/kodus/observer/ca.pem", "CA of the cell agent's certificate")
	insecure := flag.Bool("insecure-dev", false, "plain HTTP, local development only (needs "+devEnv+"=1)")
	// The read-only user is created at bake from the seed; {address} is the
	// claim VM's host:port.
	dsn := flag.String("sql-dsn", os.Getenv("KODUS_OBSERVER_SQL_DSN"), "DSN template, e.g. postgres://kody_observer@{address}/app?sslmode=disable")
	flag.Parse()
	log := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	log.Info("observer.start", "version", version)
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
	defer stop()

	base := observer.Config{
		// HTTP stays nil: each claim's prober dials only its targets.
		OpenSQL: legacySQLClient(*dsn),
	}
	srv := &observer.Server{CellID: *cellID, NewID: hubclient.NewID, Base: base}
	defer srv.Close()
	hs := &http.Server{Addr: *listen, Handler: srv.Handler(), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 2 * time.Minute}
	go func() {
		<-ctx.Done()
		sctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = hs.Shutdown(sctx)
	}()
	var err error
	if *insecure {
		if os.Getenv(devEnv) != "1" {
			log.Error("observer.insecure_dev refused", "need", devEnv+"=1")
			os.Exit(2)
		}
		log.Warn("observer.insecure_dev")
		err = hs.ListenAndServe()
	} else {
		if hs.TLSConfig, err = tlsutil.Server(*cert, *key, *ca); err == nil {
			err = hs.ListenAndServeTLS("", "")
		}
	}
	if err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Error("observer", "err", err)
		os.Exit(1)
	}
}

type errUnsupported string

func (e errUnsupported) Error() string { return "sql kind not supported yet: " + string(e) }

// legacySQLClient retains explicitly configured static DSNs for older cells.
func legacySQLClient(template string) func(observer.Target) (*sql.DB, error) {
	return func(t observer.Target) (*sql.DB, error) {
		if strings.TrimSpace(template) == "" {
			return nil, errors.New("observer SQL is not configured")
		}
		if t.Kind != "postgres" {
			return nil, errUnsupported(t.Kind)
		}
		return sql.Open("pgx", strings.ReplaceAll(template, "{address}", t.Address))
	}
}
