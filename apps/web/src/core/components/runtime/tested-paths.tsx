"use client";

import { useState } from "react";
import { toast } from "@components/ui/toaster/use-toast";
import type {
    FindingFeedback,
    FindingFeedbackValue,
    RuntimeRun,
} from "@services/runtime/contracts";
import {
    formatClockTime,
    formatDurationMs,
    shortSha,
} from "@services/runtime/format";
import {
    isFailingOutcome,
    isTerminalRunState,
    RUN_PATH_OUTCOME_META,
    type RunPathOutcome,
} from "@services/runtime/labels";
import { runtimeErrorMessage } from "@services/runtime/model/errors";
import { baseVersionLabel } from "@services/runtime/model/base-version";
import { OUTSIDE_DIFF_MARKER } from "@services/runtime/model/run-paths";
import type {
    RunPath,
    RunPaths,
    RunPathStep,
} from "@services/runtime/model/run-paths";
import { useFindingFeedback } from "@services/runtime/queries";
import {
    ChevronDownIcon,
    CircleAlertIcon,
    CircleCheckIcon,
    CircleDashedIcon,
    CircleXIcon,
    ThumbsDownIcon,
    ThumbsUpIcon,
} from "lucide-react";
import { cn } from "src/core/utils/components";

import { EvidenceLink } from "./evidence-link";
import { ReproduceFinding } from "./reproduce-finding";
import { StatusChip } from "./status-chip";

const FOCUS =
    "focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-3";

const OutcomeIcon = ({ outcome }: { outcome: RunPathOutcome }) =>
    isFailingOutcome(outcome) ? (
        <CircleXIcon className="text-danger size-4 shrink-0" aria-hidden />
    ) : outcome === "could_not_test" ? (
        <CircleAlertIcon className="text-warning size-4 shrink-0" aria-hidden />
    ) : (
        <CircleCheckIcon
            className={cn(
                "size-4 shrink-0",
                outcome === "same" ? "text-success" : "text-text-tertiary",
            )}
            aria-hidden
        />
    );

const StepIcon = ({ ok }: { ok?: boolean }) =>
    ok === undefined ? (
        <CircleDashedIcon
            className="text-text-tertiary size-3.5"
            aria-label="Not verified"
        />
    ) : ok ? (
        <CircleCheckIcon
            className="text-success size-3.5"
            aria-label="As expected"
        />
    ) : (
        <CircleXIcon className="text-danger size-3.5" aria-label="Differs" />
    );

const index = (i: number) => String(i + 1).padStart(2, "0");

export const PathFeedback = ({
    feedback,
    onVote,
    pending,
    entryPoint,
}: {
    feedback?: FindingFeedback;
    onVote?: (value: FindingFeedbackValue | null) => void;
    pending?: boolean;
    entryPoint: string;
}) => {
    if (!onVote) return null;
    const vote = (value: FindingFeedbackValue) =>
        onVote(feedback?.mine === value ? null : value);
    const button = (value: FindingFeedbackValue) => {
        const Icon = value === "up" ? ThumbsUpIcon : ThumbsDownIcon;
        const pressed = feedback?.mine === value;
        return (
            <button
                type="button"
                aria-pressed={pressed}
                aria-label={`${value === "up" ? "Useful" : "Not useful"}: ${entryPoint}`}
                disabled={pending}
                onClick={() => vote(value)}
                className={cn(
                    FOCUS,
                    "flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors disabled:opacity-60",
                    pressed
                        ? "bg-primary-light/15 text-primary-light"
                        : "text-text-secondary hover:bg-card-lv3",
                )}>
                <Icon className="size-3.5" aria-hidden />
                <span className="font-mono">{feedback?.[value] ?? 0}</span>
            </button>
        );
    };
    return (
        <div className="flex items-center gap-1">
            {button("up")}
            {button("down")}
        </div>
    );
};

const Evidence = ({
    runId,
    headSha,
    step,
    position,
    baseLabel,
}: {
    runId: string;
    headSha?: string;
    step: RunPathStep;
    position: number;
    baseLabel: string;
}) => (
    <div className="bg-card-lv2 flex min-w-0 flex-col gap-3 rounded-lg p-4">
        <p className="text-text-secondary text-xs break-words">
            {index(position)} · {step.title} ·{" "}
            {step.side === "pr"
                ? `this PR${headSha ? ` @ ${shortSha(headSha)}` : ""}`
                : baseLabel}
        </p>
        <ol className="bg-card-lv1 flex flex-col gap-1 overflow-x-auto rounded-md p-3 font-mono text-xs">
            <li className="flex gap-3">
                <span className="text-text-tertiary shrink-0">
                    {formatClockTime(step.startedAt)}
                </span>
                <span>sent</span>
            </li>
            <li className="flex gap-3">
                <span className="text-text-tertiary shrink-0">
                    {formatClockTime(step.finishedAt)}
                </span>
                <span className={cn(step.ok === false && "text-danger")}>
                    {step.finishedAt
                        ? step.observed
                        : step.observed === "not recorded"
                          ? "Response not recorded"
                          : "waiting for the answer"}
                    {step.durationMs !== undefined &&
                        ` · ${formatDurationMs(step.durationMs)}`}
                </span>
            </li>
        </ol>
        {step.finishedAt && (
            <div className="flex flex-wrap gap-3">
                <EvidenceLink
                    runId={runId}
                    stepId={step.stepId}
                    side={step.side}>
                    Command and output
                </EvidenceLink>
                <EvidenceLink
                    runId={runId}
                    stepId={step.stepId}
                    side={step.side}
                    type="app_log">
                    App log
                </EvidenceLink>
            </div>
        )}
    </div>
);

