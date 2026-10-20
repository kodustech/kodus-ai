"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from "@components/ui/dialog";
import { toast } from "@components/ui/toaster/use-toast";
import {
    agentFromSkill,
    createAgentFromTemplate,
    CUSTOM_AGENT_TEMPLATES,
    setKnowledgeLink,
    type CustomAgentTemplateId,
} from "@services/custom-agents/drafts";
import { useResolveCustomAgent } from "@services/custom-agents/hooks";
import type {
    CustomAgent,
    KnowledgeCandidate,
} from "@services/custom-agents/types";
import { FolderGit2Icon } from "lucide-react";
import { cn } from "src/core/utils/components";

import {
    customAgentsSaveErrorToast,
    logCustomAgentsSaveError,
} from "../../_utils/settings-save-conflict";
import { agentPageHref, useCustomAgentsForm } from "./use-custom-agents-form";

/**
 * Starts an agent from a template, or from a skill already in the
 * repository. The agent is saved right away, turned off, so the team can
 * try it before it comments on pull requests.
 */
export const NewAgentDialog = ({
    open,
    onOpenChange,
    onCreated,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** Where the new agent opens; its full page when not given. */
    onCreated?: (agentId: string) => void;
}) => {
    const router = useRouter();
    const {
        teamId,
        repositoryId,
        directoryId,
        agents,
        linkableAgents,
        knowledge,
        otherFieldsDirty,
        save,
    } = useCustomAgentsForm();
    const [tab, setTab] = useState<"templates" | "repository">("templates");
    const isGlobal = repositoryId === "global";
    const [saving, setSaving] = useState(false);
    const discover = useResolveCustomAgent({
        teamId,
        repositoryId,
        discover: true,
        enabled: open && tab === "repository",
    });
    const candidates =
        discover.data?.knowledge.status === "ok"
            ? (discover.data.knowledge.candidates ?? []).filter(
                  (candidate) => candidate.kind === "skill",
              )
            : [];

    const create = async (
        agent: CustomAgent,
        link?: { path: string; kind: "skill" | "doc" },
    ) => {
        setSaving(true);
        try {
            const nextKnowledge = link
                ? setKnowledgeLink(knowledge, link, { agentId: agent.id }, true)
                : knowledge;
            await save({
                agents: [...agents, agent],
                knowledge: nextKnowledge,
            });
            onOpenChange(false);
            if (onCreated) onCreated(agent.id);
            else
                router.push(agentPageHref(repositoryId, agent.id, directoryId));
        } catch (error) {
            logCustomAgentsSaveError("Error creating custom agent:", error, {
                teamId,
                repositoryId,
                directoryId,
            });
            toast(
                customAgentsSaveErrorToast(
                    error,
                    "Couldn't create the agent. Try again.",
                ),
            );
        } finally {
            setSaving(false);
        }
    };

    // Ids and names are taken from every agent a review here runs: at a
    // directory an own agent with an inherited id replaces that agent, which
    // only "Override at this directory" means to do.
    const fromTemplate = (id: CustomAgentTemplateId) =>
        create(createAgentFromTemplate(id, linkableAgents));
    const fromSkill = (candidate: KnowledgeCandidate) => {
        const { agent, link } = agentFromSkill(candidate, linkableAgents);
        return create(agent, link);
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-2xl">
                <DialogHeader>
                    <DialogTitle>New agent</DialogTitle>
                    <DialogDescription>
                        It starts off. Try it on a pull request, then turn it on
                        to comment on the ones its files match.
                    </DialogDescription>
                </DialogHeader>

                {otherFieldsDirty && (
                    <p className="text-warning text-sm">
                        Save or discard the other changes on this page first.
                    </p>
                )}

                <div className="flex flex-wrap items-center gap-2">
                    <Button
                        size="xs"
                        variant={tab === "templates" ? "primary" : "helper"}
                        onClick={() => setTab("templates")}>
                        Templates
                    </Button>
                    <Button
                        size="xs"
                        variant={tab === "repository" ? "primary" : "helper"}
                        disabled={isGlobal}
                        aria-describedby={
                            isGlobal ? "import-skill-global" : undefined
                        }
                        onClick={() => setTab("repository")}>
                        Import from repository
                    </Button>
                    {isGlobal && (
                        <span
                            id="import-skill-global"
                            className="text-text-tertiary text-xs">
                            Skills live in each repository — open a repository
                            to import one.
                        </span>
                    )}
                </div>

                {tab === "templates" && (
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        {CUSTOM_AGENT_TEMPLATES.map((template) => (
                            <button
                                key={template.id}
                                type="button"
                                disabled={saving || otherFieldsDirty}
                                onClick={() => fromTemplate(template.id)}
                                className={cn(
                                    "border-card-lv3/60 bg-card-lv1 hover:bg-card-lv2 flex flex-col gap-1 rounded-xl border px-4 py-3 text-left transition-colors disabled:opacity-60",
                                )}>
                                <span className="text-text-primary flex items-center gap-2 text-sm font-medium">
                                    <span
                                        className="size-2.5 rounded-full"
                                        style={{
                                            backgroundColor: template.color,
                                        }}
                                    />
                                    {template.id === "blank"
                                        ? "Blank"
                                        : template.name}
                                </span>
                                <span className="text-text-secondary text-xs">
                                    {template.description}
                                </span>
                            </button>
                        ))}
                    </div>
                )}

                {tab === "repository" && (
                    <div className="flex flex-col gap-2">
                        <p className="text-text-secondary text-xs">
                            Skills found on the default branch. Each becomes a
                            reviewer that follows it: the agent loads the skill
                            from the repository on every review, so edits there
                            apply without coming back here.
                        </p>
                        {discover.isLoading && (
                            <p className="text-text-secondary text-sm">
                                Reading the repository…
                            </p>
                        )}
                        {discover.data?.knowledge.status === "unavailable" && (
                            <p className="text-warning text-sm">
                                {discover.data.knowledge.reason}
                            </p>
                        )}
                        {discover.isError && (
                            <p className="text-danger text-sm">
                                Couldn&apos;t read the repository. Try again.
                            </p>
                        )}
                        {discover.isSuccess &&
                            discover.data.knowledge.status === "ok" &&
                            candidates.length === 0 && (
                                <p className="text-text-secondary text-sm">
                                    No skills on{" "}
                                    {discover.data.repository.branch}. A skill
                                    is a folder with a SKILL.md, e.g.
                                    .claude/skills/&lt;name&gt;/SKILL.md.
                                </p>
                            )}
                        {candidates.map((candidate) => (
                            <button
                                key={candidate.path}
                                type="button"
                                disabled={
                                    saving ||
                                    otherFieldsDirty ||
                                    !!candidate.errors
                                }
                                onClick={() => fromSkill(candidate)}
                                className="border-card-lv3/60 bg-card-lv1 hover:bg-card-lv2 flex items-start gap-3 rounded-xl border px-4 py-3 text-left disabled:opacity-60">
                                <FolderGit2Icon className="text-text-secondary mt-0.5 size-4 shrink-0" />
                                <span className="flex min-w-0 flex-col gap-0.5">
                                    <span className="text-text-primary text-sm font-medium">
                                        {candidate.name ?? candidate.path}
                                    </span>
                                    <span className="text-text-tertiary truncate text-xs">
                                        {candidate.path}
                                    </span>
                                    {candidate.description && (
                                        <span className="text-text-secondary text-xs">
                                            {candidate.description}
                                        </span>
                                    )}
                                    {candidate.errors && (
                                        <span className="text-warning text-xs">
                                            Not a valid skill:{" "}
                                            {candidate.errors.join("; ") ||
                                                "it could not be read"}
                                        </span>
                                    )}
                                </span>
                            </button>
                        ))}
                    </div>
                )}
            </DialogContent>
        </Dialog>
    );
};
