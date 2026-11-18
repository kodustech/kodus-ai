import type { CentralizedPrMetadata } from './config.js';

/** FormattedConfigLevel in libs/core/.../codeReviewConfig.type.ts. */
export type FormattedConfigLevel =
    | 'default'
    | 'global'
    | 'repository'
    | 'repository_file'
    | 'directory'
    | 'directory_file';

/** One leaf of the formatted config: its value and the level it came from. */
export interface FormattedConfigLeaf {
    value: unknown;
    level: FormattedConfigLevel;
    overriddenValue?: unknown;
    overriddenLevel?: FormattedConfigLevel;
}

export type FormattedConfigNode = { [key: string]: unknown };

export interface FormattedDirectoryConfig {
    id: string;
    name?: string;
    folders?: Array<{ id?: string; name?: string; path: string }>;
    configs?: FormattedConfigNode;
    kodusConfigFile?: { status?: string };
}

export interface FormattedRepositoryConfig {
    id: string;
    name?: string;
    isSelected?: boolean;
    configs?: FormattedConfigNode;
    directories?: FormattedDirectoryConfig[];
    kodusConfigFile?: { status?: string };
}

export interface FormattedCodeReviewParameter {
    uuid?: string;
    configKey?: string;
    configValue: {
        configs?: FormattedConfigNode;
        repositories?: FormattedRepositoryConfig[];
    };
}

/** GET /parameters/code-review-scopes. */
export interface CodeReviewScope {
    id: string;
    name: string;
    isSelected: boolean;
    directories: Array<{ id: string; name: string; paths: string[] }>;
}

export interface SaveCodeReviewConfigParams {
    teamId: string;
    configValue: Record<string, unknown>;
    repositoryId?: string;
    directoryId?: string;
    directoryPaths?: string[];
    inheritFields?: string[];
    expectedConfigId?: string;
}

export type SaveCodeReviewConfigResult =
    | (CentralizedPrMetadata & { mode: 'centralized-pr' })
    | Record<string, unknown>;

export interface PreviewPrRiskParams {
    teamId: string;
    repositoryId: string;
    prNumber: number;
    criteria: unknown[];
}

export interface PreviewPrRiskResult {
    assessment:
        | { status: 'disabled' }
        | { status: 'assessed'; riskIdentified: boolean; reason: string }
        | { status: 'unavailable'; reason: string };
    files: Array<{ path: string; previousPath?: string; status: string }>;
}

export interface ApprovalPolicy {
    id: string;
    name: string;
    enabled: boolean;
    labels?: string[];
    authors?: string[];
    authorTeams?: string[];
    includedFiles?: string[];
    excludedFiles?: string[];
    maxChangedLines?: number;
    lineCountExcludedFiles?: string[];
    instruction?: string;
}

export interface PreviewPrApprovalParams {
    teamId: string;
    repositoryId: string;
    prNumber: number;
    policies?: unknown[];
    assumeClean?: boolean;
    assumeEnabled?: boolean;
}

export interface PreviewPrApprovalResult {
    snapshot: { headSha?: string; baseSha?: string };
    assumptions: {
        cleanReview: boolean;
        automaticApproval: boolean;
        draftPolicies: boolean;
    };
    decision: {
        kind: 'approve' | 'hold' | 'out-of-scope' | 'disabled';
        reason: string;
        matchedPolicy?: Pick<ApprovalPolicy, 'id' | 'name'>;
        policies?: Array<{
            policyId: string;
            policyName: string;
            status: string;
            reason: string;
        }>;
    };
}

/** GET /organization-parameters/llm-config/status (never carries a key). */
export interface LLMConfigStatus {
    source: string;
    models: Array<{
        modelId: string;
        model?: string;
        providerId?: string;
        resolvable: boolean;
    }>;
    byok: {
        configured: boolean;
        model?: string;
        providerId?: string;
    };
}

/** POST /organization-parameters/test-byok-model. */
export interface TestByokModelResult {
    ok: boolean;
    code: string;
    latencyMs: number;
    message?: string;
    providerMessage?: string;
    httpStatus?: number;
    verifiedBy?: 'catalog' | 'probe';
}
