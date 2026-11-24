"use client";

import { Fragment, useState, type ReactNode } from "react";
import { RuntimeDisclosure } from "@components/runtime/disclosure";
import { MintedEvidenceLink } from "@components/runtime/evidence-link";
import { Metric } from "@components/runtime/section";
import { StatusChip, TONE_TEXT_CLASS } from "@components/runtime/status-chip";
import { Button } from "@components/ui/button";
import { Heading } from "@components/ui/heading";
import { Input } from "@components/ui/input";
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
import { usePermissionOnEvery } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import { getRunSuiteArtifactUrl } from "@services/runtime/api";
import type {
    RuntimeRun,
    RuntimeSuiteFailure,
    RuntimeSuiteRun,
    RuntimeSuiteSpec,
} from "@services/runtime/contracts";
import { formatDurationMs, shortSha } from "@services/runtime/format";
import type { Tone } from "@services/runtime/labels";
import { repositoryIdsOfRun } from "@services/runtime/model/environment-repositories";
import { runtimeErrorMessage } from "@services/runtime/model/errors";
import {
    artifactLabel,
    attemptsLine,
    failureGroups,
    mainLine,
    specCounts,
    specResultLabel,
    specRows,
    suiteFacts,
    suiteTimeSplit,
    suiteVerdict,
    whySpecs,
    type SpecFilter,
    type TimeSegment,
} from "@services/runtime/model/suite";
import { useRetryRunSuite } from "@services/runtime/queries";
import {
    CircleAlertIcon,
    CircleCheckIcon,
    LoaderCircleIcon,
    RotateCcwIcon,
    TriangleAlertIcon,
} from "lucide-react";
import { cn } from "src/core/utils/components";

// The Run page's "e2e suite" tab (docs/runtime/e2e-suites.md section 13): the verdict first, four facts, the failed tests by whose fault they
// are, then the details. The words come from services/runtime/model/suite.ts; the API sends fields.

const PANEL: Record<Tone, string> = {
    danger: "border-danger/30 bg-danger/10",
    warning: "border-warning/30 bg-warning/10",
    success: "border-success/30 bg-success/10",
    info: "border-info/30 bg-info/10",
    alert: "border-alert/30 bg-alert/10",
    neutral: "border-card-lv3 bg-card-lv2",
};

const ICON: Record<Tone, ReactNode> = {
    danger: <CircleAlertIcon aria-hidden className="size-6 shrink-0" />,
    warning: <TriangleAlertIcon aria-hidden className="size-6 shrink-0" />,
    success: <CircleCheckIcon aria-hidden className="size-6 shrink-0" />,
    info: <LoaderCircleIcon aria-hidden className="size-6 shrink-0" />,
    alert: <TriangleAlertIcon aria-hidden className="size-6 shrink-0" />,
    neutral: <CircleAlertIcon aria-hidden className="size-6 shrink-0" />,
};

/** "Re-run failed": the specs that did not pass, run again as a suite run of their own. Only for who may run the Run again. */
const RetryFailedButton = ({ run }: { run: RuntimeRun }) => {
    const retry = useRetryRunSuite();
    return (
        <Button
            size="md"
            variant="secondary"
            leftIcon={<RotateCcwIcon />}
            loading={retry.isPending}
            onClick={() =>
                retry.mutate(run.runId, {
                    onSuccess: () =>
                        toast({
                            variant: "success",
                            title: "Re-run queued",
                            description:
                                "The failed specs run again. The result is posted to the Kody Runtime e2e check on the pull request.",
                        }),
                    onError: (error) =>
                        toast({
                            variant: "danger",
                            title: "Couldn't re-run the failed specs",
                            description: runtimeErrorMessage(error, {
                                fallback: "Try again in a moment.",
                                403: "Only people allowed to ask @kody runtime on this repository can run it again.",
                                409: "The suite is still running, or nothing is left to run again.",
                            }),
                        }),
                })
            }>
            Re-run failed
        </Button>
    );
};

