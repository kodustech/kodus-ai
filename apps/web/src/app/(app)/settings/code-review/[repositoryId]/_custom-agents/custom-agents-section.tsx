"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@components/ui/button";
import { ConfirmModal } from "@components/ui/confirm-modal";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@components/ui/dropdown-menu";
import { Heading } from "@components/ui/heading";
import { Switch } from "@components/ui/switch";
import { toast } from "@components/ui/toaster/use-toast";
import {
    agentChips,
    agentUsageLine,
    deleteAgentNote,
    describeAgent,
    withoutAgent,
} from "@services/custom-agents/drafts";
import { useCustomAgentsStatus } from "@services/custom-agents/hooks";
import type { CustomAgent } from "@services/custom-agents/types";
import {
    EllipsisIcon,
    FlaskConicalIcon,
    PencilIcon,
    PlusIcon,
    TrashIcon,
} from "lucide-react";
import { cn } from "src/core/utils/components";

import { getCentralizedPrToastPayload } from "../../_utils/centralized-pr-feedback";
import { customAgentsSaveErrorMessage } from "../../_utils/settings-save-conflict";
import { Chip } from "../agents/[agentId]/_components/field";
import { NewAgentDialog } from "./new-agent-dialog";
import {
    agentPageHref,
    skillsPageHref,
    useCustomAgentsForm,
} from "./use-custom-agents-form";

type Save = ReturnType<typeof useCustomAgentsForm>["save"];

/** Runs a list save and says how it went, as the agent page does. */
const saveWithToast = async (
    save: Save,
    next: Parameters<Save>[0],
    { done, failed }: { done: string; failed: string },
    /** Where the save was made, for the log; never the agents' content. */
    scope: { teamId?: string; repositoryId: string; directoryId?: string },
) => {
    try {
        const result = await save(next);
        if (result?.centralizedPr) {
            toast(
                getCentralizedPrToastPayload(
                    result.centralizedPr,
                    "Change proposed through centralized pull request.",
                ),
            );
            return;
        }
        toast({ description: done, variant: "success" });
    } catch (error) {
        console.error("Error saving custom agents:", { ...scope, error });
        toast({
            title: "Error",
            description: customAgentsSaveErrorMessage(
                error,
                failed,
                next?.agents,
            ),
            variant: "danger",
        });
    }
};

