package main

import (
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/observer"
	"testing"
)

func TestEmptyLegacyDSNCannotInheritObserverProcessPGEnvironment(t *testing.T) {
	t.Setenv("PGHOST", "unrelated-target.example")
	target := observer.Target{Service: "db", Port: 5432, Kind: "postgres", Address: "127.0.0.1:5432"}
	for _, template := range []string{"", " \t\n"} {
		db, err := legacySQLClient(template)(target)
		if db != nil {
			db.Close()
		}
		if err == nil {
			t.Fatal("empty static DSN opened an implicit environment-backed SQL pool")
		}
	}
}

func TestLegacySQLClientKeepsExplicitTargetTemplateAndRefusesOtherKinds(t *testing.T) {
	target := observer.Target{Service: "db", Port: 5432, Kind: "postgres", Address: "127.0.0.1:5432"}
	db, err := legacySQLClient("postgres://user@{address}/app?sslmode=disable")(target)
	if err != nil || db == nil {
		t.Fatal("explicit legacy DSN refused")
	}
	db.Close()
	target.Kind = "mysql"
	if _, err := legacySQLClient("postgres://user@{address}/app?sslmode=disable")(target); err == nil {
		t.Fatal("unsupported SQL kind accepted")
	}
}
