package observer

import (
	"database/sql"
	"errors"
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/observerauth"
)

var errManagedPostgresConfig = errors.New("observer: managed SQL connection configuration refused")

// ManagedPostgresConfig builds an explicit single-target connection. pgx's
// parser reads PG* service/pass/TLS settings, so that environment is refused
// rather than inherited or temporarily changed for other goroutines.
func ManagedPostgresConfig(t Target, c observerauth.Credential) (*pgx.ConnConfig, error) {
	if c.Validate() != nil || t.Kind != "postgres" || t.Service != c.Service || t.Port != c.Port {
		return nil, errManagedPostgresConfig
	}
	host, port, err := net.SplitHostPort(t.Address)
	n, portErr := strconv.Atoi(port)
	if err != nil || portErr != nil || n < 1 || n > 65535 || net.ParseIP(host) == nil {
		return nil, errManagedPostgresConfig
	}
	for _, entry := range os.Environ() {
		name, _, _ := strings.Cut(entry, "=")
		if strings.HasPrefix(name, "PG") {
			return nil, errManagedPostgresConfig
		}
	}
	u := url.URL{Scheme: "postgres", Host: t.Address, User: url.UserPassword(c.Username, c.Password), Path: "/" + c.Database}
	q := url.Values{"sslmode": {"disable"}, "connect_timeout": {"5"}, "target_session_attrs": {"any"}}
	u.RawQuery = q.Encode()
	cfg, err := pgx.ParseConfig(u.String())
	if err != nil {
		return nil, errManagedPostgresConfig
	}
	cfg.Host, cfg.Port, cfg.Database, cfg.User, cfg.Password = host, uint16(n), c.Database, c.Username, c.Password
	cfg.TLSConfig, cfg.Fallbacks = nil, nil
	cfg.ConnectTimeout = 5 * time.Second
	cfg.RequireAuth = "scram-sha-256"
	cfg.RuntimeParams = map[string]string{"application_name": "kody-observer", "default_transaction_read_only": "on", "search_path": "pg_catalog,public", "standard_conforming_strings": "on"}
	cfg.StatementCacheCapacity = 16
	cfg.DescriptionCacheCapacity = 16
	return cfg, nil
}

func OpenManagedPostgres(t Target, c observerauth.Credential) (*sql.DB, error) {
	cfg, err := ManagedPostgresConfig(t, c)
	if err != nil {
		return nil, err
	}
	return stdlib.OpenDB(*cfg), nil
}
