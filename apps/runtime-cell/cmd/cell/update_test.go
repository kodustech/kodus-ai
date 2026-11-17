package main

import (
	"os"
	"path/filepath"
	"testing"
)

// cell update finds hub-protocol.state where the agent writes it: the
// -state-dir the cell runs with under the same config file.
func TestCellUpdateFindsTheStateDirTheCellRunsWith(t *testing.T) {
	t.Setenv("KODUS_CELL_MAX_CLAIM_STEPS", "")
	_ = os.Unsetenv("KODUS_CELL_MAX_CLAIM_STEPS")
	dir := t.TempDir()
	write := func(name, text string) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte(text), 0o600); err != nil {
			t.Fatal(err)
		}
		return p
	}
	for name, c := range map[string]struct{ config, want string }{
		"no config":           {"", "/var/lib/kodus-cell/state"},
		"state-dir in config": {write("a.yaml", "state-dir: /srv/cell/state\n"), "/srv/cell/state"},
		"workdir in config":   {write("b.json", `{"workdir": "/srv/cell"}`), "/srv/cell/state"},
	} {
		t.Run(name, func(t *testing.T) {
			got, err := cellStateDir(c.config)
			if err != nil || got != c.want {
				t.Fatalf("cellStateDir(%q) = %q %v, want %q", c.config, got, err, c.want)
			}
		})
	}
	if _, err := cellStateDir(write("bad.yaml", "not-a-flag: 1\n")); err == nil {
		t.Fatal("a config the cell refuses gave a state dir")
	}
}
