import { useMutation, useQuery } from "@tanstack/react-query";

import {
    BUSINESS_LOGIC_PATHS,
    getBusinessLogicStatus,
    getIntentCockpit,
    getReadTools,
    getTaskSources,
    testOnPullRequest,
    tryReadTask,
} from "./fetch";

export const useBusinessLogicStatus = (params: {
    teamId?: string;
    repositoryId?: string;
    enabled?: boolean;
}) =>
    useQuery({
        queryKey: [
            BUSINESS_LOGIC_PATHS.STATUS,
            params.teamId,
            params.repositoryId,
        ],
        queryFn: () =>
            getBusinessLogicStatus({
                teamId: params.teamId!,
                repositoryId: params.repositoryId,
            }),
        enabled: !!params.teamId && params.enabled !== false,
        staleTime: 60 * 1000,
        retry: false,
    });

export const useTaskSources = (teamId?: string) =>
    useQuery({
        queryKey: [BUSINESS_LOGIC_PATHS.TASK_SOURCES, teamId],
        queryFn: () => getTaskSources(teamId!),
        enabled: !!teamId,
        // Plugins are connected on another page: a cached list hid a tracker
        // connected a minute earlier. Read it again whenever the page opens.
        staleTime: 0,
        retry: false,
    });

export const useReadTools = (teamId?: string, integrationId?: string) =>
    useQuery({
        queryKey: [
            BUSINESS_LOGIC_PATHS.READ_TOOLS(integrationId ?? ""),
            teamId,
        ],
        queryFn: () => getReadTools(teamId!, integrationId!),
        enabled: !!teamId && !!integrationId,
        staleTime: 5 * 60 * 1000,
        retry: false,
    });

export const useTryReadTask = () => useMutation({ mutationFn: tryReadTask });

export const useTestOnPullRequest = () =>
    useMutation({ mutationFn: testOnPullRequest });

export const useIntentCockpit = (params: {
    startDate: string;
    endDate: string;
    teamId?: string;
}) =>
    useQuery({
        queryKey: [
            BUSINESS_LOGIC_PATHS.INTENT,
            params.startDate,
            params.endDate,
            params.teamId,
        ],
        queryFn: () => getIntentCockpit(params),
        staleTime: 5 * 60 * 1000,
    });
