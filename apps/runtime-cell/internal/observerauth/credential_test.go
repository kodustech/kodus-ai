package observerauth

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestNewCredentialAndSCRAMNeverDisclosePasswordInScriptOrFormatting(t *testing.T) {
	c, err := NewCredential("db", 5432, "shop")
	if err != nil {
		t.Fatal(err)
	}
	if err := c.Validate(); err != nil {
		t.Fatal(err)
	}
	verifier, err := SCRAMVerifier(c)
	if err != nil {
		t.Fatal(err)
	}
	sql, err := ProvisionSQL(c, verifier, time.Now().Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	for _, got := range []string{fmt.Sprint(c), fmt.Sprintf("%+v", c), fmt.Sprintf("%#v", c), string(sql)} {
		if strings.Contains(got, c.Password) {
			t.Fatal("credential leaked its plaintext password")
		}
	}
	if !bytes.Contains(sql, []byte("SCRAM-SHA-256$4096:")) {
		t.Fatal("script lacks SCRAM verifier")
	}
	if !bytes.Contains(sql, []byte("NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS")) {
		t.Fatal("role lacks restricted attributes")
	}
	second, err := NewCredential("db", 5432, "shop")
	if err != nil || c.Username == second.Username || c.Password == second.Password {
		t.Fatal("claim credentials are not independent")
	}
}

func TestCredentialValidationRefusesControlAndUnboundedInputs(t *testing.T) {
	good := Credential{Service: "db", Port: 5432, Database: "shop", Username: "kody_observer_" + strings.Repeat("a", 32), Password: base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{1}, 32))}
	if err := good.Validate(); err != nil {
		t.Fatal(err)
	}
	for _, edit := range []func(*Credential){
		func(c *Credential) { c.Database = "shop';CREATE ROLE bad SUPERUSER;--" },
		func(c *Credential) { c.Database = "-o" },
		func(c *Credential) { c.Username = "postgres" },
		func(c *Credential) { c.Password = "" },
		func(c *Credential) { c.Service = "db\nOTHER=x" },
		func(c *Credential) { c.Port = 0 },
	} {
		c := good
		edit(&c)
		if c.Validate() == nil {
			t.Fatal("unsafe credential accepted")
		}
	}
}

func TestProvisionSQLRejectsVerifierInjection(t *testing.T) {
	c, err := NewCredential("db", 5432, "shop")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ProvisionSQL(c, "SCRAM-SHA-256$4096:abc$bad:';DROP DATABASE shop;--", time.Now().Add(time.Hour)); err == nil {
		t.Fatal("invalid verifier accepted")
	}
}
