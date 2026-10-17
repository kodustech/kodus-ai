"use client";

import { Suspense } from "react";
import { useParams, useRouter } from "next/navigation";
import { Badge } from "@components/ui/badge";
import {
    Breadcrumb,
    BreadcrumbItem,
    BreadcrumbLink,
    BreadcrumbList,
    BreadcrumbPage,
    BreadcrumbSeparator,
} from "@components/ui/breadcrumb";
import { Button } from "@components/ui/button";
import { Page } from "@components/ui/page";
import { Spinner } from "@components/ui/spinner";
import { toast } from "@components/ui/toaster/use-toast";
import {
    pullRequestPlan,
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

import {
    skillsPageHref,
    useCustomAgentsForm,
} from "../../_custom-agents/use-custom-agents-form";
import { CentralizedConfigReadOnlyAlert } from "../../../_components/centralized-config-readonly-alert";
import { getCentralizedPrToastPayload } from "../../../_utils/centralized-pr-feedback";
import { useFeatureFlags } from "../../../../_components/context";
import {
    HowItComments,
    Models,
    RunsOn,
    WhatItDoes,
} from "./_components/agent-sections";
import { KnowledgeCard } from "./_components/knowledge-card";
import { StatusStrip } from "./_components/status-strip";
import { ToolsCard } from "./_components/tools-card";
import { TryIt } from "./_components/try-it";

function AgentContent() {
    const router = useRouter();
    const { agentId: rawAgentId } = useParams<{ agentId: string }>();
    const agentId = decodeURIComponent(rawAgentId ?? "");
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
        updateAgent,
        save,
        reset,
    } = useCustomAgentsForm();
    const canEdit = usePermission(
        Action.Update,
        ResourceType.CodeReviewSettings,
        repositoryId,
    );
    const agent = agents.find((entry) => entry.id === agentId);
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

    const named =
        resolve.data?.knowledge.status === "ok"
            ? [
                  ...resolve.data.knowledge.items,
                  ...(resolve.data.knowledge.candidates ?? []),
              ]
            : [];

    const reviewScopeHref = `/settings/code-review/${repositoryId}/review-scope${
        directoryId ? `?directoryId=${directoryId}` : ""
    }`;

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
            toast({ description: "Agent saved", variant: "success" });
        } catch (error) {
            console.error("Error saving custom agent:", error);
            toast({
                title: "Error",
                description:
                    "Couldn't save the agent. Check the fields marked above and try again.",
                variant: "danger",
            });
        }
    };

    const onDelete = async () => {
        if (!agent) return;
        if (
            !window.confirm(
                `Delete "${agent.name}"? Its findings stay on past pull requests.`,
            )
        ) {
            return;
        }
        try {
            const nextKnowledge = knowledge.map((item) => ({
                ...item,
                linkedTo: item.linkedTo.filter(
                    (target) =>
                        typeof target === "string" ||
                        target.agentId !== agent.id,
                ),
            }));
            await save({
                agents: agents.filter((entry) => entry.id !== agent.id),
                knowledge: nextKnowledge,
            });
            router.push(reviewScopeHref);
        } catch (error) {
            console.error("Error deleting custom agent:", error);
            toast({
                title: "Error",
                description: "Couldn't delete the agent. Try again.",
                variant: "danger",
            });
        }
    };

    if (!enabled) {
        return (
            <Page.Root>
                <Page.Content>
                    <p className="text-text-secondary text-sm">
                        Custom agents are in beta and not enabled for this
                        organization.
                    </p>
                </Page.Content>
            </Page.Root>
        );
    }

    const patch = (change: (current: CustomAgent) => CustomAgent) =>
        updateAgent(agentId, change);

    return (
        <Page.Root>
            <Page.Header sticky>
                <Page.TitleContainer>
                    {/* Not in the sidebar: reached from "What to review". */}
                    <Breadcrumb className="mb-1">
                        <BreadcrumbList>
                            <BreadcrumbItem>
                                <BreadcrumbLink href={reviewScopeHref}>
                                    What to review
                                </BreadcrumbLink>
                            </BreadcrumbItem>
                            <BreadcrumbSeparator />
                            <BreadcrumbItem>
                                <BreadcrumbLink href={reviewScopeHref}>
                                    Custom agents
                                </BreadcrumbLink>
                            </BreadcrumbItem>
                            <BreadcrumbSeparator />
                            <BreadcrumbItem>
                                <BreadcrumbPage>
                                    {agent?.name ?? agentId}
                                </BreadcrumbPage>
                            </BreadcrumbItem>
                        </BreadcrumbList>
                    </Breadcrumb>
                    <Page.Title>
                        {agent?.name || "Custom agent"} <Badge>Beta</Badge>
                    </Page.Title>
                    <Page.Description>
                        A reviewer your team defines. It runs next to Kody on
                        the pull requests its files match.
                    </Page.Description>
                </Page.TitleContainer>

                {agent && (
                    <Page.SaveActions
                        isDirty={isDirty}
                        isSaving={isSubmitting}
                        canSave={canEdit}
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
                        <p className="text-text-secondary text-sm">
                            {pullRequestPlan(agent, knowledge, named)}
                        </p>
                        <StatusStrip
                            agent={agent}
                            status={status.data?.agents.find(
                                (entry) => entry.agentId === agent.id,
                            )}
                            windowDays={status.data?.windowDays ?? 30}
                            isLoading={status.isLoading && !isGlobal}
                            report={resolve.data}
                            isGlobal={isGlobal}
                        />
                        <WhatItDoes
                            agent={agent}
                            knowledge={knowledge}
                            report={resolve.data}
                            canEdit={canEdit}
                            onChange={patch}
                        />
                        <RunsOn
                            agent={agent}
                            canEdit={canEdit}
                            onChange={patch}
                        />
                        <KnowledgeCard
                            agentId={agent.id}
                            knowledge={knowledge}
                            report={resolve.data}
                            canEdit={canEdit}
                            skillsHref={skillsPageHref(
                                repositoryId,
                                directoryId,
                            )}
                            onChange={setKnowledge}
                        />
                        <ToolsCard
                            agent={agent}
                            report={resolve.data}
                            loading={resolve.isLoading}
                            canEdit={canEdit}
                            onChange={patch}
                        />
                        <HowItComments
                            agent={agent}
                            canEdit={canEdit}
                            onChange={patch}
                        />
                        <Models
                            agent={agent}
                            canEdit={canEdit}
                            onChange={patch}
                        />
                        <TryIt
                            teamId={teamId}
                            repositoryId={repositoryId}
                            agent={agent}
                            knowledge={knowledge}
                            canEdit={canEdit}
                        />
                        <div>
                            <Button
                                size="sm"
                                variant="cancel"
                                leftIcon={<Trash2Icon />}
                                disabled={!canEdit || isSubmitting}
                                onClick={onDelete}>
                                Delete agent
                            </Button>
                        </div>
                    </>
                )}
            </Page.Content>
        </Page.Root>
    );
}

export default function CustomAgentPage() {
    return (
        <Suspense
            fallback={
                <div className="flex h-full w-full items-center justify-center py-10">
                    <Spinner className="size-6" />
                </div>
            }>
            <AgentContent />
        </Suspense>
    );
}
