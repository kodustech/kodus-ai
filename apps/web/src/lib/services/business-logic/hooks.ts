import { useMutation, useQuery } from "@tanstack/react-query";

import {
    BUSINESS_LOGIC_PATHS,
    getBusinessLogicStatus,
    getIntentCockpit,
    getReadTools,
    getTaskSources,
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
        staleTime: 5 * 60 * 1000,
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
