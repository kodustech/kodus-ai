"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@components/ui/button";
import { Input } from "@components/ui/input";
import {
    followedBy,
    knowledgeChoices,
    knowledgeItemFromPath,
    setAgentKnowledge,
    skillFolderName,
} from "@services/custom-agents/drafts";
import type {
    CustomAgentResolveReport,
    KnowledgeItem,
    KnowledgeItemReport,
} from "@services/custom-agents/types";
import { BookOpenIcon, PlusIcon, SparklesIcon, XIcon } from "lucide-react";
import { cn } from "src/core/utils/components";

import { Chip, Field, Section } from "./field";

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
            {/* The editor reads the default branch; a review reads each pull
                request's target branch, which may have the file. */}
            {!report.found && (
                <Chip tone="warning">Not on the default branch</Chip>
            )}
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
 * The skills and docs one agent follows: only what it follows, each with a
 * way to stop, and a picker to add what the branch offers or a path typed
 * by hand. Skills open on demand; docs load whole.
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
    const [adding, setAdding] = useState(false);
    const resolved =
        report?.knowledge.status === "ok" ? report.knowledge : null;
    const unavailable =
        report?.knowledge.status === "unavailable"
            ? report.knowledge.reason
            : null;
    const candidates = resolved?.candidates ?? [];
    const reportOf = (item: Pick<KnowledgeItem, "path" | "kind">) =>
        resolved?.items.find(
            (entry) => entry.path === item.path && entry.kind === item.kind,
        );
    const candidateOf = (item: Pick<KnowledgeItem, "path" | "kind">) =>
        candidates.find(
            (entry) => entry.path === item.path && entry.kind === item.kind,
        );
    const named = [...(resolved?.items ?? []), ...candidates];
    const { skills, docs } = followedBy(knowledge, agentId, named);
    const available = knowledgeChoices(knowledge, candidates, agentId).filter(
        (choice) => !choice.linked,
    );
    const budget = resolved?.budgets.find((entry) => entry.target === agentId);
    const follow = (item: Pick<KnowledgeItem, "path" | "kind">, on: boolean) =>
        onChange(setAgentKnowledge(knowledge, item, agentId, on));
    const descriptionOf = (item: Pick<KnowledgeItem, "path" | "kind">) =>
        reportOf(item)?.description ?? candidateOf(item)?.description;

    return (
        <div className="flex flex-col gap-3">
            {unavailable && (
                <p className="text-text-secondary text-xs">{unavailable}</p>
            )}
            {skills.length === 0 && docs.length === 0 ? (
                <p className="text-text-secondary text-xs">
                    Not following any skill or doc yet.
                </p>
            ) : (
                <ul className="flex flex-col gap-1.5">
                    {skills.map((skill) => (
                        <li
                            key={`skill:${skill.path}`}
                            className="bg-card-lv2 flex items-start gap-2 rounded-lg px-3 py-2">
                            <SparklesIcon
                                aria-hidden
                                className="text-text-tertiary mt-0.5 size-4 shrink-0"
                            />
                            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                                <span className="text-text-primary text-xs font-medium">
                                    {skill.name}
                                </span>
                                {descriptionOf(skill) && (
                                    <span className="text-text-secondary text-xs">
                                        {descriptionOf(skill)}
                                    </span>
                                )}
                                <span className="text-text-tertiary truncate font-mono text-xs">
                                    {skill.path}
                                </span>
                                <span className="flex flex-wrap gap-1 empty:hidden">
                                    <KnowledgeStatusChips
                                        report={reportOf(skill)}
                                    />
                                </span>
                            </span>
                            <StopFollowing
                                name={skill.name}
                                disabled={!canEdit}
                                onClick={() => follow(skill, false)}
                            />
                        </li>
                    ))}
                    {docs.map((doc) => (
                        <li
                            key={`doc:${doc.path}`}
                            className="flex items-center gap-2 px-3 py-1">
                            <BookOpenIcon
                                aria-hidden
                                className="text-text-tertiary size-4 shrink-0"
                            />
                            <span className="text-text-primary min-w-0 flex-1 truncate font-mono text-xs">
                                {doc.path}
                            </span>
                            <span className="flex shrink-0 flex-wrap gap-1">
                                <KnowledgeStatusChips report={reportOf(doc)} />
                            </span>
                            <StopFollowing
                                name={doc.path}
                                disabled={!canEdit}
                                onClick={() => follow(doc, false)}
                            />
                        </li>
                    ))}
                </ul>
            )}
            {budget && budget.over.length > 0 && (
                <p className="text-warning text-xs">
                    Over the limit for this agent ({budget.over.join(", ")}):{" "}
                    {budget.skills} skills, {budget.docs} docs,{" "}
                    {budget.docTokens.toLocaleString()} doc tokens.
                </p>
            )}
            {unavailable ? (
                <AddByPath
                    agentId={agentId}
                    disabled={!canEdit}
                    onAdd={(item) => follow(item, true)}
                />
            ) : adding ? (
                <div className="border-card-lv3/60 flex flex-col gap-3 border-t pt-3">
                    {!resolved ? (
                        <p className="text-text-secondary text-xs">
                            Reading the branch…
                        </p>
                    ) : available.length === 0 ? (
                        <p className="text-text-secondary text-xs">
                            Nothing else found on the branch. Add one by path.
                        </p>
                    ) : (
                        <ul className="flex flex-col gap-1">
                            {available.map((choice) => {
                                const name =
                                    choice.kind === "skill"
                                        ? (reportOf(choice)?.name ??
                                          choice.name ??
                                          skillFolderName(choice.path))
                                        : choice.path;
                                const description = descriptionOf(choice);
                                return (
                                    <li key={`${choice.kind}:${choice.path}`}>
                                        <button
                                            type="button"
                                            aria-label={`Follow ${name}`}
                                            disabled={!canEdit}
                                            onClick={() => follow(choice, true)}
                                            className="hover:bg-card-lv2 flex w-full items-start gap-2 rounded-lg px-3 py-2 text-left disabled:opacity-60">
                                            {choice.kind === "skill" ? (
                                                <SparklesIcon
                                                    aria-hidden
                                                    className="text-text-tertiary mt-0.5 size-4 shrink-0"
                                                />
                                            ) : (
                                                <BookOpenIcon
                                                    aria-hidden
                                                    className="text-text-tertiary mt-0.5 size-4 shrink-0"
                                                />
                                            )}
                                            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                                                <span
                                                    className={cn(
                                                        "text-text-primary text-xs font-medium",
                                                        choice.kind === "doc" &&
                                                            "font-mono",
                                                    )}>
                                                    {name}
                                                </span>
                                                {description && (
                                                    <span className="text-text-secondary text-xs">
                                                        {description}
                                                    </span>
                                                )}
                                                {choice.kodyRuleSource && (
                                                    <span className="text-warning text-xs">
                                                        Also a Kody Rules source
                                                    </span>
                                                )}
                                            </span>
                                            <PlusIcon
                                                aria-hidden
                                                className="text-text-secondary mt-0.5 size-4 shrink-0"
                                            />
                                        </button>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                    <AddByPath
                        agentId={agentId}
                        disabled={!canEdit}
                        onAdd={(item) => follow(item, true)}
                    />
                    <Button
                        size="xs"
                        variant="helper"
                        className="w-fit"
                        onClick={() => setAdding(false)}>
                        Done
                    </Button>
                </div>
            ) : (
                canEdit && (
                    <Button
                        size="xs"
                        variant="helper"
                        className="w-fit"
                        leftIcon={<PlusIcon />}
                        onClick={() => setAdding(true)}>
                        Add skill or doc
                    </Button>
                )
            )}
        </div>
    );
};

const StopFollowing = ({
    name,
    disabled,
    onClick,
}: {
    name: string;
    disabled: boolean;
    onClick: () => void;
}) => (
    <Button
        size="icon-sm"
        variant="cancel"
        className="shrink-0"
        aria-label={`Stop following ${name}`}
        disabled={disabled}
        onClick={onClick}>
        <XIcon />
    </Button>
);

/** A path typed by hand; its kind comes from the path itself. */
const AddByPath = ({
    agentId,
    disabled,
    onAdd,
}: {
    agentId: string;
    disabled: boolean;
    onAdd: (item: Pick<KnowledgeItem, "path" | "kind">) => void;
}) => {
    const [path, setPath] = useState("");
    const item = knowledgeItemFromPath(path);
    const add = () => {
        if (!item) return;
        onAdd(item);
        setPath("");
    };
    const id = `agent-${agentId}-knowledge-path`;
    return (
        <Field
            label="Add by path"
            htmlFor={id}
            hint={
                item
                    ? `Adds the ${item.kind} ${item.path}`
                    : "A doc file (e.g. docs/payments.md), or a skill folder with a SKILL.md, on the target branch."
            }>
            <div className="flex flex-wrap items-center gap-2">
                <div className="min-w-[12rem] flex-1">
                    <Input
                        id={id}
                        size="md"
                        placeholder="e.g. docs/payments.md or .claude/skills/ledger"
                        value={path}
                        disabled={disabled}
                        onChange={(e) => setPath(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key !== "Enter") return;
                            e.preventDefault();
                            add();
                        }}
                    />
                </div>
                <Button
                    size="sm"
                    variant="helper"
                    leftIcon={<PlusIcon />}
                    aria-label={item ? `Add ${item.path}` : "Add path"}
                    disabled={disabled || !item}
                    onClick={add}>
                    Add
                </Button>
            </div>
        </Field>
    );
};

/** The agent page's card around the same field. */
export const KnowledgeCard = ({
    skillsHref,
    ...props
}: Parameters<typeof AgentKnowledgeField>[0] & { skillsHref: string }) => (
    <Section
        title="Follows"
        description={
            <>
                The team&apos;s skills and docs this reviewer follows, read from
                the pull request&apos;s target branch. A skill opens when the
                change needs it; a doc loads whole. Scripts in a skill never
                run.{" "}
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
