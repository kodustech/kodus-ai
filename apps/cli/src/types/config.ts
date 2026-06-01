export interface ConfigRepository {
    id: string;
    name: string;
    full_name?: string;
    http_url?: string;
    organizationName: string;
    selected?: boolean;
    lastActivityAt?: string;
}

export interface ConfigAddRepositoriesResponse {
    status: boolean;
    addedRepositoryIds: string[];
    alreadyAddedRepositoryIds?: string[];
    totalSelected: number;
    message?: string;
}

export interface ConfigTeam {
    uuid: string;
    name: string;
    status: string;
}

export interface CodeReviewRepositoryConfigValue {
    id: string;
    name: string;
    configs?: {
        automatedReviewActive?: boolean;
        pullRequestApprovalActive?: boolean;
        isRequestChangesActive?: boolean;
        ignorePaths?: string[];
        baseBranches?: string[];
        ignoredTitleKeywords?: string[];
        suggestionControl?: {
            severityLevelFilter?: string;
            [key: string]: unknown;
        };
        [key: string]: unknown;
    };
}

export interface CodeReviewParameter {
    uuid?: string;
    configKey?: string;
    configValue: {
        repositories?: CodeReviewRepositoryConfigValue[];
        [key: string]: unknown;
    };
}

export interface CentralizedConfigRepository {
    id: string;
    name: string;
}

export interface CentralizedConfigStatus {
    enabled: boolean;
    repository: CentralizedConfigRepository | null;
}

export interface CentralizedConfigActionResponse {
    success: boolean;
    message: string;
    prUrl?: string;
}

export interface CentralizedPrMetadata {
    mode: 'direct' | 'centralized-pr';
    prUrl?: string;
    prNumber?: number;
    reused?: boolean;
    pending?: boolean;
    message?: string;
}
