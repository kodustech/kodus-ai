import { PullRequestAuthorPolicy } from '@libs/code-review/dtos/dashboard/pull-request-author-policy.constants';

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
