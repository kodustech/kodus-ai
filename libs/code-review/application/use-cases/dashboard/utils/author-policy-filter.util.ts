import { PullRequestAuthorPolicy } from '@libs/code-review/dtos/dashboard/pull-request-author-policy.constants';
import { OrganizationParametersAutoAssignConfig } from '@libs/organization/domain/organizationParameters/types/organizationParameters.types';
import { authorFiltersFor } from '@libs/organization/domain/organizationParameters/utils/author-filters';

export type AuthorPolicyConfigValue = {
    ignoredUsers?: string[];
    allowedUsers?: string[];
} | null;

export interface CompiledAuthorPolicyConfig {
    ignoredUsers: Set<string>;
    allowedUsers: Set<string> | null;
}

export const compileAuthorPolicyConfig = (
    configValue: AuthorPolicyConfigValue,
): CompiledAuthorPolicyConfig => {
    const ignoredUsers = new Set(
        (Array.isArray(configValue?.ignoredUsers)
            ? configValue.ignoredUsers
            : []
        )
            .map((id) => String(id).trim())
            .filter(Boolean),
    );

    const normalizedAllowed = (
        Array.isArray(configValue?.allowedUsers) ? configValue.allowedUsers : []
    )
        .map((id) => String(id).trim())
        .filter(Boolean);

    return {
        ignoredUsers,
        allowedUsers:
            normalizedAllowed.length > 0 ? new Set(normalizedAllowed) : null,
    };
};

export const isAuthorExcludedByPolicy = (
    authorId: unknown,
    config: CompiledAuthorPolicyConfig,
): boolean => {
    if (authorId === null || authorId === undefined) {
        return false;
    }

    const normalizedAuthorId = String(authorId).trim();

    if (!normalizedAuthorId) {
        return false;
    }

    if (config.allowedUsers && !config.allowedUsers.has(normalizedAuthorId)) {
        return true;
    }

    return config.ignoredUsers.has(normalizedAuthorId);
};

export const shouldIncludeAuthorByPolicy = (params: {
    policy: PullRequestAuthorPolicy;
    authorId: unknown;
    config: CompiledAuthorPolicyConfig;
}): boolean => {
    const { policy, authorId, config } = params;

    if (policy === 'all') {
        return true;
    }

    const excluded = isAuthorExcludedByPolicy(authorId, config);

    if (policy === 'reviewable') {
        return !excluded;
    }

    return excluded;
};

/**
 * The compiled policy of each PR's Git connection, found from its repository.
 * A repository no connection lists gets the organization's lists.
 */
export const compileAuthorPolicyByConnection = (
    configValue: Partial<OrganizationParametersAutoAssignConfig> | null,
    repositoryConnection: ReadonlyMap<string, string>,
): ((repositoryId?: string) => CompiledAuthorPolicyConfig) => {
    const compiled = new Map<string, CompiledAuthorPolicyConfig>();
    const compileFor = (integrationId?: string) => {
        const key = integrationId ?? '';
        let config = compiled.get(key);
        if (!config) {
            config = compileAuthorPolicyConfig(
                authorFiltersFor(configValue, integrationId),
            );
            compiled.set(key, config);
        }
        return config;
    };
    return (repositoryId) =>
        compileFor(
            repositoryId
                ? repositoryConnection.get(String(repositoryId))
                : undefined,
        );
};
