import { useMutation, useQuery } from "@tanstack/react-query";

import {
    CUSTOM_AGENTS_PATHS,
    getCustomAgentsStatus,
    resolveCustomAgent,
    tryCustomAgent,
} from "./fetch";
import type { CustomAgent, KnowledgeItem } from "./types";

export const useCustomAgentsStatus = (params: {
    teamId?: string;
    repositoryId?: string;
    enabled?: boolean;
}) =>
    useQuery({
        queryKey: [
            CUSTOM_AGENTS_PATHS.STATUS,
            params.teamId,
            params.repositoryId,
        ],
        queryFn: () =>
            getCustomAgentsStatus({
                teamId: params.teamId!,
                repositoryId: params.repositoryId!,
            }),
        enabled:
            !!params.teamId &&
            !!params.repositoryId &&
            params.enabled !== false,
        staleTime: 60 * 1000,
        retry: false,
    });

/**
 * Checks the agent and knowledge on screen against the repository's default
 * branch. Keyed on the draft, so an edit re-checks it.
 */
export const useResolveCustomAgent = (params: {
    teamId?: string;
    repositoryId?: string;
    agent?: CustomAgent;
    knowledge?: KnowledgeItem[];
    discover?: boolean;
    enabled?: boolean;
}) =>
    useQuery({
        queryKey: [
            CUSTOM_AGENTS_PATHS.RESOLVE,
            params.teamId,
            params.repositoryId,
            params.agent ?? null,
            params.knowledge ?? null,
            params.discover === true,
        ],
        queryFn: () =>
            resolveCustomAgent({
                teamId: params.teamId!,
                repositoryId: params.repositoryId!,
                agent: params.agent,
                knowledge: params.knowledge,
                discover: params.discover,
            }),
        enabled:
            !!params.teamId &&
            !!params.repositoryId &&
            params.repositoryId !== "global" &&
            params.enabled !== false,
        // Every edit is a new draft to check; keep the last report on screen
        // meanwhile so the sections do not fall back to loading.
        placeholderData: (previous) => previous,
        staleTime: 30 * 1000,
        retry: false,
    });

export const useTryCustomAgent = () =>
    useMutation({ mutationFn: tryCustomAgent });
