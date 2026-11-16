package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/machinetrust"
)

// What a claim with org secrets trusts (internal/machinetrust): the
// injector's cell CA, which terminates its requests to a secret's host, and
// the public roots the cell itself trusts.
type trustSettings struct {
	// CellCA is the injector's -cell-ca-cert, its certificate only.
	CellCA string
	// Roots is the public roots' file; empty: the cell's own trust store
	// (machinetrust.SystemRootFiles).
	Roots string
}

func (s *trustSettings) register(fs *flag.FlagSet) {
	fs.StringVar(&s.CellCA, "cell-ca-cert", "", "the injector's cell CA certificate (its -cell-ca-cert, never the key): mounted, with the public roots, into every machine of a claim with org secrets, so they trust the injector; empty: those machines do not trust it and a secret's HTTPS fails verification")
	fs.StringVar(&s.Roots, "machine-roots", "", "the public roots (PEM) bundled with -cell-ca-cert; empty: the cell's own trust store, read at start")
}

// write builds the trust files once, at start, under workDir/trust. Zero
// Files without -cell-ca-cert.
func (s trustSettings) write(workDir string) (machinetrust.Files, string, error) {
	if s.CellCA == "" {
		return machinetrust.Files{}, "", nil
	}
	ca, err := os.ReadFile(s.CellCA)
	if err != nil {
		return machinetrust.Files{}, "", fmt.Errorf("-cell-ca-cert: %w", err)
	}
	files := machinetrust.SystemRootFiles
	if s.Roots != "" {
		files = []string{s.Roots}
	}
	roots, from, err := machinetrust.ReadRoots(files)
	if err != nil {
		return machinetrust.Files{}, "", err
	}
	out, err := machinetrust.Write(filepath.Join(workDir, "trust"), roots, ca)
	return out, from, err
}