const PathRow = ({
    path,
    runId,
    headSha,
    open,
    onToggle,
    feedback,
    onVote,
    votePending,
    reproducible,
}: {
    path: RunPath;
    runId: string;
    headSha?: string;
    open: boolean;
    onToggle: () => void;
    feedback?: FindingFeedback;
    onVote?: (value: FindingFeedbackValue | null) => void;
    votePending?: boolean;
    /** The Run kept a script that reproduces this finding. */
    reproducible?: boolean;
}) => {
    // The PR step is the one that tells the story; start the evidence there.
    const firstPr = path.steps.findIndex((s) => s.side === "pr");
    const [selected, setSelected] = useState(firstPr >= 0 ? firstPr : 0);
    const current = path.steps[selected];
    const outcome = RUN_PATH_OUTCOME_META[path.outcome];
    const panelId = `path-${path.probeId}`;

    return (
        <li className="bg-card-lv2/40 rounded-lg" id={panelId}>
            <button
                type="button"
                aria-expanded={open}
                aria-controls={`${panelId}-body`}
                onClick={onToggle}
                className={cn(
                    "hover:bg-card-lv2 flex w-full flex-wrap items-center gap-3 rounded-lg px-4 py-3 text-left",
                    FOCUS,
                )}>
                <OutcomeIcon outcome={path.outcome} />
                <span className="text-text-primary font-mono text-sm">
                    {path.route}
                </span>
                {path.outsideDiff && (
                    <span className="text-text-tertiary text-xs">
                        {OUTSIDE_DIFF_MARKER}
                    </span>
                )}
                <StatusChip tone={outcome.tone}>{outcome.label}</StatusChip>
                <span className="text-text-secondary text-sm">
                    {path.summary}
                </span>
                <ChevronDownIcon
                    className={cn(
                        "text-text-tertiary ml-auto size-4 transition-transform",
                        open && "rotate-180",
                    )}
                    aria-hidden
                />
            </button>
            {open && (
                <div
                    id={`${panelId}-body`}
                    className="grid gap-4 px-4 pb-4 lg:grid-cols-2">
                    <div className="flex min-w-0 flex-col gap-2">
                        {path.steps.length === 0 ? (
                            <p className="text-text-secondary text-sm">
                                {path.reason}
                            </p>
                        ) : (
                            <ol className="flex flex-col gap-1">
                                {path.steps.map((s, i) => (
                                    <li key={s.stepId}>
                                        <button
                                            type="button"
                                            aria-current={i === selected}
                                            onClick={() => setSelected(i)}
                                            className={cn(
                                                FOCUS,
                                                "flex w-full items-start gap-3 rounded-md px-3 py-2 text-left",
                                                i === selected
                                                    ? "bg-card-lv2"
                                                    : "hover:bg-card-lv2/60",
                                            )}>
                                            <span className="text-text-tertiary font-mono text-xs">
                                                {index(i)}
                                            </span>
                                            <span className="pt-0.5">
                                                <StepIcon ok={s.ok} />
                                            </span>
                                            <span className="flex min-w-0 flex-col gap-0.5">
                                                <span className="text-text-primary text-sm">
                                                    {s.title}
                                                </span>
                                                {s.expected ? (
                                                    <span className="text-text-secondary text-xs">
                                                        Expected {s.expected}
                                                        {s.ok === false
                                                            ? `, got ${s.observed}`
                                                            : s.ok
                                                              ? ` · got ${s.observed}`
                                                              : ""}
                                                    </span>
                                                ) : (
                                                    <span className="text-text-secondary text-xs">
                                                        Returns {s.observed}
                                                    </span>
                                                )}
                                            </span>
                                        </button>
                                    </li>
                                ))}
                            </ol>
                        )}
                        {path.outcome !== "same" && path.steps.length > 0 && (
                            <p className="text-text-tertiary px-3 text-xs">
                                {path.reason}
                            </p>
                        )}
                    </div>
                    <div className="flex min-w-0 flex-col gap-2">
                        {current && (
                            <Evidence
                                runId={runId}
                                headSha={headSha}
                                step={current}
                                position={selected}
                                baseLabel={path.baseLabel ?? baseVersionLabel()}
                            />
                        )}
                        {reproducible && isFailingOutcome(path.outcome) && (
                            <div className="flex items-center justify-between gap-2">
                                <span className="text-text-tertiary text-xs">
                                    See it yourself, from your own clone.
                                </span>
                                <ReproduceFinding
                                    runId={runId}
                                    probeId={path.probeId}
                                    entryPoint={path.route}
                                />
                            </div>
                        )}
                        {onVote && (
                            <div className="flex items-center justify-between gap-2">
                                <span className="text-text-tertiary text-xs">
                                    Was this useful?
                                </span>
                                <PathFeedback
                                    feedback={feedback}
                                    onVote={onVote}
                                    pending={votePending}
                                    entryPoint={path.route}
                                />
                            </div>
                        )}
                    </div>
                </div>
            )}
        </li>
    );
};

