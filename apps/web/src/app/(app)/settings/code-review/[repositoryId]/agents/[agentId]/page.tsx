"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
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
import { ConfirmModal } from "@components/ui/confirm-modal";
import { Page } from "@components/ui/page";
import { Spinner } from "@components/ui/spinner";
import { toast } from "@components/ui/toaster/use-toast";
import {
    agentNameError,
    deleteAgentNote,
    knowledgeBudgetNote,
    knowledgeTargetKey,
    withoutAgent,
    withoutSecretValues,
} from "@services/custom-agents/drafts";
import {
    useCustomAgentsStatus,
    useResolveCustomAgent,
    useSettled,
} from "@services/custom-agents/hooks";
import type { CustomAgent } from "@services/custom-agents/types";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import { Trash2Icon } from "lucide-react";
import { useUnsavedChangesGuard } from "src/core/hooks/use-unsaved-changes-guard";
import { CustomAgentsPageGate } from "src/features/ee/custom-agents/custom-agents-plan-gate";

import {
    agentPageHref,
    reviewScopeHref,
    skillsPageHref,
    useCustomAgentsForm,
} from "../../_custom-agents/use-custom-agents-form";
import { CentralizedConfigReadOnlyAlert } from "../../../_components/centralized-config-readonly-alert";
import { getCentralizedPrToastPayload } from "../../../_utils/centralized-pr-feedback";
import {
    customAgentsSaveErrorToast,
    logCustomAgentsSaveError,
} from "../../../_utils/settings-save-conflict";
import {
    CommentsAndModel,
    FilesAndKnowledge,
    InstructionsCard,
} from "./_components/agent-sections";
import { StatusStrip } from "./_components/status-strip";
import { ToolsCard } from "./_components/tools-card";
import { TryIt } from "./_components/try-it";

