"use client";

import { useState } from "react";
import Link from "next/link";
import { Badge } from "@components/ui/badge";
import { Button } from "@components/ui/button";
import {
    Collapsible,
    CollapsibleContent,
    CollapsibleIndicator,
    CollapsibleTrigger,
} from "@components/ui/collapsible";
import { Heading } from "@components/ui/heading";
import { Switch } from "@components/ui/switch";
import TagInput from "@components/ui/tag-input";
import { Textarea } from "@components/ui/textarea";
import {
    agentUsageLine,
    canAddAgent,
    CUSTOM_AGENT_LIMITS,
    describeAgent,
    withoutSecretValues,
} from "@services/custom-agents/drafts";
import {
    useCustomAgentsStatus,
    useResolveCustomAgent,
    useSettled,
} from "@services/custom-agents/hooks";
import type { CustomAgent } from "@services/custom-agents/types";
import { ArrowRightIcon, PlusIcon } from "lucide-react";
import { cn } from "src/core/utils/components";

import {
    ModelsFields,
    TagColorPicker,
} from "../agents/[agentId]/_components/agent-sections";
import { Choice, Field } from "../agents/[agentId]/_components/field";
import { AgentKnowledgeField } from "../agents/[agentId]/_components/knowledge-card";
import {
    ClisField,
    PluginsField,
} from "../agents/[agentId]/_components/tools-card";
import { NewAgentDialog } from "./new-agent-dialog";
import {
    agentPageHref,
    skillsPageHref,
    useCustomAgentsForm,
} from "./use-custom-agents-form";

/**
 * What most teams set on an agent, folded under its row. Mounted only while
 * the row is open, so only an open agent is checked against the branch.
 */
const AgentInlineConfig = ({
    agent,
    canEdit,
}: {
    agent: CustomAgent;
    canEdit: boolean;
}) => {
    const {
        teamId,
        repositoryId,
        directoryId,
        knowledge,
        setKnowledge,
        updateAgent,
    } = useCustomAgentsForm();
    // Typed secrets never go to the draft check, only the fact they exist.
    const draft = useSettled(withoutSecretValues(agent));
    const settledKnowledge = useSettled(knowledge);
    const resolve = useResolveCustomAgent({
        teamId,
        repositoryId,
        agent: draft,
        knowledge: settledKnowledge,
        discover: true,
    });
    const patch = (change: (current: CustomAgent) => CustomAgent) =>
        updateAgent(agent.id, change);
    const ids = {
        instructions: `agent-${agent.id}-instructions`,
        include: `agent-${agent.id}-include`,
    };

    return (
        <div className="border-card-lv3/60 flex flex-col gap-5 border-t py-4 pr-4 pl-14">
            <Field
                label="Instructions"
                htmlFor={ids.instructions}
                hint="What this agent looks for and how it decides. It reads the change, the files it follows and its tools.">
                <Textarea
                    id={ids.instructions}
                    className="min-h-28 text-sm"
                    value={agent.instructions}
                    disabled={!canEdit}
                    maxLength={CUSTOM_AGENT_LIMITS.maxInstructionsLength}
                    onChange={(e) =>
                        patch((current) => ({
                            ...current,
                            instructions: e.target.value,
                        }))
                    }
                />
            </Field>

            <Field
                label="Runs on"
                htmlFor={ids.include}
                hint="Globs over the files a pull request changes, e.g. src/payments/**. Empty runs on every pull request.">
                <TagInput
                    id={ids.include}
                    tags={agent.scope.include ?? []}
                    disabled={!canEdit}
                    placeholder="Add a glob and press Enter"
                    onTagsChange={(include) =>
                        patch((current) => ({
                            ...current,
                            scope: { ...current.scope, include },
                        }))
                    }
                />
            </Field>

            <div className="flex flex-col gap-1.5">
                <span className="text-text-primary text-xs font-medium">
                    Skills and docs this agent follows
                </span>
                <AgentKnowledgeField
                    agentId={agent.id}
                    knowledge={knowledge}
                    report={resolve.data}
                    canEdit={canEdit}
                    onChange={setKnowledge}
                />
            </div>

            <PluginsField
                agent={agent}
                report={resolve.data}
                loading={resolve.isLoading}
                canEdit={canEdit}
                onChange={patch}
            />
            <ClisField agent={agent} canEdit={canEdit} onChange={patch} />

            <div className="flex flex-col gap-1.5">
                <span className="text-text-primary text-xs font-medium">
                    Models
                </span>
                <ModelsFields
                    agent={agent}
                    canEdit={canEdit}
                    onChange={patch}
                />
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <Field label="Tag color">
                    <TagColorPicker
                        value={agent.presentation.tag.color}
                        disabled={!canEdit}
                        onChange={(color) =>
                            patch((current) => ({
                                ...current,
                                presentation: {
                                    ...current.presentation,
                                    tag: { color },
                                },
                            }))
                        }
                    />
                </Field>
                <Field
                    label="Mode"
                    hint="Shadow keeps findings for you to read without posting them.">
                    <Choice
                        value={agent.presentation.mode}
                        disabled={!canEdit}
                        onChange={(mode) =>
                            patch((current) => ({
                                ...current,
                                presentation: { ...current.presentation, mode },
                            }))
                        }
                        options={[
                            { value: "post", label: "Post" },
                            { value: "shadow", label: "Shadow" },
                        ]}
                    />
                </Field>
            </div>

            <Link
                href={agentPageHref(repositoryId, agent.id, directoryId)}
                className="text-text-secondary hover:text-text-primary flex w-fit items-center gap-1.5 text-xs">
                More settings: comment format, severity, limits, writing,
                structural search, try it
                <ArrowRightIcon className="size-3.5" />
            </Link>
        </div>
    );
};

