package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path"
	"strings"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/telemetry"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/claims"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/hubclient"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/lease"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/recipe"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/transport"
)

// Handle is the hubclient.Handler. It runs on the connection's read loop:
// it validates, answers ack or nack at once, and starts the work in the
// background. Anything that needs I/O before the answer (claim.renew moves
// cloud tags) answers through hubclient.Later.
func (a *Agent) Handle(ctx context.Context, m *protocol.Message) error {
	a.deadman.Contact()
	claimID := ""
	if m.Envelope.ClaimID != nil {
		claimID = *m.Envelope.ClaimID
	}
	if claimID != "" && !claims.ValidID(claimID) {
		return nack("invalid_envelope", "claimId is not a valid claim id")
	}
	// The hub's span that sent the frame (feature traceContext): this frame's spans are its children.
	tctx := telemetry.Remote(context.WithoutCancel(ctx), m.Envelope.Traceparent)
	switch b := m.Body.(type) {
	case *protocol.ClaimAcquireBody:
		if b.Consumer == protocol.ConsumerSandbox {
			return nack("invalid_body", "a sandbox claim comes in sandbox.acquire")
		}
		return a.acquire(tctx, claimID, *b)
	case *protocol.SandboxAcquireBody:
		return a.sandboxAcquire(tctx, claimID, *b)
	case *protocol.SandboxOpBody:
		return a.sandboxOpFrame(tctx, claimID, b)
	case *protocol.ClaimRenewBody:
		return a.renew(claimID, b)
	case *protocol.ClaimReleaseBody:
		return a.releaseFrame(claimID)
	case *protocol.BrowserExploreBody:
		if err := a.refusedOnSandbox(claimID, m.Envelope.Type); err != nil {
			return err
		}
		return a.browserExploreFrame(tctx, claimID, b)
	case *protocol.ProbeRunBody:
		if err := a.refusedOnSandbox(claimID, m.Envelope.Type); err != nil {
			return err
		}
		canon, _ := json.Marshal(b.Probe)
		return a.admitStep(stepAdmission{trace: tctx, kind: m.Envelope.Type, claimID: claimID, stepID: b.StepID, canon: append([]byte("probe.run\x00"), canon...)},
			func(ctx context.Context, c *claims.Claim) { a.runProbe(ctx, m.Envelope.ID, c, b) })
	case *protocol.ExecBody:
		if err := a.refusedOnSandbox(claimID, m.Envelope.Type); err != nil {
			return err
		}
		cwd, err := execCwd(b.Cwd)
		if err != nil {
			return nack("invalid_body", "cwd: %v", err)
		}
		repo, err := a.execRepository(claimID, b.Repository)
		if err != nil {
			return nack("invalid_body", "repository: %v", err)
		}
		service := ""
		if b.Service != nil {
			service = *b.Service
		}
		if service != "" && repo != "" {
			return nack("invalid_body", "service: a command runs in a service or on a repository's code, not both")
		}
		canon := "exec\x00" + b.Command + "\x00" + cwd
		if repo != "" {
			canon += "\x00repository:" + repo
		}
		if service != "" {
			canon += "\x00service:" + service
		}
		return a.admitStep(stepAdmission{trace: tctx, kind: m.Envelope.Type, claimID: claimID, stepID: b.StepID, canon: []byte(canon), allowHeld: true},
			func(ctx context.Context, c *claims.Claim) { a.runExec(ctx, c, b, cwd, repo, service) })
	case *protocol.ClaimSnapshotBody:
		return a.claimSnapshot(tctx, claimID, b)
	case *protocol.ClaimExercisedBody:
		return a.claimExercised(tctx, claimID, b)
	case *protocol.MachineResetBody:
		// A sandbox claim resets only to its own round snapshot.
		if b.Snapshot.Kind != protocol.SnapshotKindMemory {
			if err := a.refusedOnSandbox(claimID, m.Envelope.Type); err != nil {
				return err
			}
		} else if a.cfg.Parts.Snapshots == nil {
			return nack("snapshot_unsupported", "this cell's %s driver keeps no memory snapshot", a.cfg.Driver.Kind())
		}
		return a.admitStep(stepAdmission{trace: tctx, kind: m.Envelope.Type, claimID: claimID, stepID: b.StepID, canon: []byte("machine.reset\x00" + string(b.Snapshot.Kind) + "\x00" + b.Snapshot.Ref)},
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
		if err := a.refusedOnSandbox(claimID, m.Envelope.Type); err != nil {
			return err
		}
		if err := checkUpload(b); err != nil {
			return nack("invalid_body", "%v", err)
		}
		return a.admitStep(stepAdmission{trace: tctx, kind: m.Envelope.Type, claimID: claimID, stepID: b.StepID, canon: uploadCanon(b)},
			func(ctx context.Context, c *claims.Claim) { a.runUpload(ctx, c, b) })
	case *protocol.ImageBakeBody:
		return a.bake(tctx, claimID, *b)
	case *protocol.PoolTargetBody:
		return a.poolTarget(claimID, *b)
	case *protocol.PreviewTunnelBody:
		return a.previewTunnel(b)
	case *protocol.PreviewRouteBody:
		return a.previewRoute(claimID, b)
	case *protocol.PreviewUnrouteBody:
		return a.previewUnroute(claimID, b)
	case *protocol.SnapshotForgetBody:
		return a.forgetSessions(ctx, *b)
	case *protocol.OrgPurgeBody:
		return a.orgPurge(*b)
	case *protocol.CellSealBody:
		return a.cellSeal()
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
	// The claim's store credential is short: the hub renews it with the lease.
	a.renewStore(claimID, b.ImageStoreGrant)
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

// execRepository is the other repository of the claim an exec runs on
// (exec.repository): one of claim.acquire repos on a cell that lays
// workspaces out. The claim's own alias, or none, is "": the command runs
// where every command of the claim runs.
func (a *Agent) execRepository(claimID string, repository *string) (string, error) {
	if repository == nil || *repository == "" {
		return "", nil
	}
	c, ok := a.claims.Get(claimID)
	if !ok {
		return "", nil // admitStep answers the unknown claim
	}
	if recipe.AliasOf(c.Acquire.Repo.FullName) == *repository {
		return "", nil
	}
	if !a.laysOutWorkspaces() {
		return "", errors.New("this cell does not lay out repositories side by side")
	}
	for _, r := range c.Acquire.Repos {
		if r.Alias == *repository {
			return r.Alias, nil
		}
	}
	return "", fmt.Errorf("%s is not a repository of this claim", *repository)
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
