"use client";

import { Suspense, useState } from "react";
import {
    Breadcrumb,
    BreadcrumbItem,
    BreadcrumbLink,
    BreadcrumbList,
    BreadcrumbPage,
    BreadcrumbSeparator,
} from "@components/ui/breadcrumb";
import { Button } from "@components/ui/button";
import { Card } from "@components/ui/card";
import { Checkbox } from "@components/ui/checkbox";
import { Input } from "@components/ui/input";
import { Page } from "@components/ui/page";
import { Spinner } from "@components/ui/spinner";
import { toast } from "@components/ui/toaster/use-toast";
import {
    CUSTOM_AGENT_LIMITS,
    isLinked,
    knowledgeItemFromPath,
    setKnowledgeLink,
} from "@services/custom-agents/drafts";
import { useResolveCustomAgent } from "@services/custom-agents/hooks";
import {
    KNOWLEDGE_MAIN_REVIEW_TARGET,
    type KnowledgeItem,
    type KnowledgeLinkTarget,
} from "@services/custom-agents/types";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import { BookOpenIcon, PlusIcon, SparklesIcon, Trash2Icon } from "lucide-react";
import { useUnsavedChangesGuard } from "src/core/hooks/use-unsaved-changes-guard";

import {
    agentsListHref,
    useCustomAgentsForm,
} from "../_custom-agents/use-custom-agents-form";
import { CentralizedConfigReadOnlyAlert } from "../../_components/centralized-config-readonly-alert";
import { getCentralizedPrToastPayload } from "../../_utils/centralized-pr-feedback";
import { customAgentsSaveErrorMessage } from "../../_utils/settings-save-conflict";
import { useFeatureFlags } from "../../../_components/context";
import { KnowledgeStatusChips } from "../agents/[agentId]/_components/knowledge-card";

