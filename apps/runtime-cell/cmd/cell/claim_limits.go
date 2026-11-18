package main

import (
	"context"
	"errors"
	"log/slog"
	"path/filepath"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/claimlimits"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockergvisor"
)

func validateClaimEndpoint(raw string) error { return dockergvisor.ValidateClaimLimitEndpoint(raw) }

type claimLimitFactory func(context.Context, string, string, string) (claimlimits.Lifecycle, error)

// drainCell ends what the cell's previous process left running.
type drainCell func(context.Context) error

// This opens only an operator-provisioned root. Docker/root configuration is
// never changed here. Startup must reconcile old claims before a fresh ledger.
func configureClaimLimits(ctx context.Context, cli dockercli.CLI, st settings, cellID string, log *slog.Logger) (claimlimits.Lifecycle, error) {
	drain := func(ctx context.Context) error {
		rp, err := dockergvisor.NewForReaper(cli, dockergvisor.ReaperConfig{CellID: cellID, WorkDir: filepath.Join(st.WorkDir, "compose"), EgressContainer: st.GVisorEgressContainer, Log: log})
		if err != nil {
			return err
		}
		n, err := rp.Drain(ctx)
		log.Warn("cell.claim_limits.drained", "machines", n, "ok", err == nil, "alarm", true)
		return err
	}
	return configureClaimLimitsWith(ctx, cli, st, cellID, func(ctx context.Context, backend, root, cellID string) (claimlimits.Lifecycle, error) {
		if backend == "systemd" {
			return claimlimits.NewSystemd(ctx, root, cellID)
		}
		return claimlimits.New(root)
	}, drain)
}

// configureClaimLimitsWith opens the claim limits and reconciles what the
// previous process left. A resource group still populated is a claim of that
// process, which nothing here adopts (leases live in the cell's memory): it
// is drained (its machines ended, as the lease sweep would end them after
// the start), then the root is pruned and checked again. The start used to
// refuse until every old machine's ceiling passed, hours of crash loop after
// a restart with live claims, a rollback included (R3-04).
func configureClaimLimitsWith(ctx context.Context, cli dockercli.CLI, st settings, cellID string, open claimLimitFactory, drain drainCell) (claimlimits.Lifecycle, error) {
	endpoint, err := cli.DaemonEndpoint(ctx)
	if err != nil {
		return nil, err
	}
	if err = validateClaimEndpoint(endpoint); err != nil {
		return nil, err
	}
	info, err := cli.CgroupInfo(ctx)
	if err != nil {
		return nil, err
	}
	if err = dockergvisor.ValidateClaimLimitDaemon(info, st.GVisorClaimLimitBackend, "runsc"); err != nil {
		return nil, err
	}
	root := st.GVisorClaimCgroupRoot
	if st.GVisorClaimLimitBackend == "systemd" {
		root = st.GVisorClaimRootSlice
	}
	manager, err := open(ctx, st.GVisorClaimLimitBackend, root, cellID)
	if err != nil {
		return nil, err
	}
	if err = manager.PruneEmpty(); err != nil {
		_ = manager.Close()
		return nil, err
	}
	if err = manager.RequireEmpty(); err != nil {
		if derr := drain(ctx); derr != nil {
			_ = manager.Close()
			return nil, errors.Join(err, derr)
		}
		if err = errors.Join(manager.PruneEmpty(), manager.RequireEmpty()); err != nil {
			_ = manager.Close()
			return nil, err
		}
	}
	return manager, nil
}
