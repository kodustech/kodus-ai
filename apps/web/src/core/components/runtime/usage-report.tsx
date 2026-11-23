"use client";

import { useState } from "react";
import NextLink from "next/link";
import {
    RuntimeEmptyState,
    RuntimeErrorState,
} from "@components/runtime/empty-state";
import { Metric, RuntimeSection } from "@components/runtime/section";
import { StatusChip } from "@components/runtime/status-chip";
import { RuntimeCostBlock } from "@components/runtime/usage-cost";
import { Button } from "@components/ui/button";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@components/ui/select";
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
import { toast } from "@components/ui/toaster/use-toast";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import {
    getRuntimeUsageCsv,
    type RuntimeUsageQuery,
} from "@services/runtime/api";
import type { RuntimeUsageReport } from "@services/runtime/contracts";
import { runStateLabel, runStateTone } from "@services/runtime/labels";
import { runtimeErrorMessage } from "@services/runtime/model/errors";
import {
    agentLabel,
    bootLine,
    consumerLabel,
    formatTokens,
    formatUnitMinutes,
    formatUsageMinutes,
    formatUsageUsd,
    NOT_MEASURED,
    startLabel,
    triggerLabel,
    usageCaveats,
    usageMonthOptions,
    usageSummaryTiles,
} from "@services/runtime/model/usage-report";
import {
    useRuntimeEnvironments,
    useRuntimeSettings,
    useRuntimeUsageReport,
} from "@services/runtime/queries";
import { DownloadIcon } from "lucide-react";

const ALL = "__all__";

const download = (filename: string, text: string) => {
    const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = "noopener";
    anchor.click();
    URL.revokeObjectURL(url);
};

const ExportButton = ({ query }: { query: RuntimeUsageQuery }) => {
    const [pending, setPending] = useState(false);
    return (
        <Button
            size="md"
            variant="secondary"
            leftIcon={<DownloadIcon />}
            loading={pending}
            onClick={async () => {
                setPending(true);
                try {
                    const { filename, text } = await getRuntimeUsageCsv(query);
                    download(filename, text);
                } catch (error) {
                    toast({
                        variant: "danger",
                        title: "Couldn't export the usage",
                        description: runtimeErrorMessage(error, {
                            fallback: "Try again in a moment.",
                            403: "Only the owner of the organization can export usage.",
                        }),
                    });
                } finally {
                    setPending(false);
                }
            }}>
            Export CSV
        </Button>
    );
};

const Summary = ({ report }: { report: RuntimeUsageReport }) => {
    const caveats = usageCaveats(report);
    return (
        <RuntimeSection
            title="This month"
            description="Everything Kody Runtime ran for your organization in the month (UTC): what ran, how long, on what machines, and what it cost. Costs are estimates from list prices, not a bill.">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
                {usageSummaryTiles(report).map((tile) => (
                    <Metric
                        key={tile.label}
                        label={tile.label}
                        value={tile.value}
                        hint={tile.hint}
                    />
                ))}
            </div>
            {caveats.length > 0 && (
                <ul className="text-text-tertiary list-disc pl-5 text-xs">
                    {caveats.map((c) => (
                        <li key={c}>{c}</li>
                    ))}
                </ul>
            )}
        </RuntimeSection>
    );
};