function AgentContent() {
    const router = useRouter();
    const { agentId: rawAgentId } = useParams<{ agentId: string }>();
    const agentId = decodeURIComponent(rawAgentId ?? "");
    const {
        teamId,
        repositoryId,
        directoryId,
        agents,
        linkableAgents,
        knowledge,
        reviewKnowledge,
        inheritedAgents,
        isDirty,
        isSubmitting,
        setAgents,
        setKnowledge,
        updateAgent,
        save,
        reset,
    } = useCustomAgentsForm();
    const canEdit = usePermission(
        Action.Update,
        ResourceType.CodeReviewSettings,
        repositoryId,
    );
    const [confirmingDelete, setConfirmingDelete] = useState(false);
    const ownAgent = agents.find((entry) => entry.id === agentId);
    // At a directory, a repository agent it doesn't replace runs as the
    // repository sets it: it reads here and is edited there. Its skills and
    // docs links are per level, so those stay editable here.
    const inheritedAgent = ownAgent
        ? undefined
        : inheritedAgents.find((entry) => entry.id === agentId);
    const agent = ownAgent ?? inheritedAgent;
    const canEditAgent = canEdit && !inheritedAgent;
    // Two agents with one command name can't be told apart; the server
    // refuses the save, so the page does too. At a directory that counts the
    // repository's agents it runs next to.
    const nameError = ownAgent
        ? agentNameError(ownAgent, linkableAgents)
        : null;
    const isGlobal = repositoryId === "global";

    const status = useCustomAgentsStatus({
        teamId,
        repositoryId,
        enabled: !!agent && !isGlobal,
    });
    // Typed secrets never go to the draft check, only the fact they exist.
    const draft = useSettled(agent ? withoutSecretValues(agent) : undefined);
    const settledKnowledge = useSettled(knowledge);
    const resolve = useResolveCustomAgent({
        teamId,
        repositoryId,
        agent: draft,
        knowledge: settledKnowledge,
        discover: true,
        enabled: !!draft,
    });

    const backHref = reviewScopeHref(repositoryId, directoryId);

    useUnsavedChangesGuard({
        id: "custom-agent",
        isDirty: isDirty || isSubmitting,
        onBlock: () => {
            document
                .querySelector("[data-header-actions]")
                ?.scrollIntoView({ behavior: "smooth", block: "center" });
        },
    });

    const onSave = async () => {
        if (nameError) return;
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
            // Doc tokens are only known by reading the docs on the branch, so
            // the save keeps an agent over its budget; a review cuts its docs.
            const budget =
                resolve.data?.knowledge.status === "ok"
                    ? resolve.data.knowledge.budgets.find(
                          (entry) =>
                              entry.target ===
                                  knowledgeTargetKey({ agentId }) &&
                              entry.over.length > 0,
                      )
                    : undefined;
            toast(
                budget
                    ? {
                          description: `Agent saved. ${knowledgeBudgetNote(budget, linkableAgents)}`,
                          variant: "warning",
                      }
                    : { description: "Agent saved", variant: "success" },
            );
        } catch (error) {
            logCustomAgentsSaveError("Error saving custom agent:", error);
            toast(
                customAgentsSaveErrorToast(
                    error,
                    "Couldn't save the agent. Check the fields marked above and try again.",
                    agents,
                ),
            );
        }
    };

    const onDelete = async () => {
        if (!agent) return;
        try {
            await save(
                withoutAgent(agents, knowledge, agent.id, inheritedAgents),
            );
            setConfirmingDelete(false);
            router.push(backHref);
        } catch (error) {
            logCustomAgentsSaveError("Error deleting custom agent:", error);
            setConfirmingDelete(false);
            toast(
                customAgentsSaveErrorToast(
                    error,
                    "Couldn't delete the agent. Try again.",
                ),
            );
        }
    };

    const patch = (change: (current: CustomAgent) => CustomAgent) =>
        updateAgent(agentId, change);

    const tryIt = agent && (
        <TryIt
            teamId={teamId}
            repositoryId={repositoryId}
            directoryId={directoryId}
            agent={agent}
            // The skills and docs a review here reads, the repository's too
            // at a directory, so Try it runs the agent as the review would.
            knowledge={reviewKnowledge}
            canEdit={canEdit}
        />
    );

    return (
        <Page.Root>
            <Page.Header sticky>
                <Page.TitleContainer>
                    <Breadcrumb className="mb-1">
                        <BreadcrumbList>
                            <BreadcrumbItem>
                                <BreadcrumbLink href={backHref}>
                                    What to review
                                </BreadcrumbLink>
                            </BreadcrumbItem>
                            <BreadcrumbSeparator />
                            <BreadcrumbItem>
                                <BreadcrumbPage>
                                    {agent?.name || agentId}
                                </BreadcrumbPage>
                            </BreadcrumbItem>
                        </BreadcrumbList>
                    </Breadcrumb>
                    <Page.Title>{agent?.name || "Custom agent"}</Page.Title>
                </Page.TitleContainer>

                {agent && (
                    <Page.SaveActions
                        isDirty={isDirty}
                        isSaving={isSubmitting}
                        canSave={canEdit && !nameError}
                        onReset={reset}
                        onSave={onSave}
                    />
                )}
            </Page.Header>

            <Page.Content className="gap-6">
                <CentralizedConfigReadOnlyAlert />
                {!agent ? (
                    <p className="text-text-secondary text-sm">
                        This agent doesn&apos;t exist at this level. It may have
                        been deleted, or be defined on another repository.
                    </p>
                ) : (
                    <>
                        {inheritedAgent && (
                            <Card
                                color="lv1"
                                role="note"
                                className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
                                <p className="text-text-secondary min-w-0 flex-1 text-sm">
                                    This agent comes from the repository and
                                    runs here as it is set there. The skills and
                                    docs linked to it here are this
                                    directory&apos;s.{" "}
                                    <Link
                                        href={agentPageHref(
                                            repositoryId,
                                            inheritedAgent.id,
                                        )}
                                        className="text-primary-light hover:underline">
                                        Edit it on the repository
                                    </Link>
                                </p>
                                {/* Same id: the copy replaces the repository's
                                    agent at this directory, as the cascade
                                    does for any directory agent. */}
                                <Button
                                    size="sm"
                                    variant="secondary"
                                    disabled={!canEdit || isSubmitting}
                                    onClick={() =>
                                        setAgents([...agents, inheritedAgent])
                                    }>
                                    Override at this directory
                                </Button>
                            </Card>
                        )}
                        <StatusStrip
                            agent={agent}
                            status={status.data?.agents.find(
                                (entry) => entry.agentId === agent.id,
                            )}
                            windowDays={status.data?.windowDays ?? 30}
                            isLoading={status.isLoading && !isGlobal}
                            report={resolve.data}
                            isGlobal={isGlobal}
                            canEdit={canEditAgent}
                            onEnabledChange={(on) =>
                                patch((current) => ({
                                    ...current,
                                    enabled: on,
                                }))
                            }
                        />
                        {/* Config on the left, Try it pinned on the right
                            from lg up; one column below, Try it right after
                            the instructions. */}
                        <div className="flex flex-col gap-6 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(20rem,26rem)] lg:items-start">
                            <div className="flex flex-col gap-6 lg:col-start-1 lg:row-start-1">
                                <InstructionsCard
                                    agent={agent}
                                    canEdit={canEditAgent}
                                    onChange={patch}
                                    nameError={nameError}
                                />
                            </div>
                            <aside
                                data-testid="try-it-panel"
                                className="lg:sticky lg:top-24 lg:col-start-2 lg:row-span-2 lg:row-start-1">
                                {tryIt}
                            </aside>
                            <div className="flex flex-col gap-6 lg:col-start-1 lg:row-start-2">
                                <FilesAndKnowledge
                                    agent={agent}
                                    knowledge={knowledge}
                                    report={resolve.data}
                                    canEdit={canEdit}
                                    canEditFiles={canEditAgent}
                                    onChange={patch}
                                    onKnowledgeChange={setKnowledge}
                                    skillsHref={skillsPageHref(
                                        repositoryId,
                                        directoryId,
                                    )}
                                />
                                <ToolsCard
                                    agent={agent}
                                    report={resolve.data}
                                    loading={resolve.isLoading}
                                    canEdit={canEditAgent}
                                    onChange={patch}
                                />
                                <CommentsAndModel
                                    agent={agent}
                                    canEdit={canEditAgent}
                                    onChange={patch}
                                />
                                {ownAgent && (
                                    <div>
                                        <Button
                                            size="sm"
                                            variant="cancel"
                                            className="[--button-foreground:var(--color-danger)]"
                                            leftIcon={<Trash2Icon />}
                                            disabled={!canEdit || isSubmitting}
                                            onClick={() =>
                                                setConfirmingDelete(true)
                                            }>
                                            Delete agent
                                        </Button>
                                    </div>
                                )}
                            </div>
                        </div>
                        <ConfirmModal
                            open={confirmingDelete}
                            title={`Delete ${agent.name || "this agent"}?`}
                            description={deleteAgentNote(
                                agent.id,
                                inheritedAgents,
                            )}
                            confirmText="Delete agent"
                            loading={isSubmitting}
                            onConfirm={onDelete}
                            onCancel={() => setConfirmingDelete(false)}
                        />
                    </>
                )}
            </Page.Content>
        </Page.Root>
    );
}

export default function CustomAgentPage() {
    return (
        <CustomAgentsPageGate title="Custom agent">
            <Suspense
                fallback={
                    <div className="flex h-full w-full items-center justify-center py-10">
                        <Spinner className="size-6" />
                    </div>
                }>
                <AgentContent />
            </Suspense>
        </CustomAgentsPageGate>
    );
}
