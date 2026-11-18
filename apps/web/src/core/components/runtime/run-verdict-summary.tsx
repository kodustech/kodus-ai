import type { ReactNode } from "react";
import NextLink from "next/link";
import { Heading } from "@components/ui/heading";
import type {
    CheckConclusion,
    RunPublication,
    RunState,
} from "@services/runtime/contracts";
import {
    formatDurationMs,
    formatEstimatedUsd,
    formatUtcClock,
} from "@services/runtime/format";
import {
    checkConclusionLabel,
    checkConclusionTone,
    isTerminalRunState,
    runStateTone,
    verdictChipLabel,
} from "@services/runtime/labels";
import {
    publicationLine,
    type PublicationKind,
} from "@services/runtime/model/publication";
import type { RunStats, RunSummary } from "@services/runtime/model/run-summary";
import { cn } from "src/core/utils/components";

import { openDisclosure } from "./disclosure";
import { RichTextView } from "./rich-text";
import { StatusChip, TONE_DOT_CLASS } from "./status-chip";

const Stat = ({
    label,
    children,
    href,
}: {
    label: string;
    children: ReactNode;
    href?: string;
}) => {
    const body = (
        <>
            <dt className="text-text-tertiary text-xs">{label}</dt>
            <dd className="text-text-primary text-xl font-semibold whitespace-nowrap tabular-nums">
                {children}
            </dd>
        </>
    );
    return (
        <div className="bg-card-lv2 flex min-h-11 flex-col gap-1 rounded-xl px-4 py-3">
            {href ? (
                <a
                    href={href}
                    onClick={() =>
                        href.startsWith("#") && openDisclosure(href.slice(1))
                    }
                    className="focus-visible:ring-ring flex flex-col gap-1 rounded-lg hover:underline focus-visible:ring-3 focus-visible:outline-none">
                    {body}
                </a>
            ) : (
                body
            )}
        </div>
    );
};

const KIND_LABEL: Record<PublicationKind, string> = {
    check: "Check",
    comment: "Comment",
};

/** The compact "On the PR" row: the check and the comment, one line each. */
export const PublicationRow = ({
    publication,
}: {
    publication: RunPublication;
}) => {
    if (!publication.postsToPullRequest)
        return (
            <p className="text-text-secondary text-sm" role="note">
                <span className="text-text-tertiary">On the PR: </span>
                Simulation: nothing is posted on the pull request; the result is
                only on this page.
            </p>
        );
    return (
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2 text-sm">
            <span className="text-text-tertiary">On the PR:</span>
            {(["check", "comment"] as const).map((kind) => {
                const view = publication[kind];
                const line = publicationLine(kind, view);
                return (
                    <span key={kind} className="flex items-baseline gap-2">
                        <span
                            aria-hidden
                            className={cn(
                                "inline-block size-2 shrink-0 rounded-full",
                                TONE_DOT_CLASS[line.tone],
                            )}
                        />
                        <span className="text-text-primary">
                            {KIND_LABEL[kind]}: {line.label}
                            {view.at && view.status === "published" && (
                                <span className="text-text-tertiary">
                                    {" "}
                                    · {formatUtcClock(view.at).slice(0, 5)} UTC
                                </span>
                            )}
                        </span>
                        {line.detail && (
                            <span className="text-text-secondary">
                                {line.detail}
                            </span>
                        )}
                    </span>
                );
            })}
        </div>
    );
};

/** A link drawn as the card's primary button: the one amber thing on the card. */
export const PRIMARY_ACTION_CLASS =
    "bg-primary-light text-primary-dark focus-visible:ring-ring inline-flex min-h-10 w-fit items-center gap-2 rounded-xl px-5 text-sm font-semibold hover:brightness-120 focus-visible:ring-3 focus-visible:outline-none";

