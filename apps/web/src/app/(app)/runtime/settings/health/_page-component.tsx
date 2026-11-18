"use client";

import { useState } from "react";
import NextLink from "next/link";
import {
    RuntimeEmptyState,
    RuntimeErrorState,
} from "@components/runtime/empty-state";
import { RelativeTime } from "@components/runtime/relative-time";
import { RuntimeHeader } from "@components/runtime/runtime-header";
import { Metric, RuntimeSection } from "@components/runtime/section";
import { StatusChip } from "@components/runtime/status-chip";
import { Button } from "@components/ui/button";
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
import type {
    RuntimeHealth,
    RuntimeSpeed,
    SpeedMetrics,
    SpeedStat,
    SpeedWindowDays,
} from "@services/runtime/contracts";
import {
    blockerHref,
    costTodayLine,
    HEALTH_NOT_MEASURED,
    healthSummaryTiles,
    stuckHref,
    stuckLine,
    stuckTone,
} from "@services/runtime/model/health";
import { speedTakeaway, speedValue } from "@services/runtime/model/speed";
import { formatUsageUsd } from "@services/runtime/model/usage-report";
import { useRuntimeHealth, useRuntimeSpeed } from "@services/runtime/queries";
import { ArrowLeftIcon, BarChart3Icon } from "lucide-react";

const NotMeasured = ({ reason }: { reason: string }) => (
    <p className="text-text-secondary text-sm">
        {HEALTH_NOT_MEASURED}: {reason}
    </p>
);

const Summary = ({ health }: { health: RuntimeHealth }) => {
    const cost = costTodayLine(health, (v) => formatUsageUsd(v));
    return (
        <RuntimeSection
            title="At a glance"
            description="Your environments, the Runs of the last 7 days and how long their machines took to start, what is stuck right now, and what Kody Runtime cost you today (UTC).">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
                {healthSummaryTiles(health).map((tile) => (
                    <Metric
                        key={tile.label}
                        label={tile.label}
                        value={tile.value}
                        hint={tile.hint}
                    />
                ))}
                <Metric
                    label="Cost today"
                    value={cost.value}
                    hint={
                        <>
                            {cost.hint} ·{" "}
                            <NextLink
                                href={health.cost.usagePath}
                                className="underline">
                                usage
                            </NextLink>
                        </>
                    }
                />
            </div>
        </RuntimeSection>
    );
};

const SPEED_ROWS: Array<{
    label: string;
    of: (s: RuntimeSpeed) => SpeedMetrics;
}> = [
    { label: "Warm pool", of: (s) => s.bySource.warm_pool },
    { label: "Cold boot", of: (s) => s.bySource.cold_boot },
    { label: "Baked image", of: (s) => s.bySource.baked },
    { label: "Source not reported", of: (s) => s.bySource.unknown },
    { label: "Kodus cloud", of: (s) => s.byHost.kodus_cloud },
    { label: "Your own host", of: (s) => s.byHost.own_host },
];

const SpeedCell = ({ stat }: { stat: SpeedStat }) => (
    <TableCell className="font-mono text-xs">
        {stat.tooFew ? (
            <span className="text-text-tertiary">too few Runs</span>
        ) : (
            <>
                {speedValue(stat, "p50Ms")}
                <span className="text-text-tertiary">
                    {" "}
                    / {speedValue(stat, "p95Ms")}
                </span>
            </>
        )}
    </TableCell>
);

const speedTile = (label: string, stat: SpeedStat, minRuns: number) => (
    <Metric
        label={label}
        value={speedValue(stat, "p50Ms")}
        hint={
            stat.tooFew
                ? `${stat.n} Runs, ${minRuns - Math.min(stat.n, minRuns)} short of a number`
                : `p95 ${speedValue(stat, "p95Ms")} · ${stat.n} Runs`
        }
    />
);

