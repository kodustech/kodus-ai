"use client";

import { useMemo } from "react";
import NextLink from "next/link";
import {
    RuntimeEmptyState,
    RuntimeErrorState,
} from "@components/runtime/empty-state";
import { EnvironmentMetrics } from "@components/runtime/environment-metrics";
import {
    EnvironmentSetupCard,
    SetupEnvironmentButton,
} from "@components/runtime/environment-setup";
import { RelativeTime } from "@components/runtime/relative-time";
import { RuntimeSection } from "@components/runtime/section";
import { StatusChip } from "@components/runtime/status-chip";
import { Heading } from "@components/ui/heading";
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
    blockerKindLabel,
    blockerStateLabel,
    blockerStateTone,
} from "@services/runtime/labels";
import {
    blockerAnchorId,
    groupBlockersBySignature,
} from "@services/runtime/model/blockers";
import { hasEnvironmentMetrics } from "@services/runtime/model/environment";
import {
    useEnvironmentBlockers,
    useRuntimeEnvironment,
} from "@services/runtime/queries";
import { ArrowLeftIcon } from "lucide-react";

import { ApproveHostButton } from "../_components/egress-approval";

const EGRESS_PHASE_LABEL: Record<string, string> = {
    build: "Setup",
    test: "Test",
};

/**
 * Environment Health (docs §4, §11): boot success rate, time to ready, the
 * last setup, the blockers grouped by signature and the outbound requests
 * the proxy denied.
 */
