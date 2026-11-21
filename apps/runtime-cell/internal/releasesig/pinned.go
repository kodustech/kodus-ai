package releasesig

import _ "embed"

//go:embed keys/cell-release.pub
var pinned []byte

// Pinned are the release keys compiled into this binary: what an installed
// cell verifies the next release with when the installer names no key file.
func Pinned() ([]PublicKey, error) { return ParsePublicKeys(pinned) }
