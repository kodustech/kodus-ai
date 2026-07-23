import { authorizedFetch } from '@services/fetch';
import type { CentralizedPrResponse } from '@services/parameters/types';
import { ProgrammingLanguage } from 'src/core/enums/programming-language';
import { axiosAuthorized } from 'src/core/utils/axios';

import { KODY_RULES_PATHS } from '.';
import type {
    KodyRule,
    KodyRuleBucket,
    KodyRulesStatus,
    KodyRulesType,
    KodyRuleSuggestion,
    LibraryRule,
    PaginatedResponse,
} from './types';

export type FastSyncIDERulesPayload = {
    teamId: string;
    repositoryId: string;
    maxFiles?: number;
    maxFileSizeBytes?: number;
    maxTotalBytes?: number;
};

export type FastSyncIDERulesResponse = {
    rules: KodyRule[];
    skippedFiles?: unknown[];
    errors?: unknown[];
};

export type ReviewFastIDERulesPayload = {
    teamId: string;
    activateRuleIds?: string[];
    deleteRuleIds?: string[];
};

export type ReviewFastIDERulesResponse = {
    activatedRules?: KodyRule[];
    deletedRules?: KodyRule[];
    errors?: unknown[];
};

export type KodyRuleMutationResponse = KodyRule | CentralizedPrResponse;

export const createOrUpdateKodyRule = async (
    rule: KodyRule,
    repositoryId?: string,
    directoryId?: string,
    teamId?: string,
): Promise<KodyRuleMutationResponse> => {
    const response = await axiosAuthorized.post<any>(
        KODY_RULES_PATHS.CREATE_OR_UPDATE,
        { ...rule, repositoryId, directoryId, teamId },
    );

    if (response && typeof response === 'object' && 'data' in response) {
        return (response as { data?: KodyRuleMutationResponse })
            .data as KodyRuleMutationResponse;
    }

    return response as KodyRuleMutationResponse;
};

export const addKodyRuleToRepositories = async (props: {
    repositoriesIds: string[];
    directoriesIds: Array<{ directoryId: string; repositoryId: string }>;
    rule: KodyRule;
    teamId?: string;
}): Promise<KodyRule[] | CentralizedPrResponse> => {
    const response = await axiosAuthorized.post<any>(
        KODY_RULES_PATHS.ADD_LIBRARY_KODY_RULES,
        {
            ...props.rule,
            repositoriesIds: props.repositoriesIds,
            directoriesInfo: props.directoriesIds,
            teamId: props.teamId,
        },
    );

    return response.data as KodyRule[] | CentralizedPrResponse;
};

export const deleteKodyRule = async (
    ruleId: string,
    teamId?: string,
): Promise<boolean | CentralizedPrResponse> => {
    const response = await axiosAuthorized.deleted<any>(
        KODY_RULES_PATHS.DELETE_BY_ORGANIZATION_ID_AND_ROLE_UUID,
        { params: { ruleId, teamId } },
    );

    if (response && typeof response === 'object' && 'data' in response) {
        return (response as { data?: boolean | CentralizedPrResponse }).data as
            | boolean
            | CentralizedPrResponse;
    }

    return response as boolean | CentralizedPrResponse;
};

export const getLibraryKodyRulesWithFeedback = async (params?: {
    page?: number;
    limit?: number;
    buckets?: string[];
    name?: string;
    severity?: string;
    tags?: string[];
    language?: keyof typeof ProgrammingLanguage;
    plug_and_play?: boolean;
}) => {
    // Build params object for authorizedFetch
    const fetchParams: Record<string, string | number | boolean | undefined> = {
        page: params?.page || 1,
        limit: params?.limit || 50,
    };

    // Add other filters if provided
    if (params?.name) fetchParams.title = params.name; // Backend expects 'title' not 'name'
    if (params?.severity) fetchParams.severity = params.severity;
    if (params?.language) fetchParams.language = String(params.language);
    if (params?.plug_and_play) fetchParams.plug_and_play = true;

    // For arrays, we need to handle them as multiple parameters with the same key
    // But since authorizedFetch doesn't handle array params well, we'll build the URL manually
    const queryParams = new URLSearchParams();

    Object.entries(fetchParams).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
            queryParams.append(key, String(value));
        }
    });

    // Add bucket filters as multiple parameters
    if (params?.buckets && params.buckets.length > 0) {
        params.buckets.forEach((bucket) => {
            queryParams.append('buckets', bucket);
        });
    }

    // Add tag filters as multiple parameters
    if (params?.tags && params.tags.length > 0) {
        params.tags.forEach((tag) => {
            queryParams.append('tags', tag);
        });
    }

    const url = `${KODY_RULES_PATHS.FIND_LIBRARY_KODY_RULES_WITH_FEEDBACK}?${queryParams.toString()}`;

    const response = await authorizedFetch<PaginatedResponse<LibraryRule>>(url);
    return response;
};

