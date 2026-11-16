// Package observersrv is the observer machine's server (ADR-053) as both its
// programs run it: cmd/observer on TCP in its container, and the guest
// agent's observer mode on vsock in an observer microVM, which the cell
// reaches only through the VM's vsock and nothing on the claim's network
// can reach at all.
package observersrv

import (
	"context"
	"crypto/tls"
	"database/sql"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib" // the legacy SQL probes' driver

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/observer"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/tlsutil"
)

// Options is one observer server.
type Options struct {
	Listener  net.Listener
	CellID    string
	NewID     func() string
	Cert, Key string
	// CA is the CA of the cell agent's client certificate.
	CA string
	// Insecure serves plain HTTP (local development only; the caller checks).
	Insecure bool
	// SQLDSN is the legacy static DSN template ({address}); empty: none.
	SQLDSN string
	Log    *slog.Logger
}

// Run serves until ctx ends.
func Run(ctx context.Context, o Options) error {
	base := observer.Config{OpenSQL: legacySQLClient(o.SQLDSN)}
	srv := &observer.Server{CellID: o.CellID, NewID: o.NewID, Base: base}
	defer func() { _ = srv.Close() }()
	hs := &http.Server{Handler: srv.Handler(), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 2 * time.Minute}
	go func() {
		<-ctx.Done()
		sctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
		defer cancel()
		_ = hs.Shutdown(sctx)
	}()
	l := o.Listener
	if !o.Insecure {
		cfg, err := tlsutil.Server(o.Cert, o.Key, o.CA)
		if err != nil {
			return err
		}
		l = tls.NewListener(l, cfg)
	}
	if err := hs.Serve(l); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
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