const SpeedBody = ({ speed }: { speed: RuntimeSpeed }) => {
    const ex = speed.excluded;
    const left =
        ex.cancelledOrSuperseded + ex.skipped + ex.unfinished + ex.noVerdict;
    const rows = SPEED_ROWS.filter(
        (r) =>
            r.of(speed).verdict.n > 0 ||
            r.label === "Warm pool" ||
            r.label === "Cold boot",
    );
    return (
        <div className="flex flex-col gap-3">
            <p className="text-text-primary text-sm">{speedTakeaway(speed)}</p>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                {speedTile(
                    "Request to verdict, p50",
                    speed.all.verdict,
                    speed.minRuns,
                )}
                {speedTile(
                    "Request to both sides ready, p50",
                    speed.all.ready,
                    speed.minRuns,
                )}
                {speedTile("Queue wait, p50", speed.all.queue, speed.minRuns)}
            </div>
            <TableContainer>
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead>Machines</TableHead>
                            <TableHead>To verdict p50 / p95</TableHead>
                            <TableHead>To ready p50 / p95</TableHead>
                            <TableHead>Queue p50 / p95</TableHead>
                            <TableHead>Runs</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {rows.map((r) => {
                            const m = r.of(speed);
                            return (
                                <TableRow key={r.label}>
                                    <TableCell className="text-sm">
                                        {r.label}
                                    </TableCell>
                                    <SpeedCell stat={m.verdict} />
                                    <SpeedCell stat={m.ready} />
                                    <SpeedCell stat={m.queue} />
                                    <TableCell className="font-mono text-xs">
                                        {m.verdict.n}
                                    </TableCell>
                                </TableRow>
                            );
                        })}
                    </TableBody>
                </Table>
            </TableContainer>
            <p className="text-text-tertiary text-xs">
                {speed.counted} of {speed.considered} Runs reached a verdict and
                are counted. Left out: {left} ({ex.cancelledOrSuperseded}{" "}
                cancelled or superseded, {ex.skipped} skipped, {ex.unfinished}{" "}
                not finished, {ex.noVerdict} errored, timed out or halted).
                Missing a timestamp: {speed.missing.verdict} to verdict,{" "}
                {speed.missing.ready} to ready, {speed.missing.queue} queue. A
                number needs {speed.minRuns} Runs; percentiles are nearest-rank.
                {speed.truncated
                    ? " Only the newest 10,000 Runs of the window are read."
                    : ""}
            </p>
        </div>
    );
};

const Speed = () => {
    const [windowDays, setWindowDays] = useState<SpeedWindowDays>(7);
    const speed = useRuntimeSpeed(windowDays);
    return (
        <RuntimeSection
            title="Speed"
            description="How long Runs take from the pull request event: to a verdict, to both sides ready (each side ran its first probe), and waiting in the queue. Half the Runs are under p50, 95 in 100 under p95."
            aside={
                <div className="flex gap-1" role="group" aria-label="Window">
                    {([7, 30] as const).map((d) => (
                        <Button
                            key={d}
                            size="xs"
                            variant={d === windowDays ? "secondary" : "helper"}
                            aria-pressed={d === windowDays}
                            onClick={() => setWindowDays(d)}>
                            {d} days
                        </Button>
                    ))}
                </div>
            }>
            {speed.isLoading ? (
                <Skeleton className="h-40 w-full" />
            ) : speed.isError || !speed.data ? (
                <RuntimeErrorState
                    what="the speed of your Runs"
                    error={speed.error}
                    onRetry={() => speed.refetch()}
                />
            ) : (
                <SpeedBody speed={speed.data} />
            )}
        </RuntimeSection>
    );
};

const Stuck = ({ health }: { health: RuntimeHealth }) => (
    <RuntimeSection
        title="Stuck"
        description="Runs, setups and machines past the longest their current step should take. Nothing here was stopped: open each to see where it is, or stop it from its page.">
        {!health.stuck.measured ? (
            <NotMeasured reason={health.stuck.reason} />
        ) : !health.stuck.items.length ? (
            <p className="text-text-secondary text-sm">
                Nothing is past its time limit.
            </p>
        ) : (
            <ul className="flex flex-col gap-2">
                {health.stuck.items.map((item) => {
                    const href = stuckHref(item);
                    return (
                        <li
                            key={`${item.subject}:${item.state}:${item.runId ?? item.claimId ?? item.cellId ?? item.environmentId}`}
                            className="bg-card-lv2 flex flex-wrap items-center justify-between gap-3 rounded-lg px-4 py-3">
                            <div className="flex items-center gap-3">
                                <StatusChip tone={stuckTone(item)}>
                                    Stuck
                                </StatusChip>
                                <span className="text-sm">
                                    {stuckLine(item)}
                                </span>
                            </div>
                            {href && (
                                <NextLink
                                    href={href}
                                    className="text-text-secondary text-sm hover:underline">
                                    Open
                                </NextLink>
                            )}
                        </li>
                    );
                })}
            </ul>
        )}
        {health.stuck.measured && health.stuck.notChecked.length > 0 && (
            <p className="text-text-tertiary text-xs">
                Not checked on this screen:{" "}
                {health.stuck.notChecked.join(" and ")}. Kody Runtime's own
                monitor watches them.
            </p>
        )}
    </RuntimeSection>
);

const Errors = ({ health }: { health: RuntimeHealth }) => (
    <RuntimeSection
        title="What stopped setups and Runs"
        description="The last 7 days, grouped by cause. Each one opens the card that explains it and how to fix it.">
        {!health.errors.measured ? (
            <NotMeasured reason={health.errors.reason} />
        ) : !health.errors.bySignature.length ? (
            <p className="text-text-secondary text-sm">
                Nothing stopped a setup or a Run in the last 7 days.
            </p>
        ) : (
            <TableContainer>
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead>Cause</TableHead>
                            <TableHead>Times</TableHead>
                            <TableHead>Last seen</TableHead>
                            <TableHead />
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {health.errors.bySignature.map((e) => {
                            const href = blockerHref(e);
                            return (
                                <TableRow key={e.signature}>
                                    <TableCell>
                                        <div className="flex flex-col">
                                            <span className="font-medium">
                                                {e.title}
                                            </span>
                                            <span className="text-text-tertiary font-mono text-xs">
                                                {e.signature}
                                            </span>
                                        </div>
                                    </TableCell>
                                    <TableCell className="font-mono text-xs">
                                        {e.count}
                                    </TableCell>
                                    <TableCell className="text-xs">
                                        <RelativeTime at={e.lastAt} />
                                    </TableCell>
                                    <TableCell>
                                        {href && (
                                            <NextLink
                                                href={href}
                                                className="text-text-secondary text-sm hover:underline">
                                                See the fix
                                            </NextLink>
                                        )}
                                    </TableCell>
                                </TableRow>
                            );
                        })}
                    </TableBody>
                </Table>
            </TableContainer>
        )}
    </RuntimeSection>
);