const ArtifactLinks = ({
    runId,
    failure,
}: {
    runId: string;
    failure: RuntimeSuiteFailure;
}) =>
    failure.artifacts.length > 0 ? (
        <div className="flex flex-wrap gap-x-4 gap-y-1">
            {failure.artifacts.map((a) => (
                <MintedEvidenceLink
                    key={a.name}
                    what={{ runId, spec: failure.spec, name: a.name }}
                    mint={() =>
                        getRunSuiteArtifactUrl({
                            runId,
                            spec: failure.spec,
                            name: a.name,
                        })
                    }>
                    {artifactLabel(a.name)}
                </MintedEvidenceLink>
            ))}
        </div>
    ) : null;

const FailureItem = ({
    runId,
    failure,
    label,
    tone,
    open,
}: {
    runId: string;
    failure: RuntimeSuiteFailure;
    label: string;
    tone: Tone;
    open: boolean;
}) => (
    <details
        open={open}
        className={cn(
            "group/failure bg-card-lv1 rounded-xl border",
            tone === "danger" ? "border-danger/30" : "border-card-lv3",
        )}>
        <summary className="focus-visible:ring-ring flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 rounded-xl px-4 py-3 hover:brightness-120 focus-visible:ring-3 focus-visible:outline-none [&::-webkit-details-marker]:hidden">
            <StatusChip tone={tone}>{label}</StatusChip>
            <span className="text-text-primary text-sm font-semibold">
                {failure.title || "The spec did not report"}
            </span>
            <span className="text-text-tertiary font-mono text-xs">
                {failure.spec}
            </span>
        </summary>
        <div className="flex flex-col gap-3 px-4 pb-4">
            {failure.error && (
                <pre className="bg-card-lv2 text-text-primary overflow-x-auto rounded-lg px-3 py-2 font-mono text-xs break-words whitespace-pre-wrap">
                    {failure.error}
                </pre>
            )}
            <dl className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
                <div>
                    <span className="text-text-tertiary">This PR</span> ·{" "}
                    {attemptsLine(failure.pr)}
                </div>
                <div>
                    <span className="text-text-tertiary">
                        {failure.main
                            ? `main ${shortSha(failure.main.sha)}`
                            : "main"}
                    </span>{" "}
                    · {mainLine(failure)}
                </div>
                {failure.reachedBy.length > 0 && (
                    <div>
                        <span className="text-text-tertiary">Reached by</span> ·{" "}
                        <span className="font-mono text-xs">
                            {failure.reachedBy.join(", ")}
                        </span>
                    </div>
                )}
            </dl>
            <ArtifactLinks runId={runId} failure={failure} />
        </div>
    </details>
);

const SEGMENT_CLASS: Record<TimeSegment["key"], string> = {
    start: "bg-card-lv3",
    list: "bg-info/50",
    boot: "bg-info",
    setup: "bg-warning",
    specs: "bg-success",
    results: "bg-alert",
    rest: "bg-card-lv3",
};