export const getLibraryKodyRulesBuckets = async () => {
    const response = await authorizedFetch<Array<KodyRuleBucket>>(
        KODY_RULES_PATHS.FIND_LIBRARY_KODY_RULES_BUCKETS,
    );
    return response || [];
};

export const fastSyncIDERules = async (
    payload: FastSyncIDERulesPayload,
): Promise<FastSyncIDERulesResponse> => {
    const response = await axiosAuthorized.post<FastSyncIDERulesResponse>(
        KODY_RULES_PATHS.FAST_SYNC_IDE_RULES,
        payload,
    );

    return response;
};

export const getKodyRulesByRepositoryId = async (
    repositoryId: string,
    directoryId?: string,
    type?: KodyRulesType,
    tags?: string[],
) => {
    const rules = await authorizedFetch<Array<KodyRule>>(
        KODY_RULES_PATHS.FIND_BY_ORGANIZATION_ID_AND_FILTER,
        {
            params: { repositoryId, directoryId, type },
            next: { tags },
        },
    );

    return rules;
};

export const getAllOrganizationKodyRules = async (type?: KodyRulesType) => {
    const rules = await authorizedFetch<Array<KodyRule>>(
        KODY_RULES_PATHS.FIND_BY_ORGANIZATION_ID_AND_FILTER,
        { params: { type } },
    );
    return rules;
};

export const getPendingIDERules = async (params: {
    teamId: string;
    repositoryId?: string;
}) => {
    const rules = await authorizedFetch<Array<KodyRule>>(
        KODY_RULES_PATHS.PENDING_IDE_RULES,
        { params },
    );

    return rules;
};

export const getInheritedKodyRules = async (params: {
    teamId: string;
    repositoryId: string;
    directoryId?: string;
}) => {
    const rules = await authorizedFetch<{
        globalRules: KodyRule[];
        repoRules: KodyRule[];
        directoryRules: KodyRule[];
    }>(KODY_RULES_PATHS.GET_INHERITED_RULES, { params });
    return rules;
};

export const changeStatusKodyRules = async (
    ruleIds: string[],
    status: KodyRulesStatus,
) => {
    const response = await axiosAuthorized.post<any>(
        KODY_RULES_PATHS.CHANGE_STATUS_KODY_RULES,
        { ruleIds, status },
    );

    return response.data as KodyRule[] | CentralizedPrResponse;
};

export const applyPendingKodyRules = async (
    teamId: string,
    ruleIds: string[],
) => {
    const response = await axiosAuthorized.post<any>(
        KODY_RULES_PATHS.APPLY_PENDING_KODY_RULES,
        { teamId, ruleIds },
    );

    return response.data as KodyRule[] | CentralizedPrResponse;
};

export const discardPendingKodyRules = async (
    teamId: string,
    ruleIds: string[],
) => {
    const response = await axiosAuthorized.post<any>(
        KODY_RULES_PATHS.DISCARD_PENDING_KODY_RULES,
        { teamId, ruleIds },
    );

    return response.data as KodyRule[];
};

export const convertPendingUpdatesToNew = async (
    teamId: string,
    ruleIds: string[],
) => {
    const response = await axiosAuthorized.post<any>(
        KODY_RULES_PATHS.CONVERT_PENDING_UPDATES_TO_NEW,
        { teamId, ruleIds },
    );

    return response.data as KodyRule[] | CentralizedPrResponse;
};

export const generateKodyRules = async (
    teamId: string,
    months: number = 3,
    weeks?: number,
    days?: number,
) => {
    const response = await axiosAuthorized.post<any>(
        KODY_RULES_PATHS.GENERATE_KODY_RULES,
        {
            teamId,
            months,
            weeks,
            days,
        },
    );

    return response.data;
};

export const syncIDERules = (params: {
    teamId: string;
    repositoryId: string;
}) => {
    axiosAuthorized.post(KODY_RULES_PATHS.SYNC_IDE_RULES, params);
};

export type GlobalRulesSourceRepository = {
    id: string;
    name: string;
    fullName?: string;
};

