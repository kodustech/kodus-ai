"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@components/ui/button";
import { Input } from "@components/ui/input";
import { Switch } from "@components/ui/switch";
import {
    knowledgeChoices,
    normalizeKnowledgePath,
    setAgentKnowledge,
} from "@services/custom-agents/drafts";
import type {
    CustomAgentResolveReport,
    KnowledgeItem,
    KnowledgeItemReport,
} from "@services/custom-agents/types";
import { BookOpenIcon, PlusIcon, SparklesIcon } from "lucide-react";

import { Chip, Choice, Field, Section } from "./field";

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
 * The skills and docs one agent follows, chosen on the agent itself: every
 * file the config has or the branch offers, each with its own switch, and a
 * path field for one that was not found.
 */
export const AgentKnowledgeField = ({
    agentId,
    knowledge,
    report,
    canEdit,
    onChange,
}: {
    agentId: string;
    knowledge: KnowledgeItem[];
    report?: CustomAgentResolveReport;
    canEdit: boolean;
    onChange: (next: KnowledgeItem[]) => void;
}) => {
    const [path, setPath] = useState("");
    const [kind, setKind] = useState<KnowledgeItem["kind"]>("doc");
    const resolved =
        report?.knowledge.status === "ok" ? report.knowledge : null;
    const choices = knowledgeChoices(
        knowledge,
        resolved?.candidates ?? [],
        agentId,
    );
    const reportOf = (item: Pick<KnowledgeItem, "path" | "kind">) =>
        resolved?.items.find(
            (entry) => entry.path === item.path && entry.kind === item.kind,
        );
    const budget = resolved?.budgets.find((entry) => entry.target === agentId);
    const addPath = () => {
        const next = normalizeKnowledgePath(path);
        if (!next) return;
        onChange(
            setAgentKnowledge(knowledge, { path: next, kind }, agentId, true),
        );
        setPath("");
    };
    const addId = `agent-${agentId}-knowledge-path`;

    return (
        <div className="flex flex-col gap-3">
            {report?.knowledge.status === "unavailable" && (
                <p className="text-text-secondary text-xs">
                    {report.knowledge.reason}
                </p>
            )}
            {choices.length === 0 ? (
                <p className="text-text-secondary text-xs">
                    {resolved
                        ? "No skills or docs found on the branch. Add one by path below."
                        : "None yet. Add one by path below."}
                </p>
            ) : (
                <div className="border-card-lv3/60 divide-card-lv3/60 flex flex-col divide-y rounded-lg border">
                    {choices.map((choice) => {
                        const id = `agent-${agentId}-use-${choice.kind}-${choice.path}`;
                        const itemReport = reportOf(choice);
                        return (
                            <div
                                key={`${choice.kind}:${choice.path}`}
                                className="flex items-start gap-2 px-3 py-2">
                                {choice.kind === "skill" ? (
                                    <SparklesIcon
                                        aria-label="Skill"
                                        className="text-text-tertiary mt-0.5 size-4 shrink-0"
                                    />
                                ) : (
                                    <BookOpenIcon
                                        aria-label="Doc"
                                        className="text-text-tertiary mt-0.5 size-4 shrink-0"
                                    />
                                )}
                                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                                    <span className="text-text-primary text-xs font-medium">
                                        {itemReport?.name ??
                                            choice.name ??
                                            choice.path}
                                    </span>
                                    <span className="text-text-tertiary truncate font-mono text-xs">
                                        {choice.path}
                                    </span>
                                    <span className="flex flex-wrap gap-1">
                                        <KnowledgeStatusChips
                                            report={itemReport}
                                        />
                                        {!itemReport &&
                                            choice.kodyRuleSource && (
                                                <Chip tone="warning">
                                                    Also a Kody Rules source
                                                </Chip>
                                            )}
                                    </span>
                                </span>
                                <span className="flex shrink-0 items-center gap-2 self-center">
                                    <label
                                        htmlFor={id}
                                        className="text-text-secondary cursor-pointer text-xs">
                                        Use
                                    </label>
                                    <Switch
                                        id={id}
                                        size="sm"
                                        checked={choice.linked}
                                        disabled={!canEdit}
                                        onCheckedChange={(on) =>
                                            onChange(
                                                setAgentKnowledge(
                                                    knowledge,
                                                    choice,
                                                    agentId,
                                                    on,
                                                ),
                                            )
                                        }
                                    />
                                </span>
                            </div>
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
            <Field
                label="Add by path"
                htmlFor={addId}
                hint="A Markdown doc, or a skill folder with a SKILL.md, on the target branch.">
                <div className="flex flex-wrap items-center gap-2">
                    <div className="min-w-[12rem] flex-1">
                        <Input
                            id={addId}
                            size="md"
                            placeholder="e.g. docs/payments.md or .claude/skills/ledger"
                            value={path}
                            disabled={!canEdit}
                            onChange={(e) => setPath(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key !== "Enter") return;
                                e.preventDefault();
                                addPath();
                            }}
                        />
                    </div>
                    <Choice
                        value={kind}
                        disabled={!canEdit}
                        onChange={setKind}
                        options={[
                            { value: "doc", label: "Doc" },
                            { value: "skill", label: "Skill" },
                        ]}
                    />
                    <Button
                        size="sm"
                        variant="helper"
                        leftIcon={<PlusIcon />}
                        disabled={!canEdit || !normalizeKnowledgePath(path)}
                        onClick={addPath}>
                        Add
                    </Button>
                </div>
            </Field>
        </div>
    );
};

/** The agent page's card around the same field. */
export const KnowledgeCard = ({
    skillsHref,
    ...props
}: Parameters<typeof AgentKnowledgeField>[0] & { skillsHref: string }) => (
    <Section
        title="Skills and docs this agent follows"
        description={
            <>
                Read from the pull request&apos;s target branch. Skills open on
                demand; docs load whole up to the budget. Scripts in a skill
                never run.{" "}
                <Link
                    href={skillsHref}
                    className="text-primary-light hover:underline">
                    Skills &amp; docs for the main review
                </Link>
            </>
        }>
        <AgentKnowledgeField {...props} />
    </Section>
);