/** Where the run's wall time went: one bar along the host that finished last, then each host's own boot, app and specs. */
const TimeSplit = ({ suite }: { suite: RuntimeSuiteRun }) => {
    const split = suiteTimeSplit(suite);
    if (!split) return null;
    const specsMs = split.segments.find((s) => s.key === "specs")?.ms;
    return (
        <section
            aria-label="Where the time went"
            className="bg-card-lv1 flex flex-col gap-3 rounded-xl px-6 py-5">
            <div className="flex flex-wrap items-baseline gap-x-2">
                <Heading variant="h2" className="text-base">
                    Where the {formatDurationMs(split.totalMs)} went
                </Heading>
                {specsMs !== undefined && (
                    <span className="text-text-secondary text-sm">
                        · the specs themselves took {formatDurationMs(specsMs)}
                    </span>
                )}
            </div>
            <div
                role="img"
                aria-label={split.segments
                    .map((s) => `${s.label} ${formatDurationMs(s.ms)}`)
                    .join(", ")}
                className="bg-card-lv2 flex h-3 overflow-hidden rounded-full">
                {split.segments.map((s) => (
                    <div
                        key={s.key}
                        title={`${s.label} · ${formatDurationMs(s.ms)}`}
                        className={SEGMENT_CLASS[s.key]}
                        style={{ width: `${(s.ms / split.totalMs) * 100}%` }}
                    />
                ))}
            </div>
            <ul className="text-text-secondary flex flex-wrap gap-x-5 gap-y-1 text-xs">
                {split.segments.map((s) => (
                    <li key={s.key} className="flex items-center gap-1.5">
                        <span
                            aria-hidden
                            className={cn(
                                "size-2.5 rounded-sm",
                                SEGMENT_CLASS[s.key],
                            )}
                        />
                        {s.label}{" "}
                        <span className="text-text-primary tabular-nums">
                            {formatDurationMs(s.ms)}
                        </span>
                    </li>
                ))}
            </ul>
            <ul className="text-text-secondary flex flex-col gap-1 text-sm">
                {split.hosts.map((h) => (
                    <li key={h.label} className="tabular-nums">
                        <span className="text-text-primary font-medium">
                            {h.label}
                        </span>{" "}
                        · {h.specs === 1 ? "1 spec" : `${h.specs} specs`}
                        {h.bootMs !== undefined && (
                            <> · boot {formatDurationMs(h.bootMs)}</>
                        )}
                        {h.setupMs !== undefined && (
                            <> · app up {formatDurationMs(h.setupMs)}</>
                        )}
                        {h.specsMs !== undefined && (
                            <> · specs {formatDurationMs(h.specsMs)}</>
                        )}
                    </li>
                ))}
            </ul>
            {!split.complete && (
                <p className="text-text-tertiary text-xs">
                    This run did not record when its specs started, so the last
                    part covers the app, the specs and the results together.
                </p>
            )}
        </section>
    );
};

const ATTEMPT_CLASS: Record<string, string> = {
    passed: "bg-success",
    failed: "bg-danger",
    skipped: "bg-card-lv3",
};

const Attempts = ({ attempts }: { attempts: readonly string[] }) => (
    <span
        className="inline-flex gap-0.5 align-middle"
        aria-label={`Tries: ${attempts.join(", ")}`}>
        {attempts.map((a, i) => (
            <span
                key={i}
                title={a}
                className={cn(
                    "size-2.5 rounded-[3px]",
                    ATTEMPT_CLASS[a] ?? "bg-card-lv3",
                )}
            />
        ))}
    </span>
);

/** The tries of a spec as one strip: its test with the most tries (a retried test is the one worth seeing). */
const triesOf = (r: RuntimeSuiteSpec) =>
    r.tests.reduce<string[]>(
        (most, t) => (t.attempts.length > most.length ? t.attempts : most),
        [],
    );

const FILTERS: Array<{ value: SpecFilter; label: string }> = [
    { value: "all", label: "All" },
    { value: "failed", label: "Failed" },
    { value: "flaky", label: "Flaky" },
    { value: "passed", label: "Passed" },
    { value: "skipped", label: "Skipped" },
];