export const getGlobalSourceRepositories = async (params: {
    teamId: string;
}): Promise<GlobalRulesSourceRepository[]> => {
    const url = `${KODY_RULES_PATHS.GLOBAL_SOURCE_REPOSITORIES}?teamId=${encodeURIComponent(params.teamId)}`;
    const result = await authorizedFetch<GlobalRulesSourceRepository[]>(url);
    return result ?? [];
};

export const setGlobalSourceRepositories = async (params: {
    teamId: string;
    repositories: GlobalRulesSourceRepository[];
}): Promise<GlobalRulesSourceRepository[]> => {
    const response =
        await axiosAuthorized.post<GlobalRulesSourceRepository[]>(
            KODY_RULES_PATHS.GLOBAL_SOURCE_REPOSITORIES,
            params,
        );
    return response;
};

export const resyncGlobalRules = async (params: {
    teamId: string;
}): Promise<{ repositories: number }> => {
    const response = await axiosAuthorized.post<{ repositories: number }>(
        KODY_RULES_PATHS.RESYNC_GLOBAL_RULES,
        params,
    );
    return response;
};

export const reviewFastIDERules = async (
    payload: ReviewFastIDERulesPayload,
): Promise<ReviewFastIDERulesResponse> => {
    const response = await axiosAuthorized.post<ReviewFastIDERulesResponse>(
        KODY_RULES_PATHS.REVIEW_FAST_IDE_RULES,
        payload,
    );

    return response;
};

export const getKodyRuleSuggestions = async (ruleId: string) => {
    const url = `${KODY_RULES_PATHS.GET_KODY_RULE_SUGGESTIONS}?ruleId=${ruleId}`;
    const suggestions = await authorizedFetch<KodyRuleSuggestion[]>(url);
    return suggestions || [];
};

export const getRecommendedKodyRules = async (params?: { limit?: number }) => {
    const queryParams = new URLSearchParams();
    if (params?.limit) {
        queryParams.append('limit', params.limit.toString());
    }

    const url = queryParams.toString()
        ? `${KODY_RULES_PATHS.FIND_RECOMMENDED_KODY_RULES}?${queryParams.toString()}`
        : KODY_RULES_PATHS.FIND_RECOMMENDED_KODY_RULES;

    const rules = await authorizedFetch<LibraryRule[]>(url);
    return rules || [];
};

/** Auto-synced ("imported") rules counted per status for a repository. Used by
 * the IDE auto-sync toggle-off modal and the orphan-rules banner.
 *
 * `pinned` counts ACTIVE+PAUSED rules whose source file carries `@kody-sync`.
 * The bulk pause/delete actions skip those, so the modal copy uses this to
 * tell the user "M pinned rules will be preserved" before they pick an
 * action and get a surprising result. */
export type ImportedKodyRulesCounts = {
    active: number;
    paused: number;
    deleted: number;
    pinned: number;
};

export const getImportedKodyRulesCount = async (params: {
    repositoryId: string;
}): Promise<ImportedKodyRulesCounts> => {
    const url = `${KODY_RULES_PATHS.COUNT_IMPORTED_KODY_RULES}?repositoryId=${encodeURIComponent(params.repositoryId)}`;
    const result = await authorizedFetch<ImportedKodyRulesCounts>(url);
    return result ?? { active: 0, paused: 0, deleted: 0, pinned: 0 };
};

export type ManageImportedKodyRulesAction = 'pause' | 'resume' | 'delete';

export const manageImportedKodyRules = async (params: {
    repositoryId: string;
    action: ManageImportedKodyRulesAction;
}): Promise<{
    action: ManageImportedKodyRulesAction;
    counts: ImportedKodyRulesCounts;
}> => {
    const response = await axiosAuthorized.post<{
        action: ManageImportedKodyRulesAction;
        counts: ImportedKodyRulesCounts;
    }>(KODY_RULES_PATHS.MANAGE_IMPORTED_KODY_RULES, params);
    return response;
};

export type PastReviewer = { id: string; name: string };

// Candidate git reviewers a client can exclude from Kody Rules learning
// (issue #1497): current members ∪ authors of PRs in the window.
export const getPastReviewers = async (params: {
    teamId: string;
    repositoryId?: string;
    months?: number;
}): Promise<PastReviewer[]> => {
    const result = await authorizedFetch<PastReviewer[]>(
        KODY_RULES_PATHS.PAST_REVIEWERS,
        { params },
    );
    return result ?? [];
};
