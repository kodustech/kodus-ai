"use client";

import { useCallback, useMemo } from "react";
import { Action, ResourceType } from "@services/permissions/types";
import {
    prRuntimeCell,
    prRuntimeKey,
    type PrRuntimeCell,
} from "@services/runtime/model/pull-request-runs";
import { usePullRequestRuns } from "@services/runtime/pull-request-runs";
import { useFeatureFlags } from "src/app/(app)/settings/_components/context";
import { isReleasedTo } from "src/core/config/feature-flags";
import { useAuth } from "src/core/providers/auth.provider";
import { usePermissions } from "src/core/providers/permissions.provider";
import { hasPermission } from "src/core/utils/permission-map";

import type { PrRowRuntime } from "./pr-list-item";
import type { PullRequestExecutionGroup } from "./types";

/**
 * The Runtime state of the loaded rows of the pull requests list. Only the
 * repositories whose Runs the viewer may read are asked for, in one call per
 * chunk of PRs; a viewer who reads no Runs, or an org Kody Runtime is not
 * released to (the `kody-runtime` catalog flag, stage alpha), gets no column,
 * filter or count (`enabled` false) and no request.
 */
export const usePrListRuntime = (groups: PullRequestExecutionGroup[]) => {
    const { organizationId } = useAuth();
    const permissions = usePermissions();
    const canRead = useCallback(
        (repoId?: string) =>
            hasPermission({
                permissions,
                organizationId: organizationId!,
                action: Action.Read,
                resource: ResourceType.RuntimeRun,
                repoId,
            }),
        [permissions, organizationId],
    );
    const released = isReleasedTo("kodyRuntime", useFeatureFlags());
    const enabled = released && canRead();

    const pullRequests = useMemo(
        () =>
            enabled
                ? groups
                      .filter((g) => canRead(g.latest.repositoryId))
                      .map((g) => ({
                          repositoryId: g.latest.repositoryId,
                          prNumber: g.latest.prNumber,
                      }))
                : [],
        [groups, enabled, canRead],
    );
    const { byPullRequest, isLoading, unavailable, retry } =
        usePullRequestRuns(pullRequests, enabled);

    const cells = useMemo(() => {
        const map = new Map<string, PrRuntimeCell>();
        for (const g of groups) {
            const key = prRuntimeKey(g.latest.repositoryId, g.latest.prNumber);
            const data = byPullRequest.get(key);
            if (!data) continue;
            // The newest commit Kodus knows of: the one the latest review read.
            map.set(
                key,
                prRuntimeCell(data, {
                    sha: g.latest.reviewedCommitSha,
                    at:
                        g.latest.automationExecution?.createdAt ??
                        g.latest.createdAt,
                }),
            );
        }
        return map;
    }, [groups, byPullRequest]);

    const cellOf = useCallback(
        (g: PullRequestExecutionGroup) =>
            cells.get(prRuntimeKey(g.latest.repositoryId, g.latest.prNumber)),
        [cells],
    );

    const rowOf = useCallback(
        (g: PullRequestExecutionGroup): PrRowRuntime => {
            const key = prRuntimeKey(g.latest.repositoryId, g.latest.prNumber);
            return {
                canRead: canRead(g.latest.repositoryId),
                data: byPullRequest.get(key),
                // A failed read is unknown, not "no environment". Once the
                // answer is in, a PR it left out has nothing to show.
                cell:
                    cells.get(key) ??
                    (unavailable.has(key)
                        ? { kind: "unavailable" }
                        : isLoading
                          ? undefined
                          : { kind: "no_environment" }),
                retry,
            };
        },
        [canRead, byPullRequest, cells, isLoading, unavailable, retry],
    );

    // Unknown (null, shown as "—") while a read failed: 0 would be false.
    const regressionCount = useMemo(
        () =>
            unavailable.size
                ? null
                : [...cells.values()].filter(
                      (cell) => cell.kind === "regression" && cell.count > 0,
                  ).length,
        [cells, unavailable],
    );

    return { enabled, rowOf, cellOf, regressionCount, isLoading };
};