const AgentRow = ({
    agent,
    href,
    chips,
    usage,
    canEdit,
    busy,
    onToggle,
    onDelete,
}: {
    agent: CustomAgent;
    href: string;
    chips: string[];
    usage?: string;
    canEdit: boolean;
    busy: boolean;
    onToggle: (enabled: boolean) => void;
    onDelete: () => void;
}) => {
    const router = useRouter();
    return (
        <li
            className={cn(
                "hover:bg-card-lv2/60 relative flex items-center gap-4 px-4 py-3 transition-colors",
                !agent.enabled && "opacity-70",
            )}>
            {/* On the left, as the categories above it on What to review. */}
            <Switch
                size="sm"
                className="relative z-10 shrink-0"
                aria-label={`${agent.name} enabled`}
                checked={agent.enabled}
                disabled={!canEdit || busy}
                onCheckedChange={onToggle}
            />
            <span
                aria-hidden
                className="size-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: agent.presentation.tag.color }}
            />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
                {/* The name stretches over the row: a click anywhere that is
                    not the switch or the menu opens the agent. */}
                <Link
                    href={href}
                    className="text-text-primary truncate text-sm font-medium after:absolute after:inset-0 hover:underline">
                    {agent.name}
                </Link>
                <p className="text-text-secondary truncate text-xs">
                    {describeAgent(agent)}
                </p>
                {chips.length > 0 && (
                    <ul
                        aria-label="Setup"
                        className="flex flex-wrap items-center gap-1.5">
                        {chips.map((chip) => (
                            <li key={chip}>
                                <Chip>{chip}</Chip>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
            {usage && (
                <span className="text-text-tertiary hidden shrink-0 text-xs sm:block">
                    {usage}
                </span>
            )}
            <DropdownMenu modal={false}>
                <DropdownMenuTrigger asChild>
                    <Button
                        size="icon-xs"
                        variant="cancel"
                        className="relative z-10 shrink-0"
                        aria-label={`More actions for ${agent.name}`}
                        title="More actions">
                        <EllipsisIcon aria-hidden />
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => router.push(href)}>
                        <PencilIcon className="size-4" aria-hidden />
                        Edit
                    </DropdownMenuItem>
                    <DropdownMenuItem
                        onSelect={() => router.push(`${href}#try-it`)}>
                        <FlaskConicalIcon className="size-4" aria-hidden />
                        Try it
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                        disabled={!canEdit || busy}
                        className="[--button-foreground:var(--color-danger)]"
                        onSelect={onDelete}>
                        <TrashIcon className="size-4" aria-hidden />
                        Delete
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
        </li>
    );
};

/**
 * The custom agents of this level, one compact row each. A row opens the
 * agent's page, where everything about it is set; the list itself only
 * turns agents on and off and deletes them, each saved right away.
 */
export const CustomAgentsList = ({ canEdit }: { canEdit: boolean }) => {
    const {
        teamId,
        repositoryId,
        directoryId,
        agents,
        knowledge,
        inheritedAgents,
        listNote,
        isSubmitting,
        otherFieldsDirty,
        save,
    } = useCustomAgentsForm();
    const scope = { teamId, repositoryId, directoryId };
    const [dialogOpen, setDialogOpen] = useState(false);
    const [deleting, setDeleting] = useState<CustomAgent | null>(null);
    const isGlobal = repositoryId === "global";
    const status = useCustomAgentsStatus({
        teamId,
        repositoryId,
        enabled: !isGlobal && agents.length > 0,
    });
    const windowDays = status.data?.windowDays ?? 30;

    const toggle = (agent: CustomAgent, enabled: boolean) =>
        saveWithToast(
            save,
            {
                agents: agents.map((entry) =>
                    entry.id === agent.id ? { ...entry, enabled } : entry,
                ),
            },
            {
                done: `${agent.name} turned ${enabled ? "on" : "off"}`,
                failed: "Couldn't save the agent. Try again.",
            },
            scope,
        );

    const confirmDelete = async () => {
        if (!deleting) return;
        await saveWithToast(
            save,
            withoutAgent(agents, knowledge, deleting.id, inheritedAgents),
            {
                done: `${deleting.name} deleted`,
                failed: "Couldn't delete the agent. Try again.",
            },
            scope,
        );
        setDeleting(null);
    };

    return (
        <div className="flex flex-col gap-4" data-field-name="customAgents">
            {otherFieldsDirty && agents.length > 0 && (
                <p role="note" className="text-warning text-sm">
                    Save or discard the other changes on this page to turn
                    agents on or off or delete them.
                </p>
            )}
            {listNote && (
                <p role="note" className="text-text-secondary text-sm">
                    {listNote}
                </p>
            )}
            {inheritedAgents.length > 0 && (
                <p role="note" className="text-text-secondary text-sm">
                    Also runs the repository&apos;s{" "}
                    {inheritedAgents.length === 1
                        ? "agent"
                        : `${inheritedAgents.length} agents`}
                    .
                </p>
            )}

            {agents.length === 0 ? (
                <div className="border-card-lv3/60 flex flex-col items-center gap-3 rounded-xl border border-dashed px-4 py-10 text-center">
                    <p className="text-text-primary text-sm font-medium">
                        No custom agents yet
                    </p>
                    <p className="text-text-secondary max-w-md text-sm">
                        An agent is a reviewer with its own instructions, files
                        and tools. Start from a template, or turn one of the
                        team&apos;s skills into one.
                    </p>
                    <Button
                        size="sm"
                        variant="primary"
                        leftIcon={<PlusIcon />}
                        disabled={!canEdit}
                        onClick={() => setDialogOpen(true)}>
                        New agent
                    </Button>
                </div>
            ) : (
                <ul
                    aria-label="Custom agents"
                    className="border-card-lv3/60 bg-card-lv1 divide-card-lv3/60 flex flex-col divide-y overflow-hidden rounded-xl border">
                    {agents.map((agent) => (
                        <AgentRow
                            key={agent.id}
                            agent={agent}
                            href={agentPageHref(
                                repositoryId,
                                agent.id,
                                directoryId,
                            )}
                            chips={agentChips(agent, knowledge)}
                            usage={
                                // Usage is counted per repository.
                                isGlobal
                                    ? undefined
                                    : agentUsageLine(
                                          status.data?.agents.find(
                                              (entry) =>
                                                  entry.agentId === agent.id,
                                          ),
                                          windowDays,
                                      )
                            }
                            canEdit={canEdit}
                            // A list save writes only the agents and would
                            // mark the page's other edits as saved.
                            busy={isSubmitting || otherFieldsDirty}
                            onToggle={(enabled) => toggle(agent, enabled)}
                            onDelete={() => setDeleting(agent)}
                        />
                    ))}
                </ul>
            )}

            <NewAgentDialog open={dialogOpen} onOpenChange={setDialogOpen} />
            <ConfirmModal
                open={!!deleting}
                title={`Delete ${deleting?.name ?? "agent"}?`}
                description={deleteAgentNote(
                    deleting?.id ?? "",
                    inheritedAgents,
                )}
                confirmText="Delete agent"
                loading={isSubmitting}
                onConfirm={confirmDelete}
                onCancel={() => setDeleting(null)}
            />
        </div>
    );
};

/** The header's "New agent" button, with the dialog it opens. */
export const NewAgentButton = ({ canEdit }: { canEdit: boolean }) => {
    const [open, setOpen] = useState(false);
    return (
        <>
            <Button
                size="sm"
                variant="secondary"
                leftIcon={<PlusIcon />}
                disabled={!canEdit}
                onClick={() => setOpen(true)}>
                New agent
            </Button>
            <NewAgentDialog open={open} onOpenChange={setOpen} />
        </>
    );
};

/**
 * The agents on the "What to review" page, beside the categories Kody reviews:
 * the same list as the Custom agents page.
 */
export const CustomAgentsSection = ({ canEdit }: { canEdit: boolean }) => {
    const { repositoryId, directoryId } = useCustomAgentsForm();
    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-end justify-between gap-3">
                <div className="flex flex-col gap-1">
                    <Heading variant="h2">Custom agents</Heading>
                    <p className="text-text-secondary text-sm">
                        Reviewers your team defines, each with its own
                        instructions, files and tools. They run next to Kody on
                        the pull requests their files match.{" "}
                        <Link
                            className="text-primary-light hover:underline"
                            href={skillsPageHref(repositoryId, directoryId)}>
                            Skills &amp; docs
                        </Link>
                    </p>
                </div>
                <NewAgentButton canEdit={canEdit} />
            </div>
            <CustomAgentsList canEdit={canEdit} />
        </div>
    );
};
