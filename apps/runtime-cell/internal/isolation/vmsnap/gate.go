// Package vmsnap is the rules and the store of microVM snapshots
// (docs/runtime/isolation-p3-snapshots.md): which machine may become a
// snapshot and for what, what a snapshot is on disk (its manifest, its files
// and their digests), whether this host can restore it, and when it goes.
//
// It holds no machine and reaches no VMM: a backend asks it before it
// snapshots and before it restores, and keeps its files in the Store.
package vmsnap

import (
	"errors"
	"fmt"
	"slices"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation"
)

// ErrRefused is a snapshot or a restore the rules do not allow; errors.Is
// finds it in every refusal of this package.
var ErrRefused = errors.New("vmsnap: refused")

// RefusedError says why.
type RefusedError struct{ Reason string }

func (e *RefusedError) Error() string { return "vmsnap: refused: " + e.Reason }

func (e *RefusedError) Is(target error) bool { return target == ErrRefused }

func refuse(format string, a ...any) error {
	return &RefusedError{Reason: fmt.Sprintf(format, a...)}
}

// Facts are what the backend recorded of a machine when it was made and
// since: never what the caller says of it.
type Facts struct {
	Org    string
	Claim  string
	Setup  bool
	Pool   bool
	Taints []isolation.Taint
}

// Purpose is isolation.Purpose, named here for the rules.
type Purpose = isolation.Purpose

// never are the taints that forbid every snapshot: what they name would be
// in every machine restored from it.
var never = []isolation.Taint{isolation.TaintSecrets, isolation.TaintCredentials, isolation.TaintCanaries}

// Admit says whether a machine with facts may become a snapshot for
// purpose, asked by a caller that believes it is org's.
//
//   - The org must be the machine's own, and known.
//   - A machine that was handed secrets, credentials or canaries never
//     becomes a snapshot of any kind.
//   - A pooled machine never does: it is handed to a claim after it is made.
//   - A template comes only from a setup's machine that never ran a PR's code.
//   - A round is the claim's own: it may hold what the claim was handed (its
//     secrets' placeholders, its canaries, its PR's code), because it is
//     restored only into that claim's same machine and removed with it.
func Admit(f Facts, purpose Purpose, org string) error {
	if f.Org == "" || org != f.Org {
		return refuse("the machine is not of org %q", org)
	}
	if purpose == isolation.PurposeRound {
		switch {
		case f.Pool:
			return refuse("a pooled machine is never a snapshot")
		case f.Claim == "":
			return refuse("a round snapshot needs the machine's claim")
		}
		return nil
	}
	for _, t := range never {
		if slices.Contains(f.Taints, t) {
			return refuse("the machine was handed %s", t)
		}
	}
	if f.Pool {
		return refuse("a pooled machine is never a snapshot")
	}
	switch purpose {
	case isolation.PurposeTemplate:
		if !f.Setup {
			return refuse("only a setup's machine becomes a template")
		}
		if slices.Contains(f.Taints, isolation.TaintPRCode) {
			return refuse("a machine that ran a PR's code never becomes a template")
		}
	case isolation.PurposeSession:
	default:
		return refuse("unknown purpose %q", purpose)
	}
	return nil
}

// KnownTaint reports whether t is one of the taints the rules know.
func KnownTaint(t isolation.Taint) bool {
	return slices.Contains(never, t) || t == isolation.TaintPRCode
}
