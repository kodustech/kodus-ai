"use client";

import { type ReactNode } from "react";
import { RuntimeDisclosure } from "@components/runtime/disclosure";
import { MintedEvidenceLink } from "@components/runtime/evidence-link";
import { Metric } from "@components/runtime/section";
import { StatusChip, TONE_TEXT_CLASS } from "@components/runtime/status-chip";
import { Button } from "@components/ui/button";
import { Heading } from "@components/ui/heading";
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
    suiteFacts,
    suiteVerdict,
    whySpecs,
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
    let first = true;
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
                        g.items.map((f) => {
                            const open = first && g.group === "regression";
                            first = false;
                            return (
                                <FailureItem
                                    key={`${f.spec}\u0000${f.title}`}
                                    runId={run.runId}
                                    failure={f}
                                    label={g.label}
                                    tone={g.tone}
                                    open={open}
                                />
                            );
                        }),
                    )}
                </section>
            )}

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

                {suite.shards.length > 0 && (
                    <RuntimeDisclosure
                        title="Shards"
                        summary={`${suite.hosts === 1 ? "1 host" : `${suite.hosts} hosts`} · longest ${formatDurationMs(Math.max(...suite.shards.map((s) => s.specMs ?? 0)))} of spec time`}>
                        <TableContainer>
                            <Table>
                                <TableHeader>
                                    <TableRow>
                                        <TableHead>Shard</TableHead>
                                        <TableHead>Specs</TableHead>
                                        <TableHead>Passed</TableHead>
                                        <TableHead>Failed</TableHead>
                                        <TableHead>Spec time</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {suite.shards.map((s) => (
                                        <TableRow key={s.shard}>
                                            <TableCell>{s.shard + 1}</TableCell>
                                            <TableCell>{s.specs}</TableCell>
                                            <TableCell>{s.passed}</TableCell>
                                            <TableCell>{s.failed}</TableCell>
                                            <TableCell>
                                                {s.specMs === null
                                                    ? "—"
                                                    : formatDurationMs(
                                                          s.specMs,
                                                      )}
                                            </TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        </TableContainer>
                    </RuntimeDisclosure>
                )}

                {suite.passed.length > 0 && (
                    <RuntimeDisclosure
                        title="Passed"
                        summary={`${suite.passed.length} ${suite.passed.length === 1 ? "spec" : "specs"}`}>
                        <p className="text-text-secondary font-mono text-xs">
                            {suite.passed.join(" · ")}
                        </p>
                    </RuntimeDisclosure>
                )}
            </section>
        </div>
    );
};
