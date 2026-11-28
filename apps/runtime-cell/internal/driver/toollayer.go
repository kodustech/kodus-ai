package driver

import (
	"context"
	"errors"
)

// Tool layers (docs/runtime/persistent-state.md section 4): the tree a team
// CLI's install leaves, built once per org in a clean builder sandbox and
// mounted read-only into that org's review sandboxes. A driver that keeps
// them says so with Parts.ToolLayers; one that does not (a nil part) is
// never asked.

// ToolLayerMountDir is where a layer is mounted in a sandbox: the same
// absolute path in the builder and in every review.
const ToolLayerMountDir = "/opt/kcli"

// ErrToolLayerRequest is a layer request the cell refuses as malformed (an id
// that is not a safe mount name, a key that is not a digest).
var ErrToolLayerRequest = errors.New("driver: invalid tool layer request")

// ToolLayerRef is one layer a review asks to mount at /opt/kcli/<ID>.
type ToolLayerRef struct{ Key, ID string }

// ToolLayerState is what the driver decided for one requested layer.
type ToolLayerState struct {
	ID string
	// Hit: the layer is mounted read-only at ToolLayerMountDir/<ID>.
	Hit bool
	// Reason says why a miss: no_key, corrupt, evicted, disabled,
	// no_image_digest or error.
	Reason string
	// Build: the cell wants a builder claim for this key (U9: the second miss
	// of the key within 7 days).
	Build bool
	// BinaryPath is the CLI's entry script under the mount point and
	// Interpreter the image's binary that runs it; Digest the layer's.
	BinaryPath, Interpreter, Digest string
}

// ToolLayerBuild is what a builder sandbox runs: the API's install plan, the
// binary the layer must hold and the one registry host the builder reaches.
type ToolLayerBuild struct {
	Key, ID   string
	Installer string
	Argv      []string
	Binary    string
	Registry  string
}

// ToolLayerIntegrity is what the builder found out about the installed
// packages' signatures (U5).
type ToolLayerIntegrity struct {
	LockfileIntegrity  bool
	SignaturesVerified int
	SignaturesMissing  int
	SignaturesInvalid  int
}

// ToolLayerBuilt is a layer the store kept.
type ToolLayerBuilt struct {
	Digest string
	Bytes  int64
	// Unsigned counts the packages with no registry signature, recorded and allowed.
	Unsigned int
}

// ToolLayers is a driver's tool layer store and its two doors: mounting a
// layer into a sandbox (SandboxRequest.ToolLayers, answered by States) and
// reading a builder's layer into the store (Ingest).
type ToolLayers interface {
	// ImageDigest is the content digest of the sandbox image a layer is built
	// for and mounted into (sha256:<64 hex>); empty: the driver keeps no layers.
	ImageDigest() string
	// CheckBuild re-validates a build request the way the API's plan was
	// validated; a refusal is an error and nothing is built.
	CheckBuild(b ToolLayerBuild) error
	// States are what CreateSandbox decided for the machine's layers; nil for a
	// machine that asked for none.
	States(ref MachineRef) []ToolLayerState
	// BeginBuild admits one build of key for org (single-flight, one at a time
	// per cell and two per org, no retry for 10 minutes after a failure) and
	// returns the function that ends it, failed saying how it ended.
	BeginBuild(org, key string) (end func(failed bool), err error)
	// Ingest reads /opt/kcli/<b.ID> out of the builder machine ref as one tar
	// stream, through the machine's exec stream, into the org's store.
	Ingest(ctx context.Context, org string, ref MachineRef, b ToolLayerBuild, in ToolLayerIntegrity) (ToolLayerBuilt, error)
	// PurgeOrg removes everything stored for the org.
	PurgeOrg(org string) error
}

// ErrBuildRefused is BeginBuild's answer when a build must not start; its
// message is a short code (in_flight, recent_failure, cell_busy, org_busy).
type ErrBuildRefused struct{ Reason string }

func (e *ErrBuildRefused) Error() string { return "driver: tool layer build refused: " + e.Reason }

// ToolLayerError is a failed Ingest, with the short snake_case code that
// goes to the hub (toollayer.failed reason): the store's refusal
// (symlink_absolute, too_large, invalid_signature, tar_truncated...) or
// ingest_failed. It never carries the builder's output.
type ToolLayerError struct {
	Reason string
	Err    error
}

func (e *ToolLayerError) Error() string {
	return "driver: tool layer " + e.Reason + ": " + e.Err.Error()
}
func (e *ToolLayerError) Unwrap() error { return e.Err }
