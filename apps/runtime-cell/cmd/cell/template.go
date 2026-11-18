package main

import (
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation/vmsnap"
)

// runTemplate moves a microVM environment template between hosts' stores
// (vmsnap.Export, vmsnap.Import): "cell template export" writes one to
// stdout, "cell template import" reads one from stdin into the store, as
// root, with every file checked against its manifest's digest and stamped
// with its published time. A copy made by hand (plain tar keeps whole
// seconds) is refused at restore. The other host still restores it only
// with the same kit and host fingerprint (vmsnap.Manifest.Restorable).
func runTemplate(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	if len(args) == 0 || (args[0] != "export" && args[0] != "import") {
		fmt.Fprintln(stderr, "usage: cell template export -org <org> -id <ksn-...> > archive | cell template import -org <org> < archive")
		return 2
	}
	verb := args[0]
	fs := flag.NewFlagSet("cell template "+verb, flag.ContinueOnError)
	fs.SetOutput(stderr)
	state := fs.String("firecracker-state-dir", "/var/lib/kodus-cell/state/microvm", "the cell's -firecracker-state-dir; the store is its vm/snapshots")
	org := fs.String("org", "", "the template's org")
	id := fs.String("id", "", "export: the template's id (ksn-...)")
	if err := fs.Parse(args[1:]); err != nil {
		return 2
	}
	if *org == "" || (verb == "export" && *id == "") {
		fmt.Fprintln(stderr, "cell template: -org is required, and -id to export")
		return 2
	}
	dir := filepath.Join(*state, "vm", "snapshots")
	if _, err := os.Stat(dir); err != nil { //nolint:gosec // G703: the operator's own state directory flag
		fmt.Fprintf(stderr, "cell template: the store: %v\n", err)
		return 1
	}
	s, err := vmsnap.NewStore(dir)
	if err != nil {
		fmt.Fprintf(stderr, "cell template: %v\n", err)
		return 1
	}
	if verb == "export" {
		if err := s.Export(*org, *id, stdout); err != nil {
			fmt.Fprintf(stderr, "cell template export: %v\n", err)
			return 1
		}
		return 0
	}
	m, err := s.Import(*org, stdin)
	if err != nil {
		fmt.Fprintf(stderr, "cell template import: %v\n", err)
		return 1
	}
	fmt.Fprintf(stderr, "cell template import: %s (key %s, kit %s) is in the store\n", m.ID, m.Key, m.Kit)
	return 0
}
