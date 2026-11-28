package observer

import (
	"testing"
)

func TestManagedPostgresPinsEveryConnectionIdentityAndAuthentication(t *testing.T) {
	c := fixtureCredential(t)
	target := Target{Service: "db", Port: 5432, Kind: "postgres", Address: "127.0.0.1:15432"}
	cfg, err := ManagedPostgresConfig(target, c)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Host != "127.0.0.1" || cfg.Port != 15432 || cfg.Database != c.Database || cfg.User != c.Username || cfg.Password != c.Password {
		t.Fatal("connection identity was not fully explicit")
	}
	if cfg.TLSConfig != nil || len(cfg.Fallbacks) != 0 || cfg.RequireAuth != "scram-sha-256" {
		t.Fatal("connection may redirect or request plaintext authentication")
	}
	if cfg.RuntimeParams["default_transaction_read_only"] != "on" || cfg.RuntimeParams["search_path"] != "pg_catalog,public" {
		t.Fatal("managed session defaults missing")
	}
}

func TestManagedPostgresRefusesInheritedPGEnvironment(t *testing.T) {
	c := fixtureCredential(t)
	target := Target{Service: "db", Port: 5432, Kind: "postgres", Address: "127.0.0.1:15432"}
	for _, name := range []string{"PGHOST", "PGSERVICE", "PGOPTIONS", "PGPASSWORD", "PGSSLKEY", "PGAPPNAME"} {
		t.Run(name, func(t *testing.T) {
			t.Setenv(name, "not-a-connection-source")
			if _, err := ManagedPostgresConfig(target, c); err == nil {
				t.Fatal("managed connection inherited process PG configuration")
			}
		})
	}
}

func TestManagedPostgresRefusesWrongTargetAndNonIPRedirects(t *testing.T) {
	c := fixtureCredential(t)
	for _, target := range []Target{
		{Service: "other", Port: 5432, Kind: "postgres", Address: "127.0.0.1:5432"},
		{Service: "db", Port: 5433, Kind: "postgres", Address: "127.0.0.1:5432"},
		{Service: "db", Port: 5432, Kind: "mysql", Address: "127.0.0.1:5432"},
		{Service: "db", Port: 5432, Kind: "postgres", Address: "host.example:5432"},
		{Service: "db", Port: 5432, Kind: "postgres", Address: "/tmp/socket"},
	} {
		if _, err := ManagedPostgresConfig(target, c); err == nil {
			t.Fatal("connection accepted an unbound target")
		}
	}
}
