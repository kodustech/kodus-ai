package agent

import (
	"errors"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/redact"
)

// blockerError is a prepare failure with the Blocker kind and signature
// claim.failed reports.
type blockerError struct {
	kind      protocol.BlockerKind
	signature string
	err       error
}

func (e *blockerError) Error() string { return e.signature + ": " + e.err.Error() }
func (e *blockerError) Unwrap() error { return e.err }

func blockerErr(kind protocol.BlockerKind, signature string, err error) error {
	// A driver's failed host boundary is the cell's failure even when a
	// compose/recipe wrapper also marks it as a workload boot failure.
	if errors.Is(err, driver.ErrResourceCleanupPending) {
		kind, signature = protocol.BlockerKindPlatform, "resource_cleanup_pending"
	} else if errors.Is(err, driver.ErrResourceEnforcement) {
		kind, signature = protocol.BlockerKindPlatform, "resource_enforcement_unavailable"
	}
	return &blockerError{kind: kind, signature: signature, err: err}
}

// failedBody is claim.failed: what blocked the claim, by kind and signature.
func failedBody(err error) *protocol.ClaimFailedBody {
	reason, _ := redact.ClipMiddle(err.Error(), redact.MaxReason)
	b := &protocol.ClaimFailedBody{Kind: protocol.BlockerKindUnknown, Signature: "claim", Reason: reason}
	var be *blockerError
	if errors.As(err, &be) {
		b.Kind, b.Signature = be.kind, be.signature
	}
	return b
}
