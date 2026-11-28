package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/testpki"
)

func TestNoFakeReaper(t *testing.T) {
	if _, _, err := newDriver(context.Background(), "fake", "cell-1", gvisorFlags{}); !errors.Is(err, errUnsupported) {
		t.Fatalf("fake: %v", err)
	}
}

// Only the drivers the cell ships have a reaper.
func TestNoReaperForADriverTheCellDoesNotShip(t *testing.T) {
	for _, name := range []string{"aws-ec2", "k8s-sandbox"} {
		if _, _, err := newDriver(context.Background(), name, "cell-1", gvisorFlags{}); !errors.Is(err, errUnsupported) {
			t.Fatalf("%s: %v", name, err)
		}
	}
}

// The driver the self-hosted cells run had no reaper (S-08): -driver
// docker-gvisor exited "unsupported driver".
func TestDockerGVisorHasAReaper(t *testing.T) {
	if _, _, err := newDriver(context.Background(), "docker-gvisor", "cell-1", gvisorFlags{workDir: t.TempDir()}); err != nil {
		t.Fatalf("docker-gvisor: %v", err)
	}
}

// A cell's id exists only after it registered: the reaper can read it from
// the identity certificate on the cell's volume.
func TestCellIDFromTheIdentityCertificate(t *testing.T) {
	ca, err := testpki.NewCA("hub")
	if err != nil {
		t.Fatal(err)
	}
	leaf, _ := ca.Issue("cell-42", time.Hour)
	dir := t.TempDir()
	if err := ca.WriteFiles(dir, "", leaf); err != nil {
		t.Fatal(err)
	}
	if id, err := cellIDFromCert(filepath.Join(dir, "cert.pem")); err != nil || id != "cell-42" {
		t.Fatalf("%q %v", id, err)
	}
	if _, err := cellIDFromCert(filepath.Join(dir, "missing.pem")); err == nil {
		t.Fatal("no certificate, no id")
	}
}

// A microVM cell had no reaper outside its own process (S-08 passed on the
// in-process call only): -driver microvm opens the cell's state directory,
// and refuses a directory that is not one.
func TestMicroVMHasAReaper(t *testing.T) {
	state := t.TempDir()
	if err := os.MkdirAll(state+"/vm/machines", 0o700); err != nil {
		t.Fatal(err)
	}
	_, orphans, err := newDriver(context.Background(), "microvm", "cell-1", gvisorFlags{microvmState: state})
	if err != nil {
		t.Fatalf("microvm: %v", err)
	}
	if orphans == nil {
		t.Fatal("the microvm reaper has no orphan pass")
	}
	if _, _, err := newDriver(context.Background(), "microvm", "cell-1", gvisorFlags{microvmState: t.TempDir()}); err == nil || errors.Is(err, errUnsupported) {
		t.Fatalf("a directory that is no cell's state: %v", err)
	}
}
