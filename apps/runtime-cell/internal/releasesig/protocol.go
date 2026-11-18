package releasesig

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
)

// ProtocolName is the release file that says which hub protocol versions
// the release's cell speaks: one line, "<lowest> <highest>" (the cell's
// protocol.SupportedVersions). The release workflow writes it before
// SHA256SUMS is made over the directory, so the signature covers it.
const ProtocolName = "PROTOCOL"

// maxProtocolBytes bounds what ReadProtocol reads.
const maxProtocolBytes = 64

// Protocol is the span of protocol versions a release's cell speaks; it
// offers them all at hello and frames in Max, the version the hub's skew
// policy judges.
type Protocol struct{ Min, Max int64 }

var protocolLine = regexp.MustCompile(`^([1-9][0-9]{0,8}) ([1-9][0-9]{0,8})\n?$`)

// FormatProtocol is PROTOCOL's content for p.
func FormatProtocol(p Protocol) string { return fmt.Sprintf("%d %d\n", p.Min, p.Max) }

// ParseProtocol reads PROTOCOL's content.
func ParseProtocol(text []byte) (Protocol, error) {
	m := protocolLine.FindSubmatch(text)
	if m == nil {
		return Protocol{}, errors.New(`not one line "<lowest> <highest>" of protocol versions`)
	}
	lo, _ := strconv.ParseInt(string(m[1]), 10, 64)
	hi, _ := strconv.ParseInt(string(m[2]), 10, 64)
	if hi < lo {
		return Protocol{}, fmt.Errorf("highest v%d is below lowest v%d", hi, lo)
	}
	return Protocol{Min: lo, Max: hi}, nil
}

// ReadProtocol is the protocol a verified release says it speaks. A
// manifest that does not list PROTOCOL (a release from before it) says
// nothing: ok false, no error. A listed one must match its hash and parse,
// or it is refused naming the file.
func ReadProtocol(dir string, manifest map[string]string) (p Protocol, ok bool, err error) {
	want, listed := manifest[ProtocolName]
	if !listed {
		return Protocol{}, false, nil
	}
	path := filepath.Join(dir, ProtocolName)
	f, err := os.Open(path) //nolint:gosec // G304: a file of the release directory the operator named
	if errors.Is(err, os.ErrNotExist) {
		return Protocol{}, false, refuse(path, "missing, though %s lists it", ManifestName)
	}
	if err != nil {
		return Protocol{}, false, refuse(path, "%v", err)
	}
	defer func() { _ = f.Close() }()
	b, err := io.ReadAll(io.LimitReader(f, maxProtocolBytes+1))
	if err != nil {
		return Protocol{}, false, refuse(path, "%v", err)
	}
	sum := sha256.Sum256(b)
	if len(b) > maxProtocolBytes || hex.EncodeToString(sum[:]) != want {
		return Protocol{}, false, refuse(path, "does not match %s", ManifestName)
	}
	if p, err = ParseProtocol(b); err != nil {
		return Protocol{}, false, refuse(path, "%v", err)
	}
	return p, true, nil
}

// writeProtocol writes dir's PROTOCOL; one already there is never replaced.
func writeProtocol(dir string, p Protocol) error {
	if p.Min < 1 || p.Max < p.Min {
		return fmt.Errorf("this build speaks no protocol (v%d to v%d)", p.Min, p.Max)
	}
	f, err := os.OpenFile(filepath.Join(dir, ProtocolName), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644) //nolint:gosec // G302,G304: release metadata, published with the release
	if err != nil {
		return err
	}
	_, err = f.WriteString(FormatProtocol(p))
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	return err
}
