import type { ListModelOverridesResult } from "@services/organizationParameters/fetch";

export type FolderOverride = { id: string; name: string; model: string };

/** A custom agent that pins its own model for one step (#2172). */
export type AgentOverride = {
    id: string;
    agentId: string;
    agentName: string;
    /** `run` = the agent itself, `check` = its finding check. */
    step: "run" | "check";
    model: string;
    /** Set when the agent is stored on a folder of a monorepo. */
    folderName?: string;
    /** The agent's own page, where its model is pinned. */
    href?: string;
};

export type RepoGroup = {
    id: string;
    name: string;
    model?: string;
    folders: FolderOverride[];
    agents: AgentOverride[];
};

/** Group key for agents stored on the global config (every repository). */
export const ALL_REPOSITORIES_ID = "__global__";

/** Group the flat override lists into repositories with their per-folder
 *  children and the custom agents that pin a model there. A repo is a
 *  "monorepo" here when it carries folder-scoped overrides. The `global`
 *  review model is the org default (shown elsewhere) and skipped; a global
 *  custom agent pin shows under "All repositories". */
/** The agent's page. Same shape as `agentPageHref` in the code review
 *  settings route (kept local so this module stays free of form code). */
const agentHref = (
    repositoryId: string | undefined,
    agentId: string,
    directoryId?: string,
) =>
    repositoryId
        ? `/settings/code-review/${repositoryId}/agents/${encodeURIComponent(agentId)}${
              directoryId ? `?directoryId=${directoryId}` : ""
          }`
        : undefined;

export const groupOverrides = (
    result: ListModelOverridesResult | null,
): RepoGroup[] => {
    const byRepo = new Map<string, RepoGroup>();
    const repoFor = (repoId: string, name: string) => {
        let repo = byRepo.get(repoId);
        if (!repo) {
            repo = { id: repoId, name, folders: [], agents: [] };
            byRepo.set(repoId, repo);
        }
        return repo;
    };
    const repoOf = (o: { repositoryId?: string; repositoryName?: string }) =>
        repoFor(
            o.repositoryId ?? o.repositoryName ?? "unknown",
            o.repositoryName ?? o.repositoryId ?? "repository",
        );

    for (const o of result?.overrides ?? []) {
        if (o.scope === "global") continue;
        const repo = repoOf(o);
        if (o.scope === "repository") {
            repo.model = o.model;
        } else if (o.scope === "directory") {
            repo.folders.push({
                // Index-suffixed fallback so two folders that both lack id AND
                // name still get distinct React keys.
                id:
                    o.directoryId ??
                    o.directoryName ??
                    `${repo.id}-dir-${repo.folders.length}`,
                name: o.directoryName ?? o.directoryId ?? "folder",
                model: o.model,
            });
        }
    }

    for (const a of result?.customAgentOverrides ?? []) {
        const repo =
            a.scope === "global"
                ? repoFor(ALL_REPOSITORIES_ID, "All repositories")
                : repoOf(a);
        const folder =
            a.scope === "directory"
                ? (a.directoryId ?? a.directoryName ?? "folder")
                : undefined;
        repo.agents.push({
            id: [repo.id, folder, a.agentId, a.step].filter(Boolean).join(":"),
            agentId: a.agentId,
            agentName: a.agentName,
            step: a.step,
            model: a.model,
            ...(a.scope === "directory"
                ? { folderName: a.directoryName ?? a.directoryId ?? "folder" }
                : {}),
            href: agentHref(
                a.scope === "global" ? "global" : a.repositoryId,
                a.agentId,
                a.scope === "directory" ? a.directoryId : undefined,
            ),
        });
    }

    return [...byRepo.values()];
};
