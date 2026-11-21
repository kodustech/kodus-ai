"use client";

import type { ComponentProps, ReactNode } from "react";
import NextLink from "next/link";
import { StatusChip } from "@components/runtime/status-chip";
import { Button } from "@components/ui/button";
import { toast } from "@components/ui/toaster/use-toast";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@components/ui/tooltip";
import { usePermissionOnEvery } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import { shortRepositoryName } from "@services/runtime/format";
import type { Tone } from "@services/runtime/labels";
import { runtimeErrorMessage } from "@services/runtime/model/errors";
import {
    environmentNameOf,
    failureWords,
    mainRunOf,
    otherEnvironmentsOf,
    otherEnvironmentWords,
    queuedRunCount,
    requestRunRepositoryIds,
    runHref,
    type PrRuntime,
    type PrRuntimeCell,
} from "@services/runtime/model/pull-request-runs";
import { useRequestPullRequestRun } from "@services/runtime/pull-request-runs";
import { PlayIcon } from "lucide-react";
import { cn } from "src/core/utils/components";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** A chip that opens the Run; the row underneath does not expand. */
const RunChip = ({
    runId,
    tone,
    live,
    children,
}: {
    runId: string;
    tone: Tone;
    live?: boolean;
    children: ReactNode;
}) => (
    <NextLink
        href={runHref(runId)}
        onClick={(e) => e.stopPropagation()}
        className="focus-visible:ring-ring w-fit max-w-full rounded-md hover:brightness-125 focus-visible:ring-2 focus-visible:outline-none">
        <StatusChip tone={tone} className="max-w-full gap-1.5">
            {live && (
                <span
                    aria-hidden
                    className="bg-info size-1.5 shrink-0 animate-pulse rounded-full"
                />
            )}
            <span className="truncate">{children}</span>
        </StatusChip>
    </NextLink>
);

/**
 * "Run on this PR": a Run on the PR's current head. Hidden (`fallback`
 * instead) for whoever may not start Runs on every repository of the
 * environments that would run (`repositoryIds`, requestRunRepositoryIds):
 * the machine holds all their code. The screen stays where it is: the row
 * (or the card) turns into the live Run once the list refreshes.
 */
export const RequestRunButton = ({
    repositoryId,
    prNumber,
    repositoryIds,
    fallback = null,
    label = "Run on this PR",
    size = "xs",
    iconOnly = false,
}: {
    repositoryId: string;
    prNumber: number;
    /** Every repository the Run would hold; the PR's own when absent. */
    repositoryIds?: readonly string[];
    fallback?: ReactNode;
    label?: string;
    size?: ComponentProps<typeof Button>["size"];
    /** A play icon with the label as its name: for a list where every row could offer it. */
    iconOnly?: boolean;
}) => {
    const request = useRequestPullRequestRun();
    const allowed = usePermissionOnEvery(
        Action.Create,
        ResourceType.RuntimeRun,
        repositoryIds?.length ? repositoryIds : [repositoryId],
    );
    if (!allowed) return <>{fallback}</>;
    return (
        <Button
            size={iconOnly ? "icon-xs" : size}
            variant="helper"
            aria-label={iconOnly ? label : undefined}
            title={iconOnly ? label : undefined}
            leftIcon={iconOnly ? undefined : <PlayIcon />}
            loading={request.isPending}
            onClick={(e) => {
                e.stopPropagation();
                // No environment named: the API starts one Run per
                // environment that runs this repository's pull requests.
                request.mutate(
                    { repositoryId, prNumber },
                    {
                        onSuccess: (answer) => {
                            const n = queuedRunCount(answer);
                            toast({
                                variant: "success",
                                title:
                                    n > 1 ? `${n} runs queued` : "Run queued",
                                description:
                                    n > 1
                                        ? `One in each environment that runs this repository's pull requests, on the latest commit.`
                                        : "Kody Runtime runs it on the latest commit of this pull request.",
                            });
                        },
                        onError: (error) =>
                            toast({
                                variant: "danger",
                                title: "Couldn't start a run",
                                description: runtimeErrorMessage(error, {
                                    fallback: "Try again in a moment.",
                                    403: "Only people allowed to start Runs on every repository of this environment can start one.",
                                }),
                            }),
                    },
                );
            }}>
            {iconOnly ? <PlayIcon /> : label}
        </Button>
    );
};

const envName = (name: string) => shortRepositoryName(name) ?? name;

/**
 * "+N environments": the other systems the PR's repository is part of, each
 * with its own latest verdict, on hover or focus. Nothing for one
 * environment.
 */
