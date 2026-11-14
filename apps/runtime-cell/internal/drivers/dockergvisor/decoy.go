package dockergvisor

import (
	"errors"
	"os"
	"path/filepath"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
)

// A Run's decoy credentials file (ADR-043): the npmrc canary the agent
// hands Up (driver.WithCanaries), written where the cell owns it and bound
// read-only into every service at sandbox.DecoyTarget. One per machine,
// rewritten at each Up and removed with the machine; never a label, never
// logged.

func decoyPath(workDir, machine string) string {
	return filepath.Join(workDir, "decoy", machine+".npmrc")
}

// writeDecoy writes the machine's decoy file for canaries and returns its
// path; "" (and no file) when they plant none.
func (d *Driver) writeDecoy(machine string, canaries []driver.Canary) (string, error) {
	p := decoyPath(d.workDir(), machine)
	content := driver.CanaryFileOf(canaries)
	if content == "" {
		return "", removeDecoyFile(p)
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return "", err
	}
	// Read by the services' users, as the claim's resolv.conf: a decoy is
	// nothing to hide. Renamed in, so a reset's Up never binds half a file.
	tmp, err := os.CreateTemp(filepath.Dir(p), ".decoy-*")
	if err != nil {
		return "", err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.WriteString(content); err != nil {
		tmp.Close()
		return "", err
	}
	if err := tmp.Chmod(0o644); err != nil {
		tmp.Close()
		return "", err
	}
	if err := tmp.Close(); err != nil {
		return "", err
	}
	return p, os.Rename(tmp.Name(), p)
}

func removeDecoyFile(p string) error {
	if err := os.Remove(p); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}
