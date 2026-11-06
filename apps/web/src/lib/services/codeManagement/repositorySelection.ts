import { authorizedFetch } from "@services/fetch";
import { axiosAuthorized } from "src/core/utils/axios";

import { CODE_MANAGEMENT_API_PATHS } from "./types";

export type RepositorySelectionMode = "manual" | "all";

export type RepositorySyncStatus = {
    status: "running" | "done" | "failed" | "rate_limited";
    trigger?: "enable" | "cron" | "provider_event";
    startedAt: string;
    finishedAt?: string;
    lastSuccessAt?: string;
    visible?: number;
    skipped?: { archived: number; forksAndMirrors: number };
    total?: number;
    done?: number;
    added?: number;
    error?: string;
    pendingAstBuilds: number;
    pendingBackfills: number;
};

export type RepositorySelection = {
    mode: RepositorySelectionMode;
    includeForksAndMirrors: boolean;
    sync: RepositorySyncStatus | null;
};

export type RepositorySelectionPreview = {
    visible: number;
    eligible: number;
    alreadySelected: number;
    toAdd: number;
    skipped: { archived: number; forksAndMirrors: number };
};

/** Server components: reads through the authorized server-side path. */
export const getRepositorySelection = async (
    teamId: string,
): Promise<RepositorySelection> => {
    const response = await authorizedFetch<RepositorySelection>(
        CODE_MANAGEMENT_API_PATHS.REPOSITORY_SELECTION,
        { params: { teamId } },
    );

    return (
        response ?? {
            mode: "manual",
            includeForksAndMirrors: false,
            sync: null,
        }
    );
};

export const fetchRepositorySelection = (teamId: string) =>
    axiosAuthorized.fetcher<RepositorySelection>(
        CODE_MANAGEMENT_API_PATHS.REPOSITORY_SELECTION,
        { params: { teamId } },
    );

export const previewRepositorySelection = (
    teamId: string,
    includeForksAndMirrors: boolean,
) =>
    axiosAuthorized.fetcher<RepositorySelectionPreview>(
        CODE_MANAGEMENT_API_PATHS.REPOSITORY_SELECTION_PREVIEW,
        { params: { teamId, includeForksAndMirrors } },
    );

export const setRepositorySelection = (params: {
    teamId: string;
    mode: RepositorySelectionMode;
    includeForksAndMirrors?: boolean;
}) =>
    axiosAuthorized.put(CODE_MANAGEMENT_API_PATHS.REPOSITORY_SELECTION, params);