export const EnvironmentHealthPage = ({
    environmentId,
}: {
    environmentId: string;
}) => {
    const environment = useRuntimeEnvironment(environmentId);
    const blockers = useEnvironmentBlockers(environmentId);
    // Egress approvals are for the org owner (POST .../egress-approvals).
    const canManageRuntime = usePermission(
        Action.Manage,
        ResourceType.RuntimeEnvironment,
    );
    const groups = useMemo(
        () => groupBlockersBySignature(blockers.data ?? []),
        [blockers.data],
    );

    const env = environment.data ?? undefined;
    const approved = new Set((env?.egressApprovals ?? []).map((a) => a.host));
    const egress = [...(env?.metrics?.egressBlocked ?? [])].sort(
        (a, b) => b.count - a.count,
    );
    const backHref = `/runtime/environments/${encodeURIComponent(environmentId)}`;

    return (
        <Page.Root>
            <Page.Header>
                <div className="flex flex-col gap-2">
                    <NextLink
                        href={backHref}
                        className="text-text-tertiary flex items-center gap-1 text-xs hover:underline">
                        <ArrowLeftIcon className="size-3" aria-hidden />{" "}
                        {env?.repositoryName ?? "Environment"}
                    </NextLink>
                    <Heading variant="h1">Environment health</Heading>
                    <p className="text-text-secondary text-sm">
                        For diagnosing: how often it boots, the last setup in
                        full, every blocker seen and the outbound requests
                        refused. To change the environment, go back to{" "}
                        <NextLink
                            href={backHref}
                            className="text-primary-light hover:underline">
                            its page
                        </NextLink>
                        .
                    </p>
                </div>
                {env && (
                    <Page.HeaderActions>
                        <SetupEnvironmentButton env={env} size="md" />
                    </Page.HeaderActions>
                )}
            </Page.Header>

            <Page.Content>
                {environment.isLoading ? (
                    <Skeleton className="h-24 w-full" />
                ) : environment.isError ? (
                    <RuntimeErrorState
                        what="this environment"
                        error={environment.error}
                        onRetry={() => environment.refetch()}
                    />
                ) : !env ? (
                    <RuntimeEmptyState title="Environment not found" />
                ) : (
                    <>
                        {hasEnvironmentMetrics(env.metrics) ? (
                            <EnvironmentMetrics metrics={env.metrics} />
                        ) : (
                            <p className="text-text-secondary text-sm">
                                No Run or setup booted in the last 7 days, so
                                there is no boot rate or time to ready yet.
                            </p>
                        )}
                        <RuntimeSection
                            title="Last setup, in full"
                            description="Each step, its blockers and, when it failed, what the machine collected: services, log tails, ports, disk and refused hosts.">
                            <EnvironmentSetupCard env={env} detailed />
                        </RuntimeSection>
                    </>
                )}

                <RuntimeSection
                    title="Blockers by signature"
                    description="The same failure seen on many PRs is one row. The most frequent signature is usually an outdated setup file or a platform image to fix.">
                    {blockers.isLoading ? (
                        <Skeleton className="h-24 w-full" />
                    ) : blockers.isError ? (
                        <RuntimeErrorState
                            what="blockers"
                            error={blockers.error}
                            onRetry={() => blockers.refetch()}
                        />
                    ) : groups.length === 0 ? (
                        <p className="text-text-secondary text-sm">
                            No blockers recorded for this environment.
                        </p>
                    ) : (
                        <TableContainer>
                            <Table>
                                <TableHeader>
                                    <TableRow>
                                        <TableHead>Blocker</TableHead>
                                        <TableHead>Kind</TableHead>
                                        <TableHead>State</TableHead>
                                        <TableHead>Seen</TableHead>
                                        <TableHead>Last PR</TableHead>
                                        <TableHead>Last seen</TableHead>
                                        <TableHead>Suggested fix</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {groups.map((group) => (
                                        <TableRow
                                            key={group.signature}
                                            id={blockerAnchorId(
                                                group.signature,
                                            )}
                                            className="target:bg-card-lv2 scroll-mt-24">
                                            <TableCell>
                                                <span className="flex flex-col">
                                                    <span className="text-sm">
                                                        {group.title ??
                                                            group.signature}
                                                    </span>
                                                    {group.title && (
                                                        <span className="text-text-tertiary font-mono text-xs">
                                                            {group.signature}
                                                        </span>
                                                    )}
                                                </span>
                                            </TableCell>
                                            <TableCell className="text-sm">
                                                {blockerKindLabel(group.kind)}
                                            </TableCell>
                                            <TableCell>
                                                {group.state ? (
                                                    <StatusChip
                                                        tone={blockerStateTone(
                                                            group.state,
                                                        )}>
                                                        {blockerStateLabel(
                                                            group.state,
                                                        )}
                                                    </StatusChip>
                                                ) : (
                                                    "—"
                                                )}
                                            </TableCell>
                                            <TableCell className="font-mono text-xs">
                                                {group.count}×
                                            </TableCell>
                                            <TableCell className="font-mono text-xs">
                                                {group.lastPr
                                                    ? `#${group.lastPr}`
                                                    : "—"}
                                            </TableCell>
                                            <TableCell>
                                                <RelativeTime
                                                    at={group.lastAt}
                                                />
                                            </TableCell>
                                            <TableCell className="text-text-secondary text-sm">
                                                {group.fixes?.[0]?.label ?? "—"}
                                            </TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        </TableContainer>
                    )}
                </RuntimeSection>

                <RuntimeSection
                    title="Outbound requests blocked"
                    description="Hosts the outbound proxy refused during setup or test. A blocked request forces the check to neutral; approve a legitimate host for this environment, or add it to the setup file by PR.">
                    {environment.isLoading ? (
                        <Skeleton className="h-16 w-full" />
                    ) : egress.length === 0 ? (
                        <p className="text-text-secondary text-sm">
                            No outbound request was blocked.
                        </p>
                    ) : (
                        <TableContainer>
                            <Table>
                                <TableHeader>
                                    <TableRow>
                                        <TableHead>Host</TableHead>
                                        <TableHead>Phase</TableHead>
                                        <TableHead>Blocked</TableHead>
                                        <TableHead>Last</TableHead>
                                        {canManageRuntime && (
                                            <TableHead>
                                                <span className="sr-only">
                                                    Approval
                                                </span>
                                            </TableHead>
                                        )}
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {egress.map((row) => (
                                        <TableRow
                                            key={`${row.host}:${row.port ?? ""}:${row.phase ?? ""}`}>
                                            <TableCell className="font-mono text-xs">
                                                {row.host}
                                                {row.port ? `:${row.port}` : ""}
                                            </TableCell>
                                            <TableCell className="text-sm">
                                                {row.phase
                                                    ? (EGRESS_PHASE_LABEL[
                                                          row.phase
                                                      ] ?? row.phase)
                                                    : "—"}
                                            </TableCell>
                                            <TableCell className="font-mono text-xs">
                                                {row.count}×
                                            </TableCell>
                                            <TableCell>
                                                <RelativeTime at={row.lastAt} />
                                            </TableCell>
                                            {canManageRuntime && (
                                                <TableCell>
                                                    {approved.has(row.host) ? (
                                                        <StatusChip tone="success">
                                                            Approved
                                                        </StatusChip>
                                                    ) : (
                                                        <ApproveHostButton
                                                            environmentId={
                                                                environmentId
                                                            }
                                                            host={row.host}
                                                        />
                                                    )}
                                                </TableCell>
                                            )}
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        </TableContainer>
                    )}
                </RuntimeSection>
            </Page.Content>
        </Page.Root>
    );
};
