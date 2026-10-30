import { authorizedFetch } from "@services/fetch";
import { pathToApiUrl } from "src/core/utils/helpers";

import { pollTryRun, type TryRunView } from "./try-run";
import type {
    CustomAgent,
    CustomAgentResolveReport,
    CustomAgentsStatus,
    CustomAgentTryTrace,
    KnowledgeItem,
} from "./types";

export const CUSTOM_AGENTS_PATHS = {
    RESOLVE: pathToApiUrl("/code-review/custom-agents/resolve"),
    TRY: pathToApiUrl("/code-review/custom-agents/try"),
    TRY_RUN: (runId: string) =>
        pathToApiUrl(
            `/code-review/custom-agents/try/${encodeURIComponent(runId)}`,
        ),
    STATUS: pathToApiUrl("/code-review/custom-agents/status"),
};

export const resolveCustomAgent = (body: {
    teamId: string;
    repositoryId: string;
    agent?: CustomAgent;
    knowledge?: KnowledgeItem[];
    discover?: boolean;
}) =>
    authorizedFetch<CustomAgentResolveReport>(CUSTOM_AGENTS_PATHS.RESOLVE, {
        method: "POST",
        body: JSON.stringify(body),
    });

export const tryCustomAgent = async (body: {
    teamId: string;
    repositoryId: string;
    directoryId?: string;
    prUrl: string;
    agent: CustomAgent;
    knowledge?: KnowledgeItem[];
}): Promise<CustomAgentTryTrace> => {
    const started = await authorizedFetch<TryRunView>(CUSTOM_AGENTS_PATHS.TRY, {
        method: "POST",
        body: JSON.stringify(body),
    });
    return pollTryRun(started, (runId) =>
        authorizedFetch<TryRunView>(CUSTOM_AGENTS_PATHS.TRY_RUN(runId), {
            params: { teamId: body.teamId, repositoryId: body.repositoryId },
        }),
    );
};

export const getCustomAgentsStatus = (params: {
    teamId: string;
    repositoryId: string;
}) =>
    authorizedFetch<CustomAgentsStatus>(CUSTOM_AGENTS_PATHS.STATUS, {
        params,
    });
