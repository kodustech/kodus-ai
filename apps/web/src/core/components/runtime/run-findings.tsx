"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@components/ui/button";
import type {
    FindingFeedback,
    FindingFeedbackValue,
} from "@services/runtime/contracts";
import { formatDurationMs, shortSha } from "@services/runtime/format";
import { RUN_PATH_OUTCOME_META } from "@services/runtime/labels";
import {
    baseVersionLabel,
    comparisonSideLabel,
} from "@services/runtime/model/base-version";
import type { BootFailureView } from "@services/runtime/model/boot-failure";
import { hasBrowserEvidence } from "@services/runtime/model/browser-evidence";
import { codeRefOf } from "@services/runtime/model/code-ref";
import type { Finding, FindingSide } from "@services/runtime/model/findings";
import { hasLaneEvents } from "@services/runtime/model/replay-lanes";
import { checkLabel } from "@services/runtime/model/run-paths";
import { whatHappened } from "@services/runtime/model/what-happened";
import { ChevronRightIcon } from "lucide-react";
import { cn } from "src/core/utils/components";

import { BrowserEvidence } from "./browser-evidence";
import { InlineDisclosure } from "./disclosure";
import { EvidenceLink } from "./evidence-link";
import { IntendedNote } from "./intended-note";
import { ReplayLanesView } from "./replay-lanes";
import { ReproduceFinding } from "./reproduce-finding";
import { ResponseDiffTable } from "./response-diff";
import { RichTextView } from "./rich-text";
import { StatusChip } from "./status-chip";
import { PathFeedback } from "./tested-paths";
import { ViaNote } from "./via-note";

/** What one side answered, round by round, with its raw evidence. */
const HttpOrExecAnswer = ({
    runId,
    side,
    highlight,
    baseLabel,
}: {
    runId: string;
    side: FindingSide;
    /** Draw this PR's answer as the regression. */
    highlight: boolean;
    baseLabel: string;
}) => (
    <div className="bg-card-lv2 flex min-w-0 flex-col gap-2 rounded-xl p-4">
        <span className="text-text-tertiary text-xs">
            {comparisonSideLabel(side.side, baseLabel)} · {shortSha(side.sha)} ·{" "}
            {side.rounds.length === 1
                ? "1 attempt"
                : `${side.rounds.length} attempts`}
        </span>
        <span
            className={cn(
                "font-mono text-lg font-semibold",
                highlight && side.side === "pr"
                    ? "text-danger"
                    : "text-text-primary",
            )}>
            {side.answer}
        </span>
        {side.rounds.length > 0 && (
            <ol className="flex flex-col gap-1 font-mono text-xs">
                {side.rounds.map((r) => (
                    <li
                        key={r.stepId}
                        className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <span className="text-text-tertiary">
                            attempt {r.round}
                        </span>
                        <span
                            className={cn(
                                r.lost ? "text-danger" : "text-text-primary",
                            )}>
                            {r.answer}
                        </span>
                        {r.durationMs !== undefined && (
                            <span className="text-text-tertiary">
                                {formatDurationMs(r.durationMs)}
                            </span>
                        )}
                        {r.answer !== "running" && (
                            <EvidenceLink
                                runId={runId}
                                stepId={r.stepId}
                                side={side.side}>
                                Raw response
                                <span className="sr-only">
                                    {" "}
                                    of{" "}
                                    {comparisonSideLabel(side.side, baseLabel)},
                                    attempt {r.round}
                                </span>
                            </EvidenceLink>
                        )}
                    </li>
                ))}
            </ol>
        )}
        {side.rounds.length > 1 && (
            <span className="text-text-secondary text-xs">
                {side.steady
                    ? "Same answer every attempt"
                    : "The answer changed between attempts"}
            </span>
        )}
    </div>
);