/** Every spec of the first pass: filter, search, and open one for its tests, tries and files. */
const SpecsTable = ({
    run,
    suite,
}: {
    run: RuntimeRun;
    suite: RuntimeSuiteRun;
}) => {
    const counts = specCounts(suite);
    const [filter, setFilter] = useState<SpecFilter>("all");
    const [query, setQuery] = useState("");
    const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
    if (counts.all === 0) return null;
    const rows = specRows(suite, filter, query);
    const longest = Math.max(1, ...suite.specRows.map((r) => r.durationMs));
    const toggle = (spec: string) =>
        setOpen((prev) => {
            const next = new Set(prev);
            if (next.has(spec)) next.delete(spec);
            else next.add(spec);
            return next;
        });
    return (
        <section aria-label="Specs" className="flex flex-col gap-3">
            <Heading variant="h2" className="text-base">
                Specs
            </Heading>
            <div className="flex flex-wrap items-center gap-2">
                <div
                    role="group"
                    aria-label="Show"
                    className="flex flex-wrap gap-1.5">
                    {FILTERS.filter(
                        (f) => f.value === "all" || counts[f.value] > 0,
                    ).map((f) => (
                        <Button
                            key={f.value}
                            size="xs"
                            variant={
                                filter === f.value ? "primary" : "secondary"
                            }
                            aria-pressed={filter === f.value}
                            onClick={() => setFilter(f.value)}>
                            {f.label} {counts[f.value]}
                        </Button>
                    ))}
                </div>
                <Input
                    type="search"
                    aria-label="Search a spec or a test"
                    placeholder="Search a spec or a test"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    className="min-w-0 flex-1 basis-56"
                />
            </div>
            <TableContainer>
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead>Spec</TableHead>
                            <TableHead>Result</TableHead>
                            <TableHead>Tries</TableHead>
                            <TableHead>Host</TableHead>
                            <TableHead className="text-right">Time</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {rows.length === 0 && (
                            <TableRow>
                                <TableCell
                                    colSpan={5}
                                    className="text-text-secondary">
                                    No spec matches.
                                </TableCell>
                            </TableRow>
                        )}
                        {rows.map((r) => {
                            const result = specResultLabel(r);
                            const isOpen = open.has(r.spec);
                            return (
                                <Fragment key={r.spec}>
                                    <TableRow
                                        tabIndex={0}
                                        aria-expanded={isOpen}
                                        className="cursor-pointer"
                                        onClick={() => toggle(r.spec)}
                                        onKeyDown={(e) => {
                                            if (
                                                e.key === "Enter" ||
                                                e.key === " "
                                            ) {
                                                e.preventDefault();
                                                toggle(r.spec);
                                            }
                                        }}>
                                        <TableCell className="font-mono text-xs break-all">
                                            {r.spec}
                                        </TableCell>
                                        <TableCell>
                                            <StatusChip tone={result.tone}>
                                                {result.label}
                                            </StatusChip>
                                        </TableCell>
                                        <TableCell>
                                            <Attempts attempts={triesOf(r)} />
                                        </TableCell>
                                        <TableCell className="tabular-nums">
                                            {r.shard + 1}
                                        </TableCell>
                                        <TableCell className="text-right font-mono text-xs whitespace-nowrap tabular-nums">
                                            <span
                                                aria-hidden
                                                className="bg-info/60 mr-2 inline-block h-1.5 rounded-full align-middle"
                                                style={{
                                                    width: `${Math.max(4, (r.durationMs / longest) * 64)}px`,
                                                }}
                                            />
                                            {formatDurationMs(r.durationMs)}
                                        </TableCell>
                                    </TableRow>
                                    {isOpen && (
                                        <TableRow className="bg-card-lv2 hover:bg-card-lv2">
                                            <TableCell colSpan={5}>
                                                <div className="flex flex-col gap-2 py-1">
                                                    {r.tests.length === 0 && (
                                                        <span className="text-text-secondary text-sm">
                                                            The runner reported
                                                            no test for this
                                                            spec.
                                                        </span>
                                                    )}
                                                    {r.tests.map((t) => (
                                                        <div
                                                            key={t.title}
                                                            className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                                                            <Attempts
                                                                attempts={
                                                                    t.attempts
                                                                }
                                                            />
                                                            <span className="text-text-primary">
                                                                {t.title}
                                                            </span>
                                                            {t.attempts.length >
                                                                1 && (
                                                                <span className="text-text-tertiary text-xs">
                                                                    {
                                                                        t
                                                                            .attempts
                                                                            .length
                                                                    }{" "}
                                                                    tries
                                                                </span>
                                                            )}
                                                        </div>
                                                    ))}
                                                    {r.artifacts.length > 0 && (
                                                        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                                                            {r.artifacts.map(
                                                                (name) => (
                                                                    <MintedEvidenceLink
                                                                        key={
                                                                            name
                                                                        }
                                                                        what={{
                                                                            runId: run.runId,
                                                                            spec: r.spec,
                                                                            name,
                                                                        }}
                                                                        mint={() =>
                                                                            getRunSuiteArtifactUrl(
                                                                                {
                                                                                    runId: run.runId,
                                                                                    spec: r.spec,
                                                                                    name,
                                                                                },
                                                                            )
                                                                        }>
                                                                        {artifactLabel(
                                                                            name,
                                                                        )}
                                                                    </MintedEvidenceLink>
                                                                ),
                                                            )}
                                                        </div>
                                                    )}
                                                </div>
                                            </TableCell>
                                        </TableRow>
                                    )}
                                </Fragment>
                            );
                        })}
                    </TableBody>
                </Table>
            </TableContainer>
        </section>
    );
};