const LlmByAgent = ({ report }: { report: RuntimeUsageReport }) => (
    <RuntimeSection
        title="LLM by agent"
        description="Tokens and their price per agent, read from the same usage records as the LLM tokens tab. A prompt above a model's tier threshold is priced at that tier.">
        {report.llm.source === "not_measured" ? (
            <p className="text-text-secondary text-sm">
                {NOT_MEASURED}: token usage is not readable on this deployment.
            </p>
        ) : !report.llm.byAgent.length ? (
            <p className="text-text-secondary text-sm">
                No LLM call this month.
            </p>
        ) : (
            <TableContainer>
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead>Agent</TableHead>
                            <TableHead>Tokens</TableHead>
                            <TableHead>Above a tier threshold</TableHead>
                            <TableHead>Cost</TableHead>
                            <TableHead>On your own keys</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {report.llm.byAgent.map((a) => (
                            <TableRow key={a.agent}>
                                <TableCell className="font-medium">
                                    {agentLabel(a.agent)}
                                </TableCell>
                                <TableCell className="font-mono text-xs">
                                    {formatTokens(a.totalTokens)}
                                </TableCell>
                                <TableCell className="font-mono text-xs">
                                    {formatTokens(a.aboveBaseTierTokens)}
                                </TableCell>
                                <TableCell className="font-mono text-xs">
                                    {a.usd !== null
                                        ? formatUsageUsd(a.usd)
                                        : `≥ ${formatUsageUsd(a.pricedUsd)}`}
                                </TableCell>
                                <TableCell className="font-mono text-xs">
                                    {formatUsageUsd(a.customerUsd)}
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </TableContainer>
        )}
    </RuntimeSection>
);

const MachineTime = ({ report }: { report: RuntimeUsageReport }) => (
    <RuntimeSection
        title="Machine time"
        description="Memory and vCPU held by your machines, by what they served. Build time is from asking for a machine until it was ready.">
        {!report.machine.byConsumer.length ? (
            <p className="text-text-secondary text-sm">
                No machine ran this month.
            </p>
        ) : (
            <TableContainer>
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead>For</TableHead>
                            <TableHead>Machines</TableHead>
                            <TableHead>Memory</TableHead>
                            <TableHead>vCPU</TableHead>
                            <TableHead>Build time</TableHead>
                            <TableHead>Estimate</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {report.machine.byConsumer.map((g) => (
                            <TableRow key={`${g.consumer}-${g.side}`}>
                                <TableCell className="font-medium">
                                    {consumerLabel(g.consumer, g.side)}
                                </TableCell>
                                <TableCell className="font-mono text-xs">
                                    {g.claims}
                                </TableCell>
                                <TableCell className="font-mono text-xs">
                                    {formatUnitMinutes(g.gbMinutes, "GB·min")}
                                </TableCell>
                                <TableCell className="font-mono text-xs">
                                    {formatUnitMinutes(
                                        g.vcpuMinutes,
                                        "vCPU·min",
                                    )}
                                </TableCell>
                                <TableCell className="font-mono text-xs">
                                    {formatUsageMinutes(g.buildMinutes)}
                                </TableCell>
                                <TableCell className="font-mono text-xs">
                                    {formatUsageUsd(g.hostUsd)}
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </TableContainer>
        )}
    </RuntimeSection>
);

const RunsTable = ({ report }: { report: RuntimeUsageReport }) => (
    <RuntimeSection
        title="Runs"
        description={
            report.counts.runsListed < report.counts.runs
                ? `The latest ${report.counts.runsListed} of ${report.counts.runs} Runs this month. The export has the same rows.`
                : "Every Run this month, newest first. Each cost is the one its Run page shows."
        }>
        {!report.runs.length ? (
            <RuntimeEmptyState title="No Runs this month">
                A Run starts when a pull request matches a repository&apos;s
                rules, or when someone comments{" "}
                <code className="font-mono">@kody runtime</code> on it.
            </RuntimeEmptyState>
        ) : (
            <TableContainer>
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead>Run</TableHead>
                            <TableHead>Started by</TableHead>
                            <TableHead>Verdict</TableHead>
                            <TableHead>Wall time</TableHead>
                            <TableHead>Boot</TableHead>
                            <TableHead>Machines from</TableHead>
                            <TableHead>Memory</TableHead>
                            <TableHead>vCPU</TableHead>
                            <TableHead>Machines</TableHead>
                            <TableHead>LLM</TableHead>
                            <TableHead>Total</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {report.runs.map((run) => (
                            <TableRow key={run.runId}>
                                <TableCell>
                                    <NextLink
                                        href={`/runtime/runs/${encodeURIComponent(run.runId)}`}
                                        className="flex flex-col hover:underline">
                                        <span className="font-medium">
                                            {run.repositoryName ??
                                                run.repositoryId ??
                                                "—"}
                                            {run.prNumber
                                                ? ` #${run.prNumber}`
                                                : ""}
                                        </span>
                                        <span className="text-text-tertiary text-xs">
                                            {new Date(
                                                run.requestedAt,
                                            ).toLocaleString()}
                                        </span>
                                    </NextLink>
                                </TableCell>
                                <TableCell className="text-sm">
                                    {triggerLabel(run.trigger)}
                                </TableCell>
                                <TableCell>
                                    <StatusChip tone={runStateTone(run.state)}>
                                        {runStateLabel(run.state)}
                                    </StatusChip>
                                </TableCell>
                                <TableCell className="font-mono text-xs">
                                    {run.wallMinutes === null
                                        ? "Running"
                                        : formatUsageMinutes(run.wallMinutes)}
                                </TableCell>
                                <TableCell className="text-xs">
                                    {bootLine(run)}
                                </TableCell>
                                <TableCell
                                    className={
                                        run.start
                                            ? "text-xs"
                                            : "text-text-tertiary text-xs"
                                    }>
                                    {startLabel(run.start)}
                                </TableCell>
                                <TableCell className="font-mono text-xs">
                                    {formatUnitMinutes(
                                        run.machine.gbMinutes,
                                        "GB·min",
                                    )}
                                </TableCell>
                                <TableCell className="font-mono text-xs">
                                    {formatUnitMinutes(
                                        run.machine.vcpuMinutes,
                                        "vCPU·min",
                                    )}
                                </TableCell>
                                <TableCell className="font-mono text-xs">
                                    {run.machine.paidBy === "customer"
                                        ? "Your host"
                                        : formatUsageUsd(run.machine.usd)}
                                </TableCell>
                                <TableCell className="font-mono text-xs">
                                    {run.llm.source === "not_measured"
                                        ? NOT_MEASURED
                                        : formatUsageUsd(run.llm.usd)}
                                </TableCell>
                                <TableCell className="font-mono text-xs">
                                    {formatUsageUsd(run.totalUsd)}
                                    {run.complete ? "" : "*"}
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </TableContainer>
        )}
        <p className="text-text-tertiary text-xs">
            * Partial: a part of this Run could not be priced.
        </p>
    </RuntimeSection>
);

/**
 * A month of Kody Runtime usage: summary, LLM by agent, machine time and Runs,
 * with its filters and CSV export. It is the Runtime tab of the Usage screen.
 */
export const RuntimeUsageContent = () => {
    // GET /runtime/settings/usage is the org owner's (checkRole OWNER), the same people as Manage on RuntimeEnvironment.
    const isOwner = usePermission(
        Action.Manage,
        ResourceType.RuntimeEnvironment,
    );
    const months = usageMonthOptions();
    const [month, setMonth] = useState(months[0].value);
    const [repositoryId, setRepositoryId] = useState<string>(ALL);
    const [environmentId, setEnvironmentId] = useState<string>(ALL);
    const settings = useRuntimeSettings(isOwner);
    const environments = useRuntimeEnvironments();
    const query: RuntimeUsageQuery = {
        month,
        ...(repositoryId !== ALL ? { repositoryId } : {}),
        ...(environmentId !== ALL ? { environmentId } : {}),
    };
    const report = useRuntimeUsageReport(query, isOwner);

    return (
        <div className="flex flex-col gap-6">
            {!isOwner ? (
                <RuntimeEmptyState title="Usage is for the organization's owner">
                    Ask the owner of your organization for the Kody Runtime
                    usage report.
                </RuntimeEmptyState>
            ) : (
                <>
                    <div className="flex flex-wrap items-center gap-3">
                        <Select value={month} onValueChange={setMonth}>
                            <SelectTrigger className="w-48" aria-label="Month">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {months.map((m) => (
                                    <SelectItem key={m.value} value={m.value}>
                                        {m.label}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        <Select
                            value={repositoryId}
                            onValueChange={setRepositoryId}>
                            <SelectTrigger
                                className="w-64"
                                aria-label="Repository">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value={ALL}>
                                    All repositories
                                </SelectItem>
                                {(settings.data?.repositories ?? []).map(
                                    (r) => (
                                        <SelectItem
                                            key={r.repositoryId}
                                            value={r.repositoryId}>
                                            {r.repositoryName ?? r.repositoryId}
                                        </SelectItem>
                                    ),
                                )}
                            </SelectContent>
                        </Select>
                        <Select
                            value={environmentId}
                            onValueChange={setEnvironmentId}>
                            <SelectTrigger
                                className="w-64"
                                aria-label="Environment">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value={ALL}>
                                    All environments
                                </SelectItem>
                                {(environments.data ?? []).map((e) => (
                                    <SelectItem
                                        key={e.environmentId}
                                        value={e.environmentId}>
                                        {e.repositoryName ?? e.environmentId}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        <div className="ml-auto">
                            <ExportButton query={query} />
                        </div>
                    </div>
                    {report.isLoading ? (
                        <Skeleton className="h-64 w-full" />
                    ) : report.isError || !report.data ? (
                        <RuntimeErrorState
                            what="the usage report"
                            error={report.error}
                            onRetry={() => report.refetch()}
                        />
                    ) : (
                        <>
                            <RuntimeCostBlock report={report.data} />
                            <Summary report={report.data} />
                            <LlmByAgent report={report.data} />
                            <MachineTime report={report.data} />
                            <RunsTable report={report.data} />
                        </>
                    )}
                </>
            )}
        </div>
    );
};
