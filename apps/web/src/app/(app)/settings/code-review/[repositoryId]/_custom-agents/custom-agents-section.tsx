"use client";

import { useState } from "react";
import Link from "next/link";
import { Badge } from "@components/ui/badge";
import { Button } from "@components/ui/button";
import { Heading } from "@components/ui/heading";
import { Switch } from "@components/ui/switch";
import {
    agentUsageLine,
    canAddAgent,
    CUSTOM_AGENT_LIMITS,
    describeAgent,
} from "@services/custom-agents/drafts";
import { useCustomAgentsStatus } from "@services/custom-agents/hooks";
import { PlusIcon } from "lucide-react";
import { cn } from "src/core/utils/components";

import { NewAgentDialog } from "./new-agent-dialog";
import {
    agentPageHref,
    skillsPageHref,
    useCustomAgentsForm,
} from "./use-custom-agents-form";

/**
 * "Custom agents" on What to review: one row per agent with its switch,
 * what it looks for, how it did lately and a way into its page. Toggling
 * saves with the rest of this page.
 */
export const CustomAgentsSection = ({ canEdit }: { canEdit: boolean }) => {
    const { teamId, repositoryId, directoryId, agents, updateAgent } =
        useCustomAgentsForm();
    const [dialogOpen, setDialogOpen] = useState(false);
    const status = useCustomAgentsStatus({
        teamId,
        repositoryId,
        enabled: repositoryId !== "global" && agents.length > 0,
    });
    const windowDays = status.data?.windowDays ?? 30;
    const statusOf = (agentId: string) =>
        status.data?.agents.find((entry) => entry.agentId === agentId);

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
                            Skills &amp; docs
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
                        return (
                            <div
                                key={agent.id}
                                className={cn(
                                    "flex flex-wrap items-start gap-x-4 gap-y-2 px-4 py-3",
                                    !agent.enabled && "opacity-70",
                                )}>
                                <Switch
                                    id={switchId}
                                    size="sm"
                                    className="mt-0.5"
                                    checked={agent.enabled}
                                    disabled={!canEdit}
                                    onCheckedChange={(enabled) =>
                                        updateAgent(agent.id, (current) => ({
                                            ...current,
                                            enabled,
                                        }))
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
                                <Link
                                    href={agentPageHref(
                                        repositoryId,
                                        agent.id,
                                        directoryId,
                                    )}
                                    className="text-text-secondary hover:text-text-primary ml-auto self-center text-xs">
                                    Configure
                                </Link>
                            </div>
                        );
                    })}
                </div>
            )}
            {!canAddAgent(agents) && (
                <p className="text-text-tertiary text-xs">
                    Up to {CUSTOM_AGENT_LIMITS.maxAgents} agents per repository.
                </p>
            )}

            <NewAgentDialog open={dialogOpen} onOpenChange={setDialogOpen} />
        </div>
    );
};
