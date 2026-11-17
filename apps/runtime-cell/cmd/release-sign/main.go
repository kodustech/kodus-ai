// Command release-sign is the release tooling's half of S-17 (a): it makes
// the release key pair, writes the release's PROTOCOL (the hub protocol
// versions this build's cell speaks) and signs a release's SHA256SUMS
// (internal/releasesig). It is not one of the cell's commands and never
// ships on a cell host. It is built from the release's own commit, so
// PROTOCOL is what that release's cell speaks.
//
//	release-sign generate -private FILE -public FILE
//	release-sign protocol -dir DIR
//	release-sign sign -key FILE -release vX.Y.Z -dir DIR
//	release-sign index -key FILE -latest vX.Y.Z -minimum vX.Y.Z -dir DIR
//	release-sign bundle -key FILE -release vX.Y.Z -release-dir DIR -images FILE -runsc ARCH=FILE -out DIR
package main

import (
	"os"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/releasesig"
)

// speaks is what this build's cell offers at hello.
func speaks() releasesig.Protocol {
	v := protocol.SupportedVersions()
	return releasesig.Protocol{Min: v[0], Max: v[len(v)-1]}
}

func main() {
	os.Exit(releasesig.RunTool(os.Args[1:], speaks(), os.Stdout, os.Stderr))
}