export const RunSuiteTab = ({
    run,
    suite,
}: {
    run: RuntimeRun;
    suite: RuntimeSuiteRun;
}) => {
    const canRetry = usePermissionOnEvery(
        Action.Create,
        ResourceType.RuntimeRun,
        repositoryIdsOfRun(run),
    );
    const verdict = suiteVerdict(suite);
    const groups = failureGroups(suite);
    const why = whySpecs(suite);
    // Only the first failed test opens, and only when it is a regression.
    const opened =
        groups[0]?.group === "regression" ? groups[0].items[0] : undefined;
    return (
        <div className="flex flex-col gap-6">
            <section
                aria-label="Verdict"
                className={cn(
                    "flex flex-wrap items-start gap-4 rounded-xl border p-5",
                    PANEL[verdict.tone],
                )}>
                <span className={TONE_TEXT_CLASS[verdict.tone]}>
                    {ICON[verdict.tone]}
                </span>
                <div className="flex min-w-0 flex-1 basis-96 flex-col gap-1">
                    <Heading variant="h2" className="text-lg">
                        {verdict.title}
                    </Heading>
                    <p className="text-text-secondary text-sm">
                        {verdict.sentence}
                    </p>
                </div>
                {suite.canRetry && canRetry && <RetryFailedButton run={run} />}
            </section>

            <section
                aria-label="Key facts"
                className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {suiteFacts(suite).map((f) => (
                    <Metric
                        key={f.label}
                        label={f.label}
                        value={f.value}
                        hint={f.hint}
                    />
                ))}
            </section>

            {groups.length > 0 && (
                <section
                    aria-label="Failed tests"
                    className="flex flex-col gap-3">
                    <Heading variant="h2" className="text-base">
                        Failed tests
                    </Heading>
                    {groups.flatMap((g) =>
                        g.items.map((f) => (
                            <FailureItem
                                key={`${f.spec}\u0000${f.title}`}
                                runId={run.runId}
                                failure={f}
                                label={g.label}
                                tone={g.tone}
                                open={f === opened}
                            />
                        )),
                    )}
                </section>
            )}

            <TimeSplit suite={suite} />

            <SpecsTable run={run} suite={suite} />

            <section aria-label="Details" className="flex flex-col gap-3">
                <Heading variant="h2" className="text-base">
                    Details
                </Heading>
                <RuntimeDisclosure title={why.title} summary={why.summary}>
                    {why.rows.length > 0 && (
                        <ul className="flex flex-col gap-1 font-mono text-xs">
                            {why.rows.map((r) => (
                                <li key={r.file}>
                                    {r.file} → {r.specs}
                                </li>
                            ))}
                        </ul>
                    )}
                    {why.note && (
                        <p className="text-text-secondary max-w-3xl text-sm">
                            {why.note}
                        </p>
                    )}
                </RuntimeDisclosure>
            </section>
        </div>
    );
};