const Cells = ({ health }: { health: RuntimeHealth }) => (
    <RuntimeSection
        title="Your hosts"
        description="Hosts your organization runs itself: whether they are connected, how many more Runs they can take, and what isolates their machines.">
        {!health.cells.measured ? (
            <NotMeasured reason={health.cells.reason} />
        ) : !health.cells.items.length ? (
            <p className="text-text-secondary text-sm">
                Your Runs use Kodus cloud hosts. Kodus watches their health.
            </p>
        ) : (
            <>
                <TableContainer>
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>Host</TableHead>
                                <TableHead>Status</TableHead>
                                <TableHead>Room for</TableHead>
                                <TableHead>Largest machine</TableHead>
                                <TableHead>Isolation</TableHead>
                                <TableHead>Last heard from</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {health.cells.items.map((c) => (
                                <TableRow key={c.cellId}>
                                    <TableCell className="font-mono text-xs">
                                        {c.cellId}
                                    </TableCell>
                                    <TableCell>
                                        <StatusChip
                                            tone={
                                                c.connected
                                                    ? "success"
                                                    : "neutral"
                                            }>
                                            {c.connected
                                                ? "Connected"
                                                : "Not connected"}
                                        </StatusChip>
                                    </TableCell>
                                    <TableCell className="font-mono text-xs">
                                        {c.freeSlots === null
                                            ? HEALTH_NOT_MEASURED
                                            : `${c.freeSlots} more ${c.freeSlots === 1 ? "machine" : "machines"}`}
                                    </TableCell>
                                    <TableCell className="font-mono text-xs">
                                        {c.maxClaimMemoryMb === null
                                            ? HEALTH_NOT_MEASURED
                                            : `${Math.round(c.maxClaimMemoryMb / 1024)} GB · ${c.maxClaimCpus ?? "?"} vCPU`}
                                    </TableCell>
                                    <TableCell className="text-xs">
                                        {c.isolation ?? HEALTH_NOT_MEASURED}
                                        {c.driver ? ` (${c.driver})` : ""}
                                    </TableCell>
                                    <TableCell className="text-xs">
                                        {c.lastHeartbeatAt ? (
                                            <RelativeTime
                                                at={c.lastHeartbeatAt}
                                            />
                                        ) : (
                                            HEALTH_NOT_MEASURED
                                        )}
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </TableContainer>
                <p className="text-text-tertiary text-xs">
                    Warm machines ready: {HEALTH_NOT_MEASURED}.{" "}
                    {health.cells.pool.reason}
                </p>
            </>
        )}
    </RuntimeSection>
);

export const RuntimeHealthPage = () => {
    // GET /runtime/settings/health is the org owner's (checkRole OWNER), the same people as Manage on RuntimeEnvironment.
    const isOwner = usePermission(
        Action.Manage,
        ResourceType.RuntimeEnvironment,
    );
    const health = useRuntimeHealth(isOwner);

    return (
        <Page.Root>
            <RuntimeHeader
                actions={
                    isOwner ? (
                        <NextLink href="/runtime/settings/usage">
                            <Button
                                size="md"
                                variant="secondary"
                                decorative
                                leftIcon={<BarChart3Icon />}>
                                Open usage
                            </Button>
                        </NextLink>
                    ) : undefined
                }
            />
            <Page.Content>
                <NextLink
                    href="/runtime/settings"
                    className="text-text-secondary flex w-fit items-center gap-1 text-sm hover:underline">
                    <ArrowLeftIcon className="size-4" /> Settings
                </NextLink>
                {!isOwner ? (
                    <RuntimeEmptyState title="Health is for the organization's owner">
                        Ask the owner of your organization how Kody Runtime is
                        doing.
                    </RuntimeEmptyState>
                ) : health.isLoading ? (
                    <Skeleton className="h-64 w-full" />
                ) : health.isError || !health.data ? (
                    <RuntimeErrorState
                        what="the health of Kody Runtime"
                        error={health.error}
                        onRetry={() => health.refetch()}
                    />
                ) : (
                    <>
                        <Summary health={health.data} />
                        <Speed />
                        <Stuck health={health.data} />
                        <Errors health={health.data} />
                        <Cells health={health.data} />
                    </>
                )}
            </Page.Content>
        </Page.Root>
    );
};
