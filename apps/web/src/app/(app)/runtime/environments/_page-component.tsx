"use client";

import {
    RuntimeEmptyState,
    RuntimeErrorState,
} from "@components/runtime/empty-state";
import { RelativeTime } from "@components/runtime/relative-time";
import { RuntimeHeader } from "@components/runtime/runtime-header";
import { RuntimeSection } from "@components/runtime/section";
import { StatusChip } from "@components/runtime/status-chip";
import { Page } from "@components/ui/page";
import { Skeleton } from "@components/ui/skeleton";
import {
    Table,
    TableBody,
    TableCell,
    TableContainer,
    TableHead,
    TableHeader,
    TableRow,
} from "@components/ui/table";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import {
    cellOwnerLabel,
    cellStatusLabel,
    cellStatusTone,
} from "@services/runtime/labels";
import { CELLS_SECTION_ID } from "@services/runtime/model/blockers";
import {
    firstReadyEnvironment,
    ONBOARDING_MAX_ENVIRONMENTS,
    onboardingState,
} from "@services/runtime/model/onboarding";
import {
    useRuntimeCells,
    useRuntimeEnvironments,
    useRuntimeRuns,
    useRuntimeSettings,
} from "@services/runtime/queries";

import { ConnectCell, RevokeCell } from "./_components/cell-actions";
import { AgentPromptHint } from "./_components/agent-prompt-hint";
import { EnvironmentsTable } from "./_components/environments-table";
import { FirstRun } from "./_components/first-run";

/** The managed fleet's entry carries no region or heartbeat: the API keeps per-cell data of shared machines in. */
const isManaged = (cell: { owner: string }) => cell.owner === "kodus";

const CellsSection = () => {
    const cells = useRuntimeCells();
    // Region and heartbeat exist only for your own cells.
    const ownCells = cells.data?.some((c) => !isManaged(c)) ?? false;
    return (
        <RuntimeSection
            id={CELLS_SECTION_ID}
            title="Hosts"
            description="A host is a server that runs Kody's machines, where Kody builds and runs the app of each pull request. By default that is Kodus cloud: machines Kodus runs for you, with nothing to set up here.">
            {cells.isLoading ? (
                <Skeleton className="h-24 w-full" />
            ) : cells.isError ? (
                <RuntimeErrorState
                    what="hosts"
                    error={cells.error}
                    onRetry={() => cells.refetch()}
                />
            ) : !cells.data?.length ? (
                <p className="text-text-secondary text-sm">
                    No host is available to this organization yet.
                </p>
            ) : (
                <TableContainer>
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>Host</TableHead>
                                <TableHead>Owner</TableHead>
                                <TableHead>Status</TableHead>
                                {ownCells && (
                                    <>
                                        <TableHead>Region</TableHead>
                                        <TableHead>Last heartbeat</TableHead>
                                    </>
                                )}
                                <TableHead>
                                    <span className="sr-only">Actions</span>
                                </TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {cells.data.map((cell) => (
                                <TableRow key={cell.cellId}>
                                    <TableCell
                                        className={
                                            cell.name
                                                ? "text-sm"
                                                : "font-mono text-xs"
                                        }>
                                        {cell.name ?? cell.cellId}
                                    </TableCell>
                                    <TableCell>
                                        {cellOwnerLabel(cell.owner)}
                                    </TableCell>
                                    <TableCell>
                                        <StatusChip
                                            tone={cellStatusTone(cell.status)}>
                                            {cellStatusLabel(cell.status)}
                                        </StatusChip>
                                    </TableCell>
                                    {ownCells &&
                                        (isManaged(cell) ? (
                                            <TableCell
                                                colSpan={2}
                                                className="text-text-tertiary text-sm">
                                                Managed by Kodus
                                            </TableCell>
                                        ) : (
                                            <>
                                                <TableCell>
                                                    {cell.region ??
                                                        "Not reported"}
                                                </TableCell>
                                                <TableCell>
                                                    <RelativeTime
                                                        at={
                                                            cell.lastHeartbeatAt
                                                        }
                                                    />
                                                </TableCell>
                                            </>
                                        ))}
                                    <TableCell className="text-right">
                                        <RevokeCell cell={cell} />
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </TableContainer>
            )}
            <ConnectCell />
        </RuntimeSection>
    );
};

export const EnvironmentsPage = () => {
    const environments = useRuntimeEnvironments();
    const settings = useRuntimeSettings();
    const canCreate = usePermission(
        Action.Update,
        ResourceType.CodeReviewSettings,
    );
    // Cells, stop and egress approvals: GET/POST /runtime/cells is for the
    // org owner on the API (checkRole OWNER); Manage on RuntimeEnvironment is
    // the same set of people in ROLE_POLICIES.
    const canManageRuntime = usePermission(
        Action.Manage,
        ResourceType.RuntimeEnvironment,
    );

    // The first-run guide (model/onboarding.ts): once an environment is
    // ready, it stays only until that repository has a Run.
    const envs = environments.data ?? [];
    const ready =
        envs.length < ONBOARDING_MAX_ENVIRONMENTS
            ? firstReadyEnvironment(envs)
            : undefined;
    const readyRuns = useRuntimeRuns({
        repositoryId: ready?.repositoryId,
        limit: 1,
    });
    const onboarding = environments.isSuccess
        ? onboardingState(
              envs,
              readyRuns.isSuccess ? readyRuns.data.length > 0 : undefined,
          )
        : undefined;
    // During the guide the cells are noise, unless the setup waits on one.
    const showCells =
        canManageRuntime &&
        (!onboarding ||
            onboarding.environment?.setup?.blockers?.[0]?.kind ===
                "cell_unavailable");

    return (
        <Page.Root>
            <RuntimeHeader />
            <Page.Content>
                <p className="text-text-secondary -mt-2 max-w-3xl text-sm">
                    An environment is how Kody boots one repository&apos;s app
                    on a clean machine to test its pull requests.{" "}
                    {onboarding
                        ? null
                        : canCreate
                        ? "Press Set up on a repository: Kody works out how to build and start it, in a few minutes. Set up several at once: a few run together and the rest wait their turn."
                        : "Someone who can edit repository settings sets them up here."}
                </p>
                {canCreate && !onboarding && <AgentPromptHint />}

                {environments.isLoading ||
                settings.isLoading ||
                (!!ready && readyRuns.isLoading) ? (
                    <Skeleton className="h-48 w-full" />
                ) : environments.isError ? (
                    <RuntimeErrorState
                        what="environments"
                        error={environments.error}
                        onRetry={() => environments.refetch()}
                    />
                ) : !environments.data?.length &&
                  !settings.data?.repositories?.length ? (
                    <RuntimeEmptyState title="No repositories yet">
                        Connect a repository in the Git settings; it shows up
                        here to set up.
                    </RuntimeEmptyState>
                ) : onboarding ? (
                    <FirstRun
                        onboarding={onboarding}
                        environments={envs}
                        repositories={settings.data?.repositories ?? []}
                        canCreate={canCreate}
                    />
                ) : (
                    <EnvironmentsTable
                        environments={environments.data ?? []}
                        repositories={settings.data?.repositories ?? []}
                        canCreate={canCreate}
                    />
                )}

                {showCells && <CellsSection />}
            </Page.Content>
        </Page.Root>
    );
};
