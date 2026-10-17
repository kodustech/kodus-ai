"use client";

import { Card } from "@components/ui/card";
import { Skeleton } from "@components/ui/skeleton";
import type {
    CustomAgent,
    CustomAgentResolveReport,
    CustomAgentStatus,
} from "@services/custom-agents/types";
import {
    CircleAlertIcon,
    CircleCheckIcon,
    CircleDashedIcon,
    EyeOffIcon,
    PauseCircleIcon,
} from "lucide-react";
import { cn } from "src/core/utils/components";

/** Problems with the draft that would stop or degrade a run. */
export const draftProblems = (report?: CustomAgentResolveReport) => {
    if (!report) return [];
    const problems = [...report.agentIssues];
    problems.push(
        ...report.astGrep.errors.map((error) => `ast-grep: ${error}`),
    );
    if (report.knowledge.status === "ok") {
        for (const item of report.knowledge.items) {
            if (!item.found) problems.push(`${item.path} not found`);
            for (const issue of item.issues) {
                if (issue.severity === "error") {
                    problems.push(`${item.path}: ${issue.message}`);
                }
            }
        }
    }
    return problems;
};

/**
 * Is the agent running, and how it did. How a review went belongs to the
 * pull request; this answers the person setting the agent up.
 */
export const StatusStrip = ({
    agent,
    status,
    windowDays,
    isLoading,
    report,
    isGlobal,
}: {
    agent: CustomAgent;
    status?: CustomAgentStatus;
    windowDays: number;
    isLoading: boolean;
    report?: CustomAgentResolveReport;
    isGlobal: boolean;
}) => {
    if (isLoading) return <Skeleton className="h-14 w-full rounded-xl" />;

    const problems = draftProblems(report);
    const idle = !status || status.pullRequests === 0;
    const shadow = agent.presentation.mode === "shadow";

    const headline = !agent.enabled
        ? "Off · this agent doesn't run"
        : problems.length
          ? `Needs attention · ${problems.length} ${problems.length === 1 ? "problem" : "problems"}`
          : isGlobal
            ? "On · runs on every repository that inherits it"
            : idle
              ? `No findings in the last ${windowDays} days`
              : shadow
                ? "Running in shadow"
                : "Posting";

    return (
        <Card
            color="lv1"
            className={cn(
                "flex flex-col gap-1.5 px-5 py-3.5",
                problems.length > 0 && "ring-warning/40 ring-1",
            )}>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                {!agent.enabled ? (
                    <PauseCircleIcon className="text-text-tertiary size-4" />
                ) : problems.length ? (
                    <CircleAlertIcon className="text-warning size-4" />
                ) : idle ? (
                    <CircleDashedIcon className="text-text-tertiary size-4" />
                ) : shadow ? (
                    <EyeOffIcon className="text-text-secondary size-4" />
                ) : (
                    <CircleCheckIcon className="text-success size-4" />
                )}
                <span className="text-text-primary font-medium">
                    {headline}
                </span>
                {!idle && status && (
                    <span className="text-text-secondary">
                        · {status.pullRequests}{" "}
                        {status.pullRequests === 1 ? "PR" : "PRs"} ·{" "}
                        {status.posted} posted · {status.shadowKept} in shadow ·{" "}
                        {status.dropped} dropped in {windowDays} days
                    </span>
                )}
            </div>
            {agent.enabled && shadow && (
                <p className="text-text-secondary pl-6 text-xs">
                    Findings are kept, not posted. Switch to Post under “How it
                    comments” once they read right.
                </p>
            )}
            {problems.slice(0, 5).map((problem) => (
                <p key={problem} className="text-warning pl-6 text-xs">
                    {problem}
                </p>
            ))}
        </Card>
    );
};
