// Command release-sign is the release tooling's half of S-17 (a): it makes
// the release key pair and signs a release's SHA256SUMS
// (internal/releasesig). It is not one of the cell's commands and never
// ships on a cell host.
//
//	release-sign generate -private FILE -public FILE
//	release-sign sign -key FILE -release vX.Y.Z -dir DIR
package main

import (
	"os"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/releasesig"
)

func main() {
	os.Exit(releasesig.RunTool(os.Args[1:], os.Stdout, os.Stderr))
}
