"use client";

import { Button } from "@components/ui/button";
import { Card } from "@components/ui/card";
import { Link } from "@components/ui/link";
import { Skeleton } from "@components/ui/skeleton";
import { Switch } from "@components/ui/switch";
import { agentStatusLine, runProblem } from "@services/custom-agents/drafts";
import type {
    CustomAgent,
    CustomAgentResolveReport,
    CustomAgentStatus,
} from "@services/custom-agents/types";
import { formatDistanceToNow } from "date-fns";
import { CircleAlertIcon, CircleXIcon } from "lucide-react";
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

/** Where the agent's model is picked on this page. */
export const AGENT_MODEL_FIELD_ID = "agent-model";

const focusModelField = () => {
    const field = document.getElementById(AGENT_MODEL_FIELD_ID);
    field?.scrollIntoView({ behavior: "smooth", block: "center" });
    field?.focus({ preventScroll: true });
};

/**
 * The newest runs did not finish: how many in a row, why, and the one thing
 * that fixes it. Gone once a run finishes.
 */
const RunProblemNotice = ({
    status,
    canEdit,
}: {
    status?: CustomAgentStatus;
    canEdit: boolean;
}) => {
    const problem = runProblem(status?.health);
    if (!problem || !status?.health) return null;
    const { last } = status.health;
    const when = Number.isNaN(Date.parse(last.at))
        ? ""
        : ` · ${formatDistanceToNow(new Date(last.at), { addSuffix: true })}`;
    return (
        <div
            role="status"
            className={cn(
                "flex flex-wrap items-start gap-x-3 gap-y-2 rounded-lg px-3 py-2.5",
                problem.tone === "danger" ? "bg-danger/10" : "bg-warning/10",
            )}>
            <CircleXIcon
                aria-hidden
                className={cn(
                    "mt-0.5 size-4 shrink-0",
                    problem.tone === "danger" ? "text-danger" : "text-warning",
                )}
            />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-text-primary text-sm font-medium">
                    {problem.title}
                </span>
                <span className="text-text-secondary text-xs">
                    {problem.detail} Last on PR #{last.prNumber}
                    {when}.
                </span>
            </span>
            {problem.action === "model" && canEdit && (
                <Button
                    size="xs"
                    variant="helper"
                    className="shrink-0"
                    onClick={focusModelField}>
                    Change the model
                </Button>
            )}
            {problem.action === "providers" && (
                <Link href="/byok" noHoverUnderline className="shrink-0">
                    <Button decorative size="xs" variant="helper">
                        Open AI providers
                    </Button>
                </Link>
            )}
        </div>
    );
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
    runsUnavailable,
}: {
    agent: CustomAgent;
    status?: CustomAgentStatus;
    /** The runs could not be read: a quiet line is not a healthy agent. */
    runsUnavailable?: boolean;
    windowDays: number;
    isLoading: boolean;
    report?: CustomAgentResolveReport;
    isGlobal: boolean;
    canEdit: boolean;
    onEnabledChange: (enabled: boolean) => void;
}) => {
    const problems = draftProblems(report);
    const failing = !!runProblem(status?.health);

    return (
        <Card
            color="lv1"
            data-testid="agent-status"
            className={cn(
                "flex flex-col gap-1.5 px-5 py-3.5",
                failing
                    ? "ring-danger/40 ring-1"
                    : problems.length > 0 && "ring-warning/40 ring-1",
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
            {!isGlobal && (
                <RunProblemNotice status={status} canEdit={canEdit} />
            )}
            {!isGlobal && !isLoading && runsUnavailable && (
                <p className="text-text-secondary pl-12 text-xs">
                    Could not read this agent&apos;s runs, so failed runs do not
                    show here. Reload to try again.
                </p>
            )}
            {problems.slice(0, 5).map((problem) => (
                <p key={problem} className="text-warning pl-12 text-xs">
                    {problem}
                </p>
            ))}
        </Card>
    );
};