export const OtherEnvironmentsHint = ({
    runtime,
}: {
    runtime: PrRuntime | undefined;
}) => {
    const others = runtime ? otherEnvironmentsOf(runtime) : [];
    if (!others.length) return null;
    const lines = others.map(
        (o) => `${envName(o.name)}: ${otherEnvironmentWords(o)}`,
    );
    const text = `+${others.length} environment${others.length === 1 ? "" : "s"}`;
    return (
        <Tooltip>
            <TooltipTrigger
                type="button"
                onClick={(e) => e.stopPropagation()}
                aria-label={`${text}. ${lines.join(". ")}.`}
                className="text-text-tertiary hover:text-text-secondary focus-visible:ring-ring w-fit rounded text-xs underline decoration-dotted underline-offset-2 focus-visible:ring-2 focus-visible:outline-none">
                {text}
            </TooltipTrigger>
            <TooltipContent>
                <ul className="flex flex-col gap-0.5">
                    {others.map((o, i) => (
                        <li key={o.environmentId}>
                            {o.run ? (
                                <NextLink
                                    href={runHref(o.run.runId)}
                                    className="hover:underline">
                                    {lines[i]}
                                </NextLink>
                            ) : (
                                lines[i]
                            )}
                        </li>
                    ))}
                </ul>
            </TooltipContent>
        </Tooltip>
    );
};

/**
 * The environment the shown verdict is of, when it is not the PR's main
 * one (its Run there is not among the latest the answer carries).
 */
export const shownEnvironmentNote = (runtime: PrRuntime | undefined) => {
    if (!runtime?.environments?.length) return undefined;
    const run = mainRunOf(runtime);
    if (!run || run.environmentId === runtime.environment?.environmentId)
        return undefined;
    const name = environmentNameOf(runtime, run.environmentId);
    return name ? `in ${envName(name)}` : undefined;
};

/** What the Runtime column of the list shows for one PR. */
export const PrRuntimeColumn = ({
    cell,
    repositoryId,
    prNumber,
    runtime,
    onRetry,
}: {
    /** Absent while the page's Runtime state loads. */
    cell: PrRuntimeCell | undefined;
    repositoryId: string;
    prNumber: number;
    /** The PR's answer: its other environments, when it has several. */
    runtime?: PrRuntime;
    /** Asks again when the state could not be read. */
    onRetry?: () => void;
}) => {
    if (!cell)
        return (
            <span
                aria-hidden
                className="bg-card-lv3/40 h-4 w-20 animate-pulse rounded"
            />
        );
    const stale =
        "stale" in cell && cell.stale ? (
            <span className="text-text-tertiary truncate text-xs">
                on <span className="font-mono">{cell.stale}</span> · latest not
                run
            </span>
        ) : null;
    let main: ReactNode;
    switch (cell.kind) {
        case "no_environment":
            return (
                <span
                    className="text-text-tertiary text-xs"
                    title="This repository has no Kody Runtime environment">
                    —
                </span>
            );
        case "unavailable":
            return (
                <span className="flex items-center gap-1.5">
                    <span
                        className="text-warning text-xs"
                        title="Kody Runtime could not be read for this pull request">
                        Unavailable
                    </span>
                    {onRetry && (
                        <button
                            type="button"
                            className="text-text-secondary hover:text-text-primary text-xs underline"
                            onClick={(event) => {
                                // The row itself is a link: retry, do not open it.
                                event.preventDefault();
                                event.stopPropagation();
                                onRetry();
                            }}>
                            Retry
                        </button>
                    )}
                </span>
            );
        case "not_run": {
            const notRun = (
                <span className="text-text-tertiary text-xs">Not run</span>
            );
            // Every row of a list can offer a Run: a quiet "Not run" and a
            // play icon, not a labelled button repeated down the column.
            main = cell.canRequest ? (
                <span className="flex items-center gap-2">
                    {notRun}
                    <RequestRunButton
                        repositoryId={repositoryId}
                        prNumber={prNumber}
                        repositoryIds={
                            runtime
                                ? requestRunRepositoryIds(runtime)
                                : undefined
                        }
                        iconOnly
                    />
                </span>
            ) : (
                <>
                    {notRun}
                    {cell.reason && (
                        <span
                            className="text-text-tertiary truncate text-xs"
                            title={cell.reason}>
                            {cell.reason}
                        </span>
                    )}
                </>
            );
            break;
        }
        case "regression":
            main = (
                <RunChip runId={cell.runId} tone="danger">
                    {failureWords(cell)}
                </RunChip>
            );
            break;
        case "clean":
            main = (
                <RunChip runId={cell.runId} tone="success">
                    No regression · {plural(cell.probes, "probe")}
                </RunChip>
            );
            break;
        case "running":
            main = (
                <RunChip runId={cell.runId} tone="info" live>
                    Running · {cell.label}
                </RunChip>
            );
            break;
        case "could_not_boot":
            main = (
                <RunChip runId={cell.runId} tone="warning">
                    Could not boot{cell.where ? ` · ${cell.where}` : ""}
                </RunChip>
            );
            break;
        case "other":
            main = (
                <RunChip runId={cell.runId} tone={cell.tone}>
                    {cell.label}
                </RunChip>
            );
            break;
    }
    const shownIn = shownEnvironmentNote(runtime);
    return (
        <div className={cn("flex min-w-0 flex-col gap-0.5")}>
            {main}
            {stale}
            {shownIn && (
                <span className="text-text-tertiary truncate text-xs">
                    {shownIn}
                </span>
            )}
            <OtherEnvironmentsHint runtime={runtime} />
        </div>
    );
};