/**
 * "Custom agents" on What to review: one row per agent with its switch and
 * what it looks for, configured inline under the row like the categories
 * above it. Everything saves with the rest of this page.
 */
export const CustomAgentsSection = ({ canEdit }: { canEdit: boolean }) => {
    const { teamId, repositoryId, directoryId, agents, updateAgent } =
        useCustomAgentsForm();
    const [dialogOpen, setDialogOpen] = useState(false);
    const [openIds, setOpenIds] = useState<string[]>([]);
    const status = useCustomAgentsStatus({
        teamId,
        repositoryId,
        enabled: repositoryId !== "global" && agents.length > 0,
    });
    const windowDays = status.data?.windowDays ?? 30;
    const statusOf = (agentId: string) =>
        status.data?.agents.find((entry) => entry.agentId === agentId);
    const setOpen = (agentId: string, open: boolean) =>
        setOpenIds((current) =>
            open
                ? [...current.filter((id) => id !== agentId), agentId]
                : current.filter((id) => id !== agentId),
        );

    return (
        <div className="flex flex-col gap-4" data-field-name="customAgents">
            <div className="flex flex-wrap items-end justify-between gap-3">
                <div className="flex flex-col gap-1">
                    <Heading variant="h2">
                        Custom agents <Badge>Beta</Badge>
                    </Heading>
                    <p className="text-text-secondary text-sm">
                        Reviewers your team defines, each with its own
                        instructions, files, tools and way of commenting. They
                        run next to Kody on the pull requests their files match.{" "}
                        <Link
                            className="text-primary-light hover:underline"
                            href={skillsPageHref(repositoryId, directoryId)}>
                            Skills &amp; docs for the main review
                        </Link>
                    </p>
                </div>
                <Button
                    size="sm"
                    variant="secondary"
                    leftIcon={<PlusIcon />}
                    disabled={!canEdit || !canAddAgent(agents)}
                    onClick={() => setDialogOpen(true)}>
                    New agent
                </Button>
            </div>

            {agents.length === 0 ? (
                <div className="border-card-lv3/60 text-text-secondary rounded-xl border border-dashed px-4 py-6 text-center text-sm">
                    No custom agents yet. Start from a template or from a skill
                    in the repository.
                </div>
            ) : (
                <div className="border-card-lv3/60 bg-card-lv1 divide-card-lv3/60 flex flex-col divide-y overflow-hidden rounded-xl border">
                    {agents.map((agent) => {
                        const switchId = `custom-agent-${agent.id}`;
                        const open = openIds.includes(agent.id);
                        return (
                            <Collapsible
                                key={agent.id}
                                open={open}
                                onOpenChange={(next) => setOpen(agent.id, next)}
                                className={cn(
                                    "group/collapsible",
                                    !agent.enabled && !open && "opacity-70",
                                )}>
                                <div className="flex flex-wrap items-start gap-x-4 gap-y-2 px-4 py-3">
                                    <Switch
                                        id={switchId}
                                        size="sm"
                                        className="mt-0.5"
                                        checked={agent.enabled}
                                        disabled={!canEdit}
                                        onCheckedChange={(enabled) =>
                                            updateAgent(
                                                agent.id,
                                                (current) => ({
                                                    ...current,
                                                    enabled,
                                                }),
                                            )
                                        }
                                    />
                                    <div className="flex min-w-[10rem] flex-1 flex-col gap-0.5">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <span
                                                className="size-2.5 rounded-full"
                                                style={{
                                                    backgroundColor:
                                                        agent.presentation.tag
                                                            .color,
                                                }}
                                            />
                                            <label
                                                htmlFor={switchId}
                                                className="text-text-primary cursor-pointer text-sm font-medium">
                                                {agent.name}
                                            </label>
                                            {agent.presentation.mode ===
                                                "shadow" && (
                                                <span className="bg-card-lv2 text-text-secondary inline-flex h-5 items-center rounded px-1.5 text-xs font-medium">
                                                    Shadow
                                                </span>
                                            )}
                                        </div>
                                        <p className="text-text-secondary text-xs">
                                            {describeAgent(agent)}
                                        </p>
                                        <p className="text-text-tertiary text-xs">
                                            {repositoryId === "global"
                                                ? "Usage shows per repository"
                                                : agentUsageLine(
                                                      statusOf(agent.id),
                                                      windowDays,
                                                  )}
                                        </p>
                                    </div>
                                    <CollapsibleTrigger asChild>
                                        <button
                                            type="button"
                                            className="text-text-secondary hover:text-text-primary ml-auto flex shrink-0 items-center gap-2 self-center text-xs">
                                            Configure
                                            <CollapsibleIndicator />
                                        </button>
                                    </CollapsibleTrigger>
                                </div>
                                <CollapsibleContent className="pb-0">
                                    <AgentInlineConfig
                                        agent={agent}
                                        canEdit={canEdit}
                                    />
                                </CollapsibleContent>
                            </Collapsible>
                        );
                    })}
                </div>
            )}
            {!canAddAgent(agents) && (
                <p className="text-text-tertiary text-xs">
                    Up to {CUSTOM_AGENT_LIMITS.maxAgents} agents per repository.
                </p>
            )}

            <NewAgentDialog
                open={dialogOpen}
                onOpenChange={setDialogOpen}
                onCreated={(agentId) => setOpen(agentId, true)}
            />
        </div>
    );
};
