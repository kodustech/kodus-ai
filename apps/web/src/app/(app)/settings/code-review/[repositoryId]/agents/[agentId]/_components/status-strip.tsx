"use client";

import { Card } from "@components/ui/card";
import { Skeleton } from "@components/ui/skeleton";
import { Switch } from "@components/ui/switch";
import { agentStatusLine } from "@services/custom-agents/drafts";
import type {
    CustomAgent,
    CustomAgentResolveReport,
    CustomAgentStatus,
} from "@services/custom-agents/types";
import { CircleAlertIcon } from "lucide-react";
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
            if (!item.found) {
                problems.push(
                    `${item.path} is not on ${report.repository.branch}; a pull request into another branch may still have it`,
                );
            }
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
 * The agent page's one status line: the switch that turns the agent on,
 * where it runs and how it did lately, and anything that would stop a run.
 * How a review went belongs to the pull request; this answers the person
 * setting the agent up.
 */
export const StatusStrip = ({
    agent,
    status,
    windowDays,
    isLoading,
    report,
    isGlobal,
    canEdit,
    onEnabledChange,
}: {
    agent: CustomAgent;
    status?: CustomAgentStatus;
    windowDays: number;
    isLoading: boolean;
    report?: CustomAgentResolveReport;
    isGlobal: boolean;
    canEdit: boolean;
    onEnabledChange: (enabled: boolean) => void;
}) => {
    const problems = draftProblems(report);

    return (
        <Card
            color="lv1"
            data-testid="agent-status"
            className={cn(
                "flex flex-col gap-1.5 px-5 py-3.5",
                problems.length > 0 && "ring-warning/40 ring-1",
            )}>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                <Switch
                    size="sm"
                    aria-label="Agent enabled"
                    checked={agent.enabled}
                    disabled={!canEdit}
                    onCheckedChange={onEnabledChange}
                />
                <span className="text-text-primary font-medium">
                    {agent.enabled ? "On" : "Off"}
                </span>
                {problems.length > 0 && (
                    <span className="text-warning flex items-center gap-1">
                        <CircleAlertIcon className="size-4" aria-hidden />
                        {problems.length}{" "}
                        {problems.length === 1 ? "problem" : "problems"}
                    </span>
                )}
                {isLoading ? (
                    <Skeleton className="h-4 w-64" />
                ) : (
                    <span className="text-text-secondary min-w-0">
                        {agentStatusLine(agent, status, windowDays, isGlobal)}
                    </span>
                )}
            </div>
            {problems.slice(0, 5).map((problem) => (
                <p key={problem} className="text-warning pl-12 text-xs">
                    {problem}
                </p>
            ))}
        </Card>
    );
};
