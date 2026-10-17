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
    followsLine,
    settingsSummary,
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

import { useByokModels } from "../agents/[agentId]/_components/agent-sections";
import { Chip, Choice, Field } from "../agents/[agentId]/_components/field";
import { AgentKnowledgeField } from "../agents/[agentId]/_components/knowledge-card";
import { NewAgentDialog } from "./new-agent-dialog";
import {
    agentPageHref,
    skillsPageHref,
    useCustomAgentsForm,
} from "./use-custom-agents-form";

/**
 * What most teams set on an agent, folded under its row: instructions, what
 * it follows and where it runs. Tools, models and color are summarized and
 * edited on the agent's page. Mounted only while the row is open, so only
 * an open agent is checked against the branch.
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
    const byok = useByokModels();
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
        exclude: `agent-${agent.id}-exclude`,
    };
    const integrations =
        resolve.data?.mcp.status === "ok" ? resolve.data.mcp.integrations : [];
    const summary = settingsSummary(agent, {
        pluginName: (id) =>
            integrations.find((entry) => entry.integrationId === id)?.name,
        modelName: byok.nameOf,
    });

    return (
        <div className="border-card-lv3/60 flex flex-col gap-5 border-t py-4 pr-4 pl-14">
            <Field
                label="Instructions"
                htmlFor={ids.instructions}
                hint="What this reviewer looks for and how it decides. It reads the change, the skills and docs it follows, and its tools.">
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

            <div className="flex flex-col gap-1.5">
                <span className="text-text-primary text-xs font-medium">
                    Follows
                </span>
                <span className="text-text-tertiary text-xs">
                    The team&apos;s skills and docs this reviewer follows. A
                    skill opens when the change needs it; a doc loads whole.
                </span>
                <AgentKnowledgeField
                    agentId={agent.id}
                    knowledge={knowledge}
                    report={resolve.data}
                    canEdit={canEdit}
                    onChange={setKnowledge}
                />
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
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
                <Field
                    label="Except"
                    htmlFor={ids.exclude}
                    hint="e.g. **/*.test.ts, **/generated/**">
                    <TagInput
                        id={ids.exclude}
                        tags={agent.scope.exclude ?? []}
                        disabled={!canEdit}
                        placeholder="Add a glob and press Enter"
                        onTagsChange={(exclude) =>
                            patch((current) => ({
                                ...current,
                                scope: { ...current.scope, exclude },
                            }))
                        }
                    />
                </Field>
            </div>

            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <span className="flex flex-wrap items-center gap-1.5">
                    {summary.map((chip) => (
                        <Chip key={chip}>{chip}</Chip>
                    ))}
                </span>
                <Choice
                    size="sm"
                    label={`Post or shadow: ${agent.name}`}
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
                <Link
                    href={agentPageHref(repositoryId, agent.id, directoryId)}
                    className="text-text-secondary hover:text-text-primary ml-auto flex items-center gap-1.5 text-xs">
                    More settings
                    <ArrowRightIcon className="size-3.5" />
                </Link>
            </div>
        </div>
    );
};

/**
 * "Custom agents" on What to review: one row per agent with its switch and
 * what it looks for, configured inline under the row like the categories
 * above it. Everything saves with the rest of this page.
 */
export const CustomAgentsSection = ({ canEdit }: { canEdit: boolean }) => {
    const {
        teamId,
        repositoryId,
        directoryId,
        agents,
        knowledge,
        updateAgent,
    } = useCustomAgentsForm();
    const [dialogOpen, setDialogOpen] = useState(false);
    const [openIds, setOpenIds] = useState<string[]>([]);
    const status = useCustomAgentsStatus({
        teamId,
        repositoryId,
        enabled: repositoryId !== "global" && agents.length > 0,
    });
    // Skill names from their frontmatter, for the "Follows" line of each row.
    const discovered = useResolveCustomAgent({
        teamId,
        repositoryId,
        discover: true,
        enabled: repositoryId !== "global" && agents.length > 0,
    });
    const named =
        discovered.data?.knowledge.status === "ok"
            ? [
                  ...discovered.data.knowledge.items,
                  ...(discovered.data.knowledge.candidates ?? []),
              ]
            : [];
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
                <div className="flex items-center gap-3">
                    {!canAddAgent(agents) && (
                        <span
                            id="custom-agents-limit"
                            className="text-text-tertiary text-xs">
                            {agents.length}/{CUSTOM_AGENT_LIMITS.maxAgents}{" "}
                            agents
                        </span>
                    )}
                    <Button
                        size="sm"
                        variant="secondary"
                        leftIcon={<PlusIcon />}
                        aria-describedby={
                            canAddAgent(agents)
                                ? undefined
                                : "custom-agents-limit"
                        }
                        disabled={!canEdit || !canAddAgent(agents)}
                        onClick={() => setDialogOpen(true)}>
                        New agent
                    </Button>
                </div>
            </div>

            {agents.length === 0 ? (
                <div className="border-card-lv3/60 text-text-secondary rounded-xl border border-dashed px-4 py-6 text-center text-sm">
                    No custom agents yet. Start from a template, or turn one of
                    the team&apos;s skills into a reviewer that follows it.
                </div>
            ) : (
                <div className="border-card-lv3/60 bg-card-lv1 divide-card-lv3/60 flex flex-col divide-y overflow-hidden rounded-xl border">
                    {agents.map((agent) => {
                        const switchId = `custom-agent-${agent.id}`;
                        const open = openIds.includes(agent.id);
                        const follows = followsLine(knowledge, agent.id, named);
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
                                        {follows && (
                                            <p className="text-text-secondary text-xs">
                                                {follows}
                                            </p>
                                        )}
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

            <NewAgentDialog
                open={dialogOpen}
                onOpenChange={setDialogOpen}
                onCreated={(agentId) => setOpen(agentId, true)}
            />
        </div>
    );
};