function SkillsContent() {
    const enabled = useFeatureFlags().customAgents === true;
    const {
        teamId,
        repositoryId,
        directoryId,
        agents,
        knowledge,
        isDirty,
        isSubmitting,
        setKnowledge,
        save,
        reset,
    } = useCustomAgentsForm();
    const canEdit = usePermission(
        Action.Update,
        ResourceType.CodeReviewSettings,
        repositoryId,
    );
    const [path, setPath] = useState("");
    const report = useResolveCustomAgent({
        teamId,
        repositoryId,
        knowledge,
        discover: true,
        enabled,
    });
    const isGlobal = repositoryId === "global";
    const knowledgeReport =
        report.data?.knowledge.status === "ok" ? report.data.knowledge : null;
    const branchLine = knowledgeReport
        ? `On ${report.data?.repository.branch}.`
        : report.isLoading
          ? "Reading the default branch…"
          : report.isError
            ? "Couldn't read the repository right now."
            : "";
    const registered = new Set(knowledge.map((item) => item.path));
    const candidates = (knowledgeReport?.candidates ?? []).filter(
        (candidate) => !registered.has(candidate.path),
    );
    const targets: Array<{
        target: KnowledgeLinkTarget;
        label: string;
        color?: string;
    }> = [
        { target: KNOWLEDGE_MAIN_REVIEW_TARGET, label: "Main review" },
        ...agents.map((agent) => ({
            target: { agentId: agent.id },
            label: agent.name,
            color: agent.presentation.tag.color,
        })),
    ];
    const listHref = agentsListHref(repositoryId, directoryId);

    useUnsavedChangesGuard({
        id: "skills-and-docs",
        isDirty: isDirty || isSubmitting,
        onBlock: () => {
            document
                .querySelector("[data-header-actions]")
                ?.scrollIntoView({ behavior: "smooth", block: "center" });
        },
    });

    // A file with an extension is a doc; a folder or a SKILL.md is a skill.
    const typedItem = knowledgeItemFromPath(path);
    const register = (item: Pick<KnowledgeItem, "path" | "kind">) => {
        if (registered.has(item.path)) return;
        setKnowledge([
            ...knowledge,
            { path: item.path, kind: item.kind, linkedTo: [] },
        ]);
    };

    const onSave = async () => {
        try {
            const result = await save();
            if (result?.centralizedPr) {
                toast(
                    getCentralizedPrToastPayload(
                        result.centralizedPr,
                        "Change proposed through centralized pull request.",
                    ),
                );
                return;
            }
            toast({ description: "Settings saved", variant: "success" });
        } catch (error) {
            console.error("Error saving skills and docs:", error);
            toast({
                title: "Error",
                description: customAgentsSaveErrorMessage(
                    error,
                    "Couldn't save. Check the limits and try again.",
                    agents,
                ),
                variant: "danger",
            });
        }
    };

    if (!enabled) {
        return (
            <Page.Root>
                <Page.Content>
                    <p className="text-text-secondary text-sm">
                        Skills &amp; docs are part of the custom agents beta,
                        which is not enabled for this organization.
                    </p>
                </Page.Content>
            </Page.Root>
        );
    }

    return (
        <Page.Root>
            <Page.Header sticky>
                <Page.TitleContainer>
                    <Breadcrumb className="mb-1">
                        <BreadcrumbList>
                            <BreadcrumbItem>
                                <BreadcrumbLink href={listHref}>
                                    Custom agents
                                </BreadcrumbLink>
                            </BreadcrumbItem>
                            <BreadcrumbSeparator />
                            <BreadcrumbItem>
                                <BreadcrumbPage>
                                    Skills &amp; docs
                                </BreadcrumbPage>
                            </BreadcrumbItem>
                        </BreadcrumbList>
                    </Breadcrumb>
                    <Page.Title>Skills &amp; docs</Page.Title>
                    <Page.Description>
                        Guides that live in the repository, linked here to the
                        main review, with who follows what. Each custom agent
                        picks its own on its page. Read from each pull
                        request&apos;s target branch; skills open on demand,
                        docs load whole, scripts never run.
                    </Page.Description>
                </Page.TitleContainer>
                <Page.SaveActions
                    isDirty={isDirty}
                    isSaving={isSubmitting}
                    canSave={canEdit}
                    onReset={reset}
                    onSave={onSave}
                />
            </Page.Header>

            <Page.Content className="gap-6">
                <CentralizedConfigReadOnlyAlert />

                {isGlobal ? (
                    <p className="text-text-secondary text-sm">
                        Skills and docs are files of each repository, so they
                        are read per repository. Paths added here apply to every
                        repository; open a repository&apos;s settings to see
                        whether each one exists there.
                    </p>
                ) : (
                    report.data?.knowledge.status === "unavailable" && (
                        <p className="text-warning text-sm">
                            {report.data.knowledge.reason}
                        </p>
                    )
                )}

                <Card color="lv1" className="flex flex-col gap-3 px-5 py-4">
                    <span className="text-text-primary text-sm font-medium">
                        Added, and who follows each
                    </span>
                    {knowledge.length === 0 && (
                        <p className="text-text-secondary text-xs">
                            {isGlobal
                                ? "Nothing yet. Add a path below."
                                : "Nothing yet. Pick from what was found below, or add a path."}
                        </p>
                    )}
                    {knowledge.map((item) => {
                        const itemReport = knowledgeReport?.items.find(
                            (entry) => entry.path === item.path,
                        );
                        return (
                            <div
                                key={`${item.kind}:${item.path}`}
                                className="border-card-lv3/60 flex flex-col gap-2 border-t pt-3 first:border-t-0 first:pt-0">
                                <div className="flex items-start gap-2">
                                    {item.kind === "skill" ? (
                                        <SparklesIcon className="text-text-tertiary mt-0.5 size-4 shrink-0" />
                                    ) : (
                                        <BookOpenIcon className="text-text-tertiary mt-0.5 size-4 shrink-0" />
                                    )}
                                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                                        <span className="text-text-primary text-sm">
                                            {itemReport?.name ?? item.path}
                                        </span>
                                        <span className="text-text-tertiary truncate font-mono text-xs">
                                            {item.path}
                                        </span>
                                        {itemReport?.description && (
                                            <span className="text-text-secondary text-xs">
                                                {itemReport.description}
                                            </span>
                                        )}
                                        <span className="flex flex-wrap gap-1">
                                            <KnowledgeStatusChips
                                                report={itemReport}
                                            />
                                        </span>
                                        {itemReport?.issues.map((issue) => (
                                            <span
                                                key={issue.message}
                                                className={
                                                    issue.severity === "error"
                                                        ? "text-danger text-xs"
                                                        : "text-warning text-xs"
                                                }>
                                                {issue.message}
                                            </span>
                                        ))}
                                    </div>
                                    <Button
                                        size="icon-sm"
                                        variant="cancel"
                                        aria-label={`Remove ${itemReport?.name ?? item.path}`}
                                        disabled={!canEdit}
                                        onClick={() =>
                                            setKnowledge(
                                                knowledge.filter(
                                                    (entry) => entry !== item,
                                                ),
                                            )
                                        }>
                                        <Trash2Icon />
                                    </Button>
                                </div>
                                <div className="flex flex-wrap gap-x-4 gap-y-1.5 pl-6">
                                    {targets.map(({ target, label, color }) => {
                                        const id = `link-${item.path}-${typeof target === "string" ? target : target.agentId}`;
                                        return (
                                            <label
                                                key={id}
                                                htmlFor={id}
                                                className="text-text-secondary flex cursor-pointer items-center gap-1.5 text-xs">
                                                <Checkbox
                                                    id={id}
                                                    aria-label={`${itemReport?.name ?? item.path} for ${label}`}
                                                    disabled={!canEdit}
                                                    checked={isLinked(
                                                        item,
                                                        target,
                                                    )}
                                                    onCheckedChange={(
                                                        checked,
                                                    ) =>
                                                        setKnowledge(
                                                            setKnowledgeLink(
                                                                knowledge,
                                                                item,
                                                                target,
                                                                checked ===
                                                                    true,
                                                            ),
                                                        )
                                                    }
                                                />
                                                {color && (
                                                    <span
                                                        aria-hidden
                                                        className="size-2 rounded-full"
                                                        style={{
                                                            backgroundColor:
                                                                color,
                                                        }}
                                                    />
                                                )}
                                                {label}
                                            </label>
                                        );
                                    })}
                                </div>
                            </div>
                        );
                    })}
                    {knowledgeReport?.budgets
                        .filter((budget) => budget.over.length > 0)
                        .map((budget) => (
                            <p
                                key={budget.target}
                                className="text-warning text-xs">
                                {budget.target === KNOWLEDGE_MAIN_REVIEW_TARGET
                                    ? "Main review"
                                    : (agents.find(
                                          (agent) => agent.id === budget.target,
                                      )?.name ?? budget.target)}{" "}
                                is over its limit ({budget.over.join(", ")}): up
                                to {CUSTOM_AGENT_LIMITS.maxSkills} skills,{" "}
                                {CUSTOM_AGENT_LIMITS.maxDocs} docs and{" "}
                                {CUSTOM_AGENT_LIMITS.maxDocTokens.toLocaleString()}{" "}
                                doc tokens.
                            </p>
                        ))}
                </Card>

                <Card color="lv1" className="flex flex-col gap-3 px-5 py-4">
                    <span className="flex flex-col">
                        <span className="text-text-primary text-sm font-medium">
                            {isGlobal
                                ? "Add by path"
                                : "Found in the repository"}
                        </span>
                        <span className="text-text-secondary text-xs">
                            {isGlobal ? "" : `${branchLine} `}Skills are folders
                            with a SKILL.md; docs are Markdown guides.
                        </span>
                    </span>
                    {!isGlobal && report.isLoading && (
                        <Spinner className="size-4" />
                    )}
                    {!isGlobal &&
                        knowledgeReport &&
                        candidates.length === 0 && (
                            <p className="text-text-secondary text-xs">
                                Nothing new found.
                            </p>
                        )}
                    {candidates.map((candidate) => (
                        <div
                            key={candidate.path}
                            className="flex items-start gap-2">
                            {candidate.kind === "skill" ? (
                                <SparklesIcon className="text-text-tertiary mt-0.5 size-4 shrink-0" />
                            ) : (
                                <BookOpenIcon className="text-text-tertiary mt-0.5 size-4 shrink-0" />
                            )}
                            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                                <span className="text-text-primary text-xs font-medium">
                                    {candidate.name ?? candidate.path}
                                </span>
                                <span className="text-text-tertiary truncate font-mono text-xs">
                                    {candidate.path}
                                </span>
                                {candidate.kodyRuleSource && (
                                    <span className="text-warning text-xs">
                                        Also a Kody Rules source: linking it
                                        here can make the same rule comment
                                        twice.
                                    </span>
                                )}
                            </div>
                            <Button
                                size="xs"
                                variant="helper"
                                leftIcon={<PlusIcon />}
                                aria-label={`Add ${candidate.name ?? candidate.path}`}
                                disabled={!canEdit}
                                onClick={() => register(candidate)}>
                                Add
                            </Button>
                        </div>
                    ))}

                    <div
                        className={
                            isGlobal
                                ? "flex items-center gap-2"
                                : "border-card-lv3/60 flex items-center gap-2 border-t pt-3"
                        }>
                        <div className="min-w-0 flex-1">
                            <Input
                                size="md"
                                aria-label="Path of a doc or skill"
                                placeholder="Path, e.g. docs/payments.md or .claude/skills/ledger"
                                value={path}
                                disabled={!canEdit}
                                onChange={(e) => setPath(e.target.value)}
                            />
                        </div>
                        <Button
                            size="sm"
                            variant="secondary"
                            aria-label={
                                typedItem
                                    ? `Add the ${typedItem.kind} ${typedItem.path}`
                                    : "Add path"
                            }
                            disabled={!canEdit || !typedItem}
                            onClick={() => {
                                if (!typedItem) return;
                                register(typedItem);
                                setPath("");
                            }}>
                            Add
                        </Button>
                    </div>
                </Card>
            </Page.Content>
        </Page.Root>
    );
}

export default function SkillsAndDocsPage() {
    return (
        <Suspense
            fallback={
                <div className="flex h-full w-full items-center justify-center py-10">
                    <Spinner className="size-6" />
                </div>
            }>
            <SkillsContent />
        </Suspense>
    );
}
