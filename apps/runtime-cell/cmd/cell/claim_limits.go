package main

import (
	"context"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/claimlimits"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockergvisor"
)

func validateClaimEndpoint(raw string) error { return dockergvisor.ValidateClaimLimitEndpoint(raw) }

type claimLimitFactory func(context.Context, string, string, string) (claimlimits.Lifecycle, error)

// This opens only an operator-provisioned root. Docker/root configuration is
// never changed here. Startup must reconcile old claims before a fresh ledger.
func configureClaimLimits(ctx context.Context, cli dockercli.CLI, st settings, cellID string) (claimlimits.Lifecycle, error) {
	return configureClaimLimitsWith(ctx, cli, st, cellID, func(ctx context.Context, backend, root, cellID string) (claimlimits.Lifecycle, error) {
		if backend == "systemd" {
			return claimlimits.NewSystemd(ctx, root, cellID)
		}
		return claimlimits.New(root)
	})
}
func configureClaimLimitsWith(ctx context.Context, cli dockercli.CLI, st settings, cellID string, open claimLimitFactory) (claimlimits.Lifecycle, error) {
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
		_ = manager.Close()
		return nil, err
	}
	return manager, nil
}
