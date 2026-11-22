// Package toollayer is the cell's store of tool layers: the tree an install
// leaves, built once per (org, key) in a clean builder, copied out through
// this package's own extractor and mounted read-only into reviews of that org
// (docs/runtime/persistent-state.md, section 4).
//
// The extractor is the only door into the store, so everything the builder
// emits is treated as hostile bytes until it has been refused or normalized.
package toollayer

import (
	"errors"
	"io/fs"
	"regexp"
	"time"
)

// LayerFormat is part of every key: a change in how layers are made starts new keys.
const LayerFormat = 1

// Defaults of the limits in section 4.5 of the design.
const (
	DefaultMaxLayerBytes int64 = 256 << 20
	DefaultMaxOrgBytes   int64 = 2 << 30
	DefaultMaxCellBytes  int64 = 20 << 30
	DefaultMaxOrgLayers        = 32
	DefaultMaxEntries          = 100_000
)

var (
	// ErrMiss is every answer "nothing usable": the caller installs as today.
	ErrMiss = errors.New("toollayer: miss")
	// ErrRefused wraps a refusal of an archive or a layer; RefusalReason says why.
	ErrRefused = errors.New("toollayer: layer refused")
	// ErrTooLarge is a refusal about size or budget (a subset of ErrRefused).
	ErrTooLarge = errors.New("toollayer: layer too large for its budget")
	// ErrNoImageDigest: a layer must never meet an image it was not built for.
	ErrNoImageDigest = errors.New("toollayer: no sandbox image digest (sha256:<64 hex>)")
)

var (
	hexRe         = regexp.MustCompile(`^[a-f0-9]{64}$`)
	imageDigestRe = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)
)

// RefusalError is a layer the store refused to keep.
type RefusalError struct {
	Reason string
	Detail string
}

func (e *RefusalError) Error() string {
	if e.Detail == "" {
		return "toollayer: layer refused: " + e.Reason
	}
	return "toollayer: layer refused: " + e.Reason + ": " + e.Detail
}

func (e *RefusalError) Is(target error) bool {
	switch target {
	case ErrRefused:
		return true
	case ErrTooLarge:
		return e.Reason == "too_large" || e.Reason == "org_full" || e.Reason == "cell_full"
	}
	return false
}

// RefusalReason is the short code of a refusal, or "" for any other error.
func RefusalReason(err error) string {
	var r *RefusalError
	if errors.As(err, &r) {
		return r.Reason
	}
	return ""
}

func refused(reason, detail string) error { return &RefusalError{Reason: reason, Detail: detail} }

// MissError says why a lookup found nothing: no_key, evicted or corrupt.
type MissError struct{ Reason string }

func (e *MissError) Error() string        { return "toollayer: miss: " + e.Reason }
func (e *MissError) Is(target error) bool { return target == ErrMiss }

// MissReason is the code of a miss, or "" for any other error.
func MissReason(err error) string {
	var m *MissError
	if errors.As(err, &m) {
		return m.Reason
	}
	return ""
}

// Entry is one path of a layer, as recorded in layer.json and hashed into the digest.
type Entry struct {
	Path   string       `json:"path"`
	Type   string       `json:"type"` // file, dir, symlink
	Mode   uint32       `json:"mode"`
	Size   int64        `json:"size"`
	SHA256 string       `json:"sha256,omitempty"`
	Target string       `json:"target,omitempty"`
	FP     *Fingerprint `json:"fp,omitempty"`
}

// Fingerprint is what a stat tells about a file (U8): cheap to compare on
// every mount, backed by the periodic full hash.
type Fingerprint struct {
	Ino     uint64 `json:"ino"`
	Size    int64  `json:"size"`
	MtimeNs int64  `json:"mtimeNs"`
	CtimeNs int64  `json:"ctimeNs"`
}

// Integrity is what the builder found out about the installed packages (U5).
type Integrity struct {
	LockfileIntegrity  bool `json:"lockfileIntegrity"`
	SignaturesVerified int  `json:"signaturesVerified"`
	SignaturesMissing  int  `json:"signaturesMissing"`
	SignaturesInvalid  int  `json:"signaturesInvalid"`
}

// Layer is layer.json.
type Layer struct {
	Digest      string    `json:"digest"`
	Key         string    `json:"key"`
	ImageDigest string    `json:"imageDigest"`
	BuiltAt     time.Time `json:"builtAt"`
	// BinaryPath is the entry script relative to the layer's root, symlinks
	// resolved; the caller prefixes the mount point.
	BinaryPath  string    `json:"binaryPath"`
	Interpreter string    `json:"interpreter"`
	Bytes       int64     `json:"bytes"`
	Integrity   Integrity `json:"integrity"`
	Entries     []Entry   `json:"entries"`
}

type sysInfo struct {
	ino     uint64
	ctimeNs int64
	nlink   uint64
	uid     int
}

func fingerprintOf(fi fs.FileInfo) Fingerprint {
	fp := Fingerprint{Size: fi.Size(), MtimeNs: fi.ModTime().UnixNano()}
	if s, ok := sysOf(fi); ok {
		fp.Ino, fp.CtimeNs = s.ino, s.ctimeNs
	}
	return fp
}
