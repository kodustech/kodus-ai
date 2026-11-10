package agent

import (
	"context"
	"encoding/json"
	"errors"
	"path"
	"strings"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/claims"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/hubclient"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/lease"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/transport"
)

// Handle is the hubclient.Handler. It runs on the connection's read loop:
// it validates, answers ack or nack at once, and starts the work in the
// background. Anything that needs I/O before the answer (claim.renew moves
// cloud tags) answers through hubclient.Later.
func (a *Agent) Handle(_ context.Context, m *protocol.Message) error {
	a.deadman.Contact()
	claimID := ""
	if m.Envelope.ClaimID != nil {
		claimID = *m.Envelope.ClaimID
	}
	if claimID != "" && !claims.ValidID(claimID) {
		return nack("invalid_envelope", "claimId is not a valid claim id")
	}
	switch b := m.Body.(type) {
	case *protocol.ClaimAcquireBody:
		return a.acquire(claimID, *b)
	case *protocol.ClaimRenewBody:
		return a.renew(claimID, b)
	case *protocol.ClaimReleaseBody:
		return a.releaseFrame(claimID)
	case *protocol.BrowserExploreBody:
		return a.browserExploreFrame(claimID, b)
	case *protocol.ProbeRunBody:
		canon, _ := json.Marshal(b.Probe)
		return a.admitStep(stepAdmission{kind: m.Envelope.Type, claimID: claimID, stepID: b.StepID, canon: append([]byte("probe.run\x00"), canon...)},
			func(ctx context.Context, c *claims.Claim) { a.runProbe(ctx, m.Envelope.ID, c, b) })
	case *protocol.ExecBody:
		cwd, err := execCwd(b.Cwd)
		if err != nil {
			return nack("invalid_body", "cwd: %v", err)
		}
		return a.admitStep(stepAdmission{kind: m.Envelope.Type, claimID: claimID, stepID: b.StepID, canon: []byte("exec\x00" + b.Command + "\x00" + cwd), allowHeld: true},
			func(ctx context.Context, c *claims.Claim) { a.runExec(ctx, c, b, cwd) })
	case *protocol.MachineResetBody:
		return a.admitStep(stepAdmission{kind: m.Envelope.Type, claimID: claimID, stepID: b.StepID, canon: []byte("machine.reset\x00" + string(b.Snapshot.Kind) + "\x00" + b.Snapshot.Ref)},
			func(ctx context.Context, c *claims.Claim) { a.runReset(ctx, c, b) })
	case *protocol.EgressPolicyBody:
		return a.egressPolicy(claimID, b)
	case *protocol.ExecCancelBody:
		c, ok := a.claims.Get(claimID)
		if !ok {
			return nack("unknown_claim", "%s", claimID)
		}
		if c.CancelStep(b.StepID) {
			c.Log.Info("step.cancel", "step", b.StepID)
		}
		return nil
	case *protocol.UploadBody:
		return nack("not_implemented", "upload needs the evidence store (contentRef)")
	case *protocol.ImageBakeBody:
		return a.bake(claimID, *b)
	case *protocol.PoolTargetBody:
		return a.poolTarget(claimID, *b)
	case *protocol.CellRevokedBody:
		a.deadman.Revoke()
		a.log.Error("cell.revoked", "alarm", true, "reason", b.Reason)
		return nil
	}
	return nack("unexpected_type", "%s is not sent by the hub", m.Envelope.Type)
}

// renew answers claim.renew once the machines' kodus:expires moved: an ack
// means the sweep will not take them before the new end.
func (a *Agent) renew(claimID string, b *protocol.ClaimRenewBody) error {
	until, err := protocol.ParseTime(b.LeaseExpiresAt)
	if err != nil {
		return nack("invalid_body", "leaseExpiresAt")
	}
	c, ok := a.claims.Get(claimID)
	if !ok || c.State() == claims.Released {
		return nack("unknown_claim", "%s", claimID)
	}
	return hubclient.Later(func(ctx context.Context) error {
		got, err := a.leases.Renew(ctx, claimID, until)
		switch {
		case err == nil:
			c.Log.Debug("claim.renew", "until", protocol.FormatTime(got))
			return nil
		case errors.Is(err, lease.ErrUnknownClaim):
			return nack("unknown_claim", "%s", claimID)
		case errors.Is(err, lease.ErrExpired):
			return nack("claim_expired", "%s", claimID)
		}
		c.Log.Warn("claim.renew.failed", "err", err)
		return nack("renew_failed", "kodus:expires not moved; retry")
	})
}

// execCwd confines exec.cwd to the workspace: a relative path of plain
// segments, as the transport gets it under transport.Workspace.
func execCwd(cwd *string) (string, error) {
	if cwd == nil || *cwd == "" || *cwd == "." {
		return transport.Workspace, nil
	}
	c := *cwd
	if strings.ContainsAny(c, "\x00\\") || strings.HasPrefix(c, "/") {
		return "", errors.New("must be a relative path inside the workspace")
	}
	clean := path.Clean(c)
	if clean == ".." || strings.HasPrefix(clean, "../") {
		return "", errors.New("leaves the workspace")
	}
	return path.Join(transport.Workspace, clean), nil
}
