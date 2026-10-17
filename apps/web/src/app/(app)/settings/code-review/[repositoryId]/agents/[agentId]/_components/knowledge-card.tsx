"use client";

import Link from "next/link";
import { Checkbox } from "@components/ui/checkbox";
import { isLinked, setKnowledgeLink } from "@services/custom-agents/drafts";
import type {
    CustomAgentResolveReport,
    KnowledgeItem,
    KnowledgeItemReport,
} from "@services/custom-agents/types";
import { BookOpenIcon, SparklesIcon } from "lucide-react";

import { Chip, Section } from "./field";

export const KnowledgeStatusChips = ({
    report,
}: {
    report?: KnowledgeItemReport;
}) => {
    if (!report) return null;
    const errors = report.issues.filter((issue) => issue.severity === "error");
    const warnings = report.issues.filter(
        (issue) => issue.severity === "warning",
    );
    return (
        <>
            {!report.found && <Chip tone="danger">Not on the branch</Chip>}
            {errors.length > 0 && (
                <Chip tone="danger">
                    {errors.length} {errors.length === 1 ? "error" : "errors"}
                </Chip>
            )}
            {warnings.length > 0 && (
                <Chip tone="warning">
                    {warnings.length}{" "}
                    {warnings.length === 1 ? "warning" : "warnings"}
                </Chip>
            )}
            {typeof report.tokens === "number" && (
                <Chip>{report.tokens.toLocaleString()} tokens</Chip>
            )}
            {report.kodyRuleSource && (
                <Chip tone="warning">Also a Kody Rules source</Chip>
            )}
        </>
    );
};

/**
 * Which registered skills and docs this agent loads. Registering a new one
 * happens on the Skills & docs page, where it can also go to the main
 * review.
 */
export const KnowledgeCard = ({
    agentId,
    knowledge,
    report,
    canEdit,
    skillsHref,
    onChange,
}: {
    agentId: string;
    knowledge: KnowledgeItem[];
    report?: CustomAgentResolveReport;
    canEdit: boolean;
    skillsHref: string;
    onChange: (next: KnowledgeItem[]) => void;
}) => {
    const reportOf = (path: string) =>
        report?.knowledge.status === "ok"
            ? report.knowledge.items.find((item) => item.path === path)
            : undefined;
    const budget =
        report?.knowledge.status === "ok"
            ? report.knowledge.budgets.find((entry) => entry.target === agentId)
            : undefined;

    return (
        <Section
            title="Skills and docs"
            description={
                <>
                    Read from the pull request&apos;s target branch. Skills open
                    on demand; docs load whole up to the budget. Scripts in a
                    skill never run.{" "}
                    <Link
                        href={skillsHref}
                        className="text-primary-light hover:underline">
                        Manage skills &amp; docs
                    </Link>
                </>
            }>
            {knowledge.length === 0 ? (
                <p className="text-text-secondary text-xs">
                    Nothing registered yet. Add skills and docs from the
                    repository on the Skills &amp; docs page.
                </p>
            ) : (
                <div className="flex flex-col gap-2">
                    {knowledge.map((item) => {
                        const id = `knowledge-${item.kind}-${item.path}`;
                        const itemReport = reportOf(item.path);
                        return (
                            <label
                                key={id}
                                htmlFor={id}
                                className="flex cursor-pointer items-start gap-2">
                                <Checkbox
                                    id={id}
                                    disabled={!canEdit}
                                    checked={isLinked(item, { agentId })}
                                    onCheckedChange={(checked) =>
                                        onChange(
                                            setKnowledgeLink(
                                                knowledge,
                                                item,
                                                { agentId },
                                                checked === true,
                                            ),
                                        )
                                    }
                                />
                                {item.kind === "skill" ? (
                                    <SparklesIcon className="text-text-tertiary mt-0.5 size-4 shrink-0" />
                                ) : (
                                    <BookOpenIcon className="text-text-tertiary mt-0.5 size-4 shrink-0" />
                                )}
                                <span className="flex min-w-0 flex-col gap-0.5">
                                    <span className="text-text-primary text-xs font-medium">
                                        {itemReport?.name ?? item.path}
                                    </span>
                                    <span className="text-text-tertiary truncate font-mono text-xs">
                                        {item.path}
                                    </span>
                                    <span className="flex flex-wrap gap-1">
                                        <KnowledgeStatusChips
                                            report={itemReport}
                                        />
                                    </span>
                                </span>
                            </label>
                        );
                    })}
                </div>
            )}
            {budget && budget.over.length > 0 && (
                <p className="text-warning text-xs">
                    Over the limit for this agent ({budget.over.join(", ")}):{" "}
                    {budget.skills} skills, {budget.docs} docs,{" "}
                    {budget.docTokens.toLocaleString()} doc tokens.
                </p>
            )}
            {report?.knowledge.status === "unavailable" && (
                <p className="text-warning text-xs">
                    {report.knowledge.reason}
                </p>
            )}
        </Section>
    );
};