/** Screen 8: one expandable row per tested path; the first regression starts open. */
export const TestedPathsView = ({
    runId,
    headSha,
    paths,
    untested,
    feedback,
    onVote,
    votePendingFor,
    live,
    reproducible,
}: {
    runId: string;
    headSha?: string;
    paths: RunPath[];
    untested: RunPaths["untested"];
    feedback?: Record<string, FindingFeedback>;
    onVote?: (probeId: string, value: FindingFeedbackValue | null) => void;
    /** The probe whose vote is being saved: only its buttons wait. */
    votePendingFor?: string;
    live?: boolean;
    /** Findings with recorded reproduction data, by probeId. */
    reproducible?: string[];
}) => {
    const [openIds, setOpenIds] = useState<Set<string>>(() => {
        const firstRegression = paths.find((p) => isFailingOutcome(p.outcome));
        return new Set(firstRegression ? [firstRegression.probeId] : []);
    });
    const toggle = (probeId: string) =>
        setOpenIds((prev) => {
            const next = new Set(prev);
            if (next.has(probeId)) next.delete(probeId);
            else next.add(probeId);
            return next;
        });

    if (paths.length === 0 && untested.length === 0) {
        return (
            <p className="text-text-secondary text-sm">
                {live
                    ? "Tested paths appear here as Kody runs them."
                    : "This Run tested no path."}
            </p>
        );
    }

    return (
        <ul className="flex flex-col gap-2">
            {paths.map((path) => (
                <PathRow
                    key={`${path.probeId}-${path.entryPoint}`}
                    path={path}
                    runId={runId}
                    headSha={headSha}
                    open={openIds.has(path.probeId)}
                    onToggle={() => toggle(path.probeId)}
                    feedback={feedback?.[path.probeId]}
                    onVote={onVote && ((value) => onVote(path.probeId, value))}
                    reproducible={reproducible?.includes(path.probeId)}
                    votePending={votePendingFor === path.probeId}
                />
            ))}
            {untested.map((u) => (
                <li
                    key={u.entryPoint}
                    className="flex flex-wrap items-center gap-3 px-4 py-3">
                    <CircleAlertIcon
                        className="text-warning size-4"
                        aria-hidden
                    />
                    <span className="text-text-primary font-mono text-sm">
                        {u.entryPoint}
                    </span>
                    <StatusChip tone="warning">
                        {RUN_PATH_OUTCOME_META.could_not_test.label}
                    </StatusChip>
                    <span className="text-text-secondary text-sm">
                        {u.reason}
                    </span>
                </li>
            ))}
        </ul>
    );
};

/** "2 of 3 paths tested", from the same rows the list draws. */
export const testedSummary = (
    runPaths: Pick<RunPaths, "testedCount" | "totalCount">,
) =>
    `${runPaths.testedCount} of ${runPaths.totalCount} ${runPaths.totalCount === 1 ? "path" : "paths"} tested`;

/** The tested paths of a Run with 👍/👎 stored server-side: on the Run page and on the PR's Runtime tab. */
export const TestedPaths = ({
    run,
    runPaths,
}: {
    run: RuntimeRun;
    runPaths: RunPaths;
}) => {
    const vote = useFindingFeedback();
    return (
        <TestedPathsView
            // A new verdict can bring the first regression: reopen it.
            key={runPaths.paths.map((p) => p.probeId).join(",")}
            runId={run.runId}
            headSha={run.headSha}
            paths={runPaths.paths}
            untested={runPaths.untested}
            feedback={run.feedback}
            reproducible={run.reproducible}
            live={!isTerminalRunState(run.state)}
            votePendingFor={
                vote.isPending ? vote.variables?.probeId : undefined
            }
            onVote={(probeId, value) =>
                vote.mutate(
                    { runId: run.runId, probeId, value },
                    {
                        onError: (error) =>
                            toast({
                                variant: "danger",
                                title: "Couldn't save your feedback",
                                description: runtimeErrorMessage(error, {
                                    fallback: "Try again in a moment.",
                                }),
                            }),
                    },
                )
            }
        />
    );
};