/** A finding's id on the page: the verdict card's "Open the finding" points at it. */
export const findingAnchorId = (probeId: string) =>
    `finding-${probeId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;

/**
 * The evidence of a finding, by kind: an HTTP answer or a command's exit
 * code on each side, attempt by attempt; a browser probe (ADR-071) adds its
 * steps, screenshots, recordings and page log, all from the evidence origin.
 */
export const FindingEvidence = ({
    runId,
    finding,
    highlight,
}: {
    runId: string;
    finding: Finding;
    /** Draw this PR's answer as the regression. */
    highlight: boolean;
}) => {
    switch (finding.evidenceKind) {
        case "http":
        case "exec":
        case "unknown":
            return (
                <div className="flex flex-col gap-3">
                    <div className="grid gap-3 md:grid-cols-2">
                        <HttpOrExecAnswer
                            runId={runId}
                            side={finding.base}
                            baseLabel={finding.baseLabel ?? baseVersionLabel()}
                            highlight={highlight}
                        />
                        <HttpOrExecAnswer
                            runId={runId}
                            side={finding.pr}
                            baseLabel={finding.baseLabel ?? baseVersionLabel()}
                            highlight={highlight}
                        />
                    </div>
                    {finding.lanes && hasBrowserEvidence(finding.lanes) && (
                        <BrowserEvidence
                            runId={runId}
                            lanes={finding.lanes}
                            baseLabel={finding.baseLabel}
                        />
                    )}
                </div>
            );
    }
};

/** The chip of a finding: what the verdict counted, or new behavior the PR announced. */
const chipOf = (finding: Finding) =>
    finding.matchesExpectation
        ? { tone: "alert" as const, label: "New behavior · confirm it" }
        : RUN_PATH_OUTCOME_META[finding.intended ? "intended" : "regression"];

export const FindingCard = ({
    runId,
    finding,
    feedback,
    onVote,
    votePending,
    onMarkIntended,
    intentPending,
    pullRequestUrl,
    bootFailure,
    defaultOpen = true,
}: {
    runId: string;
    finding: Finding;
    /** The PR on its platform, for the "Changed in" link (GitHub only). */
    pullRequestUrl?: string;
    /** Why this PR did not boot, for a boot regression's summary. */
    bootFailure?: BootFailureView;
    feedback?: FindingFeedback;
    onVote?: (value: FindingFeedbackValue | null) => void;
    votePending?: boolean;
    /** Absent when the viewer may not mark findings (write on Runs of this repository). */
    onMarkIntended?: (intended: boolean) => void;
    intentPending?: boolean;
    /** Open on arrival; the others are one row each until the reader opens them. */
    defaultOpen?: boolean;
}) => {
    const [initialOpen] = useState(defaultOpen);
    const chip = chipOf(finding);
    const titleId = `finding-title-${finding.probeId}`;
    const baseLabel = finding.baseLabel ?? baseVersionLabel();
    // A regression is a state, so it earns the one stroke; new behavior the PR announced does not.
    const real = !finding.intended && !finding.matchesExpectation;
    const [lead, ...story] = whatHappened(finding, {
        codeRef: codeRefOf(finding.diffRef, {
            url: pullRequestUrl,
            headSha: finding.pr.sha,
        }),
        bootFailure,
    });
    return (
        <article
            aria-labelledby={titleId}
            className={cn(
                "bg-card-lv2/40 rounded-xl",
                real && "ring-danger/40 ring-1",
            )}>
            <details
                id={findingAnchorId(finding.probeId)}
                open={initialOpen}
                className="group/finding scroll-mt-24">
                <summary className="focus-visible:ring-ring flex cursor-pointer list-none items-start gap-3 rounded-xl p-5 hover:brightness-120 focus-visible:ring-3 focus-visible:outline-none [&::-webkit-details-marker]:hidden">
                    <ChevronRightIcon
                        aria-hidden
                        className="text-text-secondary mt-1 size-4 shrink-0 transition-transform duration-200 group-open/finding:rotate-90"
                    />
                    <span className="flex min-w-0 flex-col gap-2">
                        <span className="flex flex-wrap items-center gap-x-3 gap-y-2">
                            <StatusChip tone={chip.tone}>
                                {chip.label}
                            </StatusChip>
                            <code
                                id={titleId}
                                className="text-text-primary font-mono text-base font-semibold break-all">
                                {finding.route}
                            </code>
                            {checkLabel(finding.probeId, finding.purpose) && (
                                <span className="text-text-secondary text-sm">
                                    {checkLabel(
                                        finding.probeId,
                                        finding.purpose,
                                    )}
                                </span>
                            )}
                            {finding.via && <ViaNote via={finding.via} />}
                        </span>
                        <span className="text-text-primary text-sm leading-6">
                            {lead ? (
                                <RichTextView text={lead} />
                            ) : (
                                finding.change
                            )}
                        </span>
                    </span>
                </summary>

                <div className="flex flex-col gap-4 px-5 pb-5">
                    {finding.matchesExpectation && (
                        <p
                            role="note"
                            className="bg-card-lv2 text-text-secondary rounded-xl px-4 py-3 text-sm">
                            <span className="text-text-primary font-medium">
                                New behavior that matches what this PR says it
                                does: confirm it is intended.
                            </span>{" "}
                            Kody expected{" "}
                            <code className="text-text-primary font-mono">
                                {finding.expected?.trim()}
                            </code>{" "}
                            before running and this PR answered it; {baseLabel}{" "}
                            answered{" "}
                            <code className="text-text-primary font-mono">
                                {finding.base.answer}
                            </code>{" "}
                            because it has no such route. The check counts it as
                            a regression until Kody learns otherwise.
                        </p>
                    )}

                    {story.length > 0 && (
                        <section
                            aria-label="What happened"
                            className="flex flex-col gap-1">
                            <p className="text-text-secondary text-sm leading-6">
                                {story.map((sentence, i) => (
                                    <span key={i}>
                                        {i > 0 && " "}
                                        <RichTextView text={sentence} />
                                    </span>
                                ))}
                            </p>
                        </section>
                    )}

                    {finding.boot ? (
                        <p className="text-text-secondary text-sm">
                            No request was sent: this PR never got ready, so
                            there was nothing to compare.
                            {bootFailure?.side === "pr" &&
                                " Its boot log is above, under “Why this PR did not boot”."}
                        </p>
                    ) : (
                        <>
                            <ResponseDiffTable
                                diff={finding.responseDiff}
                                baseLabel={finding.baseLabel}
                            />
                            <InlineDisclosure
                                label="Evidence"
                                summary={`${finding.proof}.`}>
                                <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
                                    <dt className="text-text-tertiary">
                                        Request sent to both
                                    </dt>
                                    <dd className="min-w-0">
                                        <code className="text-text-primary font-mono text-sm break-all">
                                            {finding.request ?? finding.route}
                                        </code>
                                        <span className="text-text-tertiary text-xs">
                                            {" "}
                                            · check{" "}
                                            <span className="font-mono">
                                                {finding.probeId}
                                            </span>
                                        </span>
                                    </dd>
                                    {finding.expected && (
                                        <>
                                            <dt className="text-text-tertiary">
                                                Expected, before running
                                            </dt>
                                            <dd className="text-text-secondary min-w-0">
                                                {finding.expected}
                                            </dd>
                                        </>
                                    )}
                                    <dt className="text-text-tertiary">
                                        What differs
                                    </dt>
                                    <dd className="text-text-secondary min-w-0">
                                        {finding.change}
                                    </dd>
                                </dl>
                                <FindingEvidence
                                    runId={runId}
                                    finding={finding}
                                    highlight={real}
                                />
                            </InlineDisclosure>
                            {finding.lanes && hasLaneEvents(finding.lanes) && (
                                <ReplayLanesView
                                    runId={runId}
                                    lanes={finding.lanes}
                                    route={finding.route}
                                    baseLabel={finding.baseLabel}
                                />
                            )}
                        </>
                    )}

                    {finding.destabilizes && !finding.boot && (
                        <p className="text-text-secondary text-sm">
                            The machine itself fails on this PR and stays up on{" "}
                            {baseLabel}.
                        </p>
                    )}
                    {finding.intended && (
                        <IntendedNote
                            finding={finding}
                            pullRequestUrl={pullRequestUrl}
                        />
                    )}

                    {!finding.intended && finding.markedIntended && (
                        <p className="text-text-secondary text-sm" role="note">
                            {finding.markedIntended.mine ? "You" : "A teammate"}{" "}
                            marked this as an intended change. Kody keeps it to
                            learn from; the check and the PR comment still show
                            what Kody measured.
                        </p>
                    )}

                    <div className="flex flex-wrap items-center gap-3">
                        {!finding.intended && onMarkIntended && (
                            <Button
                                // New behavior the PR announced: marking it is the thing to do here.
                                size={finding.matchesExpectation ? "sm" : "xs"}
                                variant={
                                    finding.matchesExpectation &&
                                    !finding.markedIntended
                                        ? "primary-dark"
                                        : "helper"
                                }
                                loading={intentPending}
                                aria-describedby={titleId}
                                title="Kody keeps it to learn from. The check and the PR comment keep what Kody measured."
                                onClick={() =>
                                    onMarkIntended(!finding.markedIntended)
                                }>
                                {finding.markedIntended
                                    ? "Undo intended"
                                    : "This change is intended"}
                            </Button>
                        )}
                        {finding.reproducible && (
                            <ReproduceFinding
                                runId={runId}
                                probeId={finding.probeId}
                                entryPoint={finding.entryPoint}
                            />
                        )}
                        {finding.reviewHref && (
                            <Link
                                href={finding.reviewHref}
                                className="text-primary-light inline-flex min-h-8 items-center text-sm underline-offset-2 hover:underline">
                                Kody&apos;s review comment
                            </Link>
                        )}
                        {onVote && (
                            <span className="ml-auto flex items-center gap-2">
                                <span className="text-text-secondary text-xs">
                                    Was this useful?
                                </span>
                                <PathFeedback
                                    feedback={feedback}
                                    onVote={onVote}
                                    pending={votePending}
                                    entryPoint={finding.entryPoint}
                                />
                            </span>
                        )}
                    </div>
                </div>
            </details>
        </article>
    );
};

/** The Findings section body: the first finding open, the others one row each; or the empty state. */
export const RunFindingsView = ({
    runId,
    findings,
    live,
    feedback,
    onVote,
    votePendingFor,
    onMarkIntended,
    intentPendingFor,
    baseLabel: recordedBaseLabel,
    compared = true,
    newEndpoints = 0,
    missing = false,
    pullRequestUrl,
    bootFailure,
}: {
    runId: string;
    findings: Finding[];
    baseLabel?: string;
    pullRequestUrl?: string;
    bootFailure?: BootFailureView;
    live?: boolean;
    /** Main and this PR answered on at least one path; false when nothing was compared. */
    compared?: boolean;
    /** Paths that are routes this PR adds (main has none): they differ by design, so "answered the same" is not said of them. */
    newEndpoints?: number;
    /** The verdict counted findings this Run's record does not carry. */
    missing?: boolean;
    feedback?: Record<string, FindingFeedback>;
    onVote?: (probeId: string, value: FindingFeedbackValue | null) => void;
    votePendingFor?: string;
    onMarkIntended?: (probeId: string, intended: boolean) => void;
    intentPendingFor?: string;
}) => {
    const baseLabel =
        recordedBaseLabel ?? findings[0]?.baseLabel ?? baseVersionLabel();
    if (findings.length === 0) {
        const [title, body] = missing
            ? [
                  "The finding is not in this Run's record yet",
                  "The check counted a regression, but the request and both answers are not here. Kody's comment on the pull request has what it measured.",
              ]
            : live
              ? [
                    "No findings yet",
                    `A finding shows here first as soon as ${baseLabel} and this PR answer differently.`,
                ]
              : compared
                ? [
                      "No findings",
                      newEndpoints > 0
                          ? `Apart from the ${newEndpoints === 1 ? "route" : `${newEndpoints} routes`} this PR adds, which ${baseLabel} does not have (What Kody tested), ${baseLabel} and this PR answered the same on every path Kody reached. A finding would show here first, with the request, what ${baseLabel} and this PR answered, and a command to reproduce it.`
                          : `On every path Kody reached, ${baseLabel} and this PR answered the same. A finding would show here first, with the request, what ${baseLabel} and this PR answered, and a command to reproduce it.`,
                  ]
                : [
                      "Nothing was compared",
                      `Kody got no answer from ${baseLabel} and this PR on the same path, so there is no finding either way. What Kody tested says why.`,
                  ];
        return (
            <div className="bg-card-lv2 flex flex-col gap-1 rounded-xl px-4 py-4">
                <span className="text-text-primary text-sm font-medium">
                    {title}
                </span>
                <span className="text-text-secondary text-sm">{body}</span>
            </div>
        );
    }
    return (
        <div className="flex flex-col gap-4">
            {findings.map((f, i) => (
                <FindingCard
                    key={`${f.probeId}::${f.entryPoint}`}
                    runId={runId}
                    finding={f}
                    defaultOpen={i === 0}
                    pullRequestUrl={pullRequestUrl}
                    bootFailure={bootFailure}
                    feedback={feedback?.[f.probeId]}
                    onVote={onVote && ((value) => onVote(f.probeId, value))}
                    votePending={votePendingFor === f.probeId}
                    onMarkIntended={
                        onMarkIntended &&
                        ((intended) => onMarkIntended(f.probeId, intended))
                    }
                    intentPending={intentPendingFor === f.probeId}
                />
            ))}
        </div>
    );
};
