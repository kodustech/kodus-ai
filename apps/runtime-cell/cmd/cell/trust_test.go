package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/testpki"
)

func TestTheCellBuildsTheTrustFilesFromTheInjectorsCAAndItsOwnRoots(t *testing.T) {
	dir := t.TempDir()
	cell, err := testpki.NewCA("cell-ca")
	if err != nil {
		t.Fatal(err)
	}
	public, err := testpki.NewCA("public-root")
	if err != nil {
		t.Fatal(err)
	}
	caFile, rootsFile := filepath.Join(dir, "cell-ca.pem"), filepath.Join(dir, "roots.pem")
	if err := os.WriteFile(caFile, cell.PEM, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(rootsFile, public.PEM, 0o600); err != nil {
		t.Fatal(err)
	}
	work := filepath.Join(dir, "work")
	files, from, err := trustSettings{CellCA: caFile, Roots: rootsFile}.write(work)
	if err != nil || from != rootsFile || files.Bundle != filepath.Join(work, "trust", "ca-bundle.pem") {
		t.Fatalf("files %+v from %q: %v", files, from, err)
	}
	b, err := os.ReadFile(files.Bundle)
	if err != nil || strings.Count(string(b), "BEGIN CERTIFICATE") != 2 {
		t.Fatalf("bundle %q: %v", b, err)
	}
	// Without -cell-ca-cert nothing is written and no machine gets the CA.
	if files, _, err := (trustSettings{}).write(filepath.Join(dir, "none")); err != nil || files.Set() {
		t.Fatalf("files %+v: %v", files, err)
	}
	if _, err := os.Stat(filepath.Join(dir, "none")); !os.IsNotExist(err) {
		t.Fatalf("wrote without -cell-ca-cert: %v", err)
	}
	// The injector's key given by mistake stops the cell at start.
	key := filepath.Join(dir, "with-key.pem")
	if err := os.WriteFile(key, append(append([]byte{}, cell.PEM...), "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n"...), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := (trustSettings{CellCA: key, Roots: rootsFile}).write(work); err == nil {
		t.Fatal("took a cell CA file with its key")
	}
}
