import { authorizedFetch } from "@services/fetch";
import { pathToApiUrl } from "src/core/utils/helpers";

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

export const tryCustomAgent = (body: {
    teamId: string;
    repositoryId: string;
    prUrl: string;
    agent: CustomAgent;
    knowledge?: KnowledgeItem[];
}) =>
    authorizedFetch<CustomAgentTryTrace>(CUSTOM_AGENTS_PATHS.TRY, {
        method: "POST",
        body: JSON.stringify(body),
    });

export const getCustomAgentsStatus = (params: {
    teamId: string;
    repositoryId: string;
}) =>
    authorizedFetch<CustomAgentsStatus>(CUSTOM_AGENTS_PATHS.STATUS, {
        params,
    });