/** The verdict card: what happened, how sure, what to do (one action), and the four numbers. */
export const RunVerdictSummary = ({
    state,
    check,
    checkPlatform,
    summary,
    stats,
    costUsd,
    publication,
    reason,
    primaryAction,
}: {
    state: RunState;
    check?: { conclusion: CheckConclusion; title: string };
    /** "GitHub": where the check lives, when Kodus knows the PR. */
    checkPlatform?: string;
    summary: RunSummary;
    stats: RunStats;
    costUsd?: number | null;
    publication?: RunPublication;
    /** The Runtime's recorded reason, for the states that have one. */
    reason?: string;
    /** The one thing to do, chosen from `summary.todo.action` by the page; else the todo's link is it. */
    primaryAction?: ReactNode;
}) => {
    const live = !isTerminalRunState(state);
    const noComparisonRecorded =
        state === "no_regressions" && summary.hasRecordedComparisons === false;
    const noVerdict =
        state === "errored" &&
        !summary.hasRecordedVerdict &&
        stats.total === 0 &&
        stats.tested === 0 &&
        stats.regressions === 0;
    // Nothing was compared: "0 regressions" would read as a clean result.
    const nothingCompared =
        !live &&
        state !== "regression" &&
        stats.tested === 0 &&
        stats.regressions === 0;
    // The check is Kodus's verdict; "on GitHub" only once it is there.
    const checkPosted =
        !publication ||
        (publication.postsToPullRequest &&
            publication.check.status === "published");
    const link = summary.todo?.link;
    return (
        <section
            aria-labelledby="run-verdict"
            className="bg-card-lv1 flex flex-col gap-6 rounded-xl p-6">
            <div className="flex flex-wrap gap-8">
                <div className="flex min-w-0 flex-[999_1_32rem] flex-col gap-3">
                    <div className="flex flex-wrap items-center gap-3">
                        <StatusChip
                            tone={
                                noComparisonRecorded
                                    ? "neutral"
                                    : runStateTone(state)
                            }>
                            {noComparisonRecorded
                                ? "No comparison recorded"
                                : verdictChipLabel(state, stats.tested)}
                        </StatusChip>
                        <span className="text-text-secondary text-sm">
                            {check ? (
                                <>
                                    {!checkPosted
                                        ? "Check result: "
                                        : checkPlatform
                                          ? `Check on ${checkPlatform}: `
                                          : "Check: "}
                                    <span
                                        className={cn(
                                            "font-medium",
                                            checkConclusionTone(
                                                check.conclusion,
                                            ) === "danger"
                                                ? "text-danger"
                                                : "text-text-primary",
                                        )}>
                                        {checkConclusionLabel(check.conclusion)}
                                    </span>
                                </>
                            ) : live ? (
                                "The check is written when the Run reaches a verdict."
                            ) : (
                                "This Run did not write a check."
                            )}
                        </span>
                    </div>
                    <Heading
                        variant="h2"
                        id="run-verdict"
                        className="text-2xl font-bold">
                        {summary.headline}
                    </Heading>
                    {summary.explanation.length > 0 && (
                        <p className="text-text-secondary max-w-3xl text-sm leading-relaxed">
                            {summary.explanation.map((sentence, i) => (
                                <span key={i}>
                                    {i > 0 && " "}
                                    <RichTextView text={sentence} />
                                </span>
                            ))}
                        </p>
                    )}
                    {summary.certainty && (
                        <p className="text-text-primary text-sm">
                            <span className="text-text-secondary">
                                How sure:{" "}
                            </span>
                            {summary.certainty}.
                        </p>
                    )}
                    {reason && state !== "errored" && (
                        <p className="text-text-secondary text-xs">
                            What the Runtime recorded:{" "}
                            <code className="text-text-primary font-mono break-words whitespace-pre-wrap">
                                {reason}
                            </code>
                        </p>
                    )}
                    {summary.todo && (
                        <div className="bg-card-lv2 flex flex-col gap-3 rounded-xl px-4 py-3 text-sm">
                            <div className="flex flex-col gap-1">
                                <span className="text-text-secondary text-xs font-medium">
                                    What you can do
                                </span>
                                <span className="text-text-primary">
                                    <RichTextView text={summary.todo.text} />
                                </span>
                            </div>
                            {(primaryAction || link) && (
                                <div className="flex flex-wrap items-center gap-3">
                                    {primaryAction}
                                    {link && (
                                        <NextLink
                                            href={link.href}
                                            className={
                                                primaryAction
                                                    ? "text-primary-light focus-visible:ring-ring inline-flex min-h-11 items-center rounded-sm underline-offset-2 hover:underline focus-visible:ring-3 focus-visible:outline-none"
                                                    : PRIMARY_ACTION_CLASS
                                            }>
                                            {link.label}
                                        </NextLink>
                                    )}
                                </div>
                            )}
                        </div>
                    )}
                </div>
                <dl className="grid flex-[1_1_18rem] grid-cols-2 content-start gap-3">
                    <Stat label="Regressions">
                        <span
                            className={cn(
                                stats.regressions > 0 && "text-danger",
                            )}>
                            {noComparisonRecorded ? (
                                "Not recorded"
                            ) : noVerdict ? (
                                "No verdict"
                            ) : nothingCompared ? (
                                <>
                                    <span
                                        aria-hidden
                                        className="text-text-tertiary">
                                        —
                                    </span>
                                    <span className="sr-only">
                                        None compared
                                    </span>
                                </>
                            ) : (
                                stats.regressions
                            )}
                        </span>
                    </Stat>
                    <Stat label="Paths tested">
                        {noVerdict || noComparisonRecorded ? (
                            <span className="text-text-secondary text-sm font-normal whitespace-normal">
                                {noComparisonRecorded
                                    ? "Comparison not recorded"
                                    : "Comparison incomplete"}
                            </span>
                        ) : live && stats.total === 0 ? (
                            <span className="text-text-tertiary">—</span>
                        ) : (
                            <>
                                {stats.tested}{" "}
                                <span className="text-text-tertiary text-sm font-normal">
                                    of {stats.total}
                                </span>
                            </>
                        )}
                    </Stat>
                    <Stat label={live ? "Running for" : "Took"}>
                        {formatDurationMs(stats.tookMs)}
                    </Stat>
                    <Stat label="Cost (estimate)" href="#run-cost">
                        {formatEstimatedUsd(costUsd)}
                    </Stat>
                </dl>
            </div>
            {publication && (
                <div className="bg-card-lv2/50 rounded-xl px-4 py-3">
                    <PublicationRow publication={publication} />
                </div>
            )}
        </section>
    );
};
