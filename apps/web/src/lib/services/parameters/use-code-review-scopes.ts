"use client";

import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import { useFetch } from "src/core/utils/reactQuery";

import { PARAMETERS_PATHS } from ".";

/** One switchable settings scope: a repository and its configured directories. */
export type CodeReviewScope = {
    id: string;
    name: string;
    isSelected: boolean;
    directories: Array<{ id: string; name: string; paths: string[] }>;
};

/**
 * The scopes a team can open in code review settings, as names and ids.
 *
 * Backed by `/parameters/code-review-scopes`, which returns no configuration
 * and never reads `kodus-config.yml` from the git provider — safe to fetch
 * from a menu or a drawer. `enabled` keeps it lazy.
 */
export const useCodeReviewScopes = (enabled = true) => {
    const { teamId } = useSelectedTeamId();
    const { data } = useFetch<Array<CodeReviewScope>>(
        PARAMETERS_PATHS.CODE_REVIEW_SCOPES,
        { params: { teamId } },
        enabled && Boolean(teamId),
        { staleTime: 60_000 },
    );
    return data ?? [];
};

/**
 * Link to a rule's detail panel in the scope that owns it.
 *
 * A rule can outlive its repository's configuration (the repository was
 * removed, or the rule arrived from an import) and the settings shell has
 * nothing to render for such a scope, so those fall back to Global.
 */
export const rulePageHref = (
    rule: {
        ruleId?: string;
        repositoryId?: string;
        directoryId?: string;
        memories?: boolean;
    },
    scopes: Array<CodeReviewScope>,
): string => {
    const scoped =
        rule.repositoryId &&
        rule.repositoryId !== "global" &&
        scopes.some((scope) => scope.id === rule.repositoryId);
    const query = new URLSearchParams();
    if (rule.ruleId) query.set("rule", rule.ruleId);
    if (rule.memories) query.set("tab", "memories");
    if (scoped && rule.directoryId) query.set("directoryId", rule.directoryId);
    const suffix = query.toString();
    return `/settings/code-review/${scoped ? rule.repositoryId : "global"}/kody-rules${suffix ? `?${suffix}` : ""}`;
};

/** The first configured folder path of a directory scope, or its name. */
export const directoryScopeLabel = (
    directory: CodeReviewScope["directories"][number],
) => {
    const paths = directory.paths ?? [];
    const path = paths[0] ?? directory.name;
    return paths.length > 1 ? `${path} +${paths.length - 1}` : path;
};
