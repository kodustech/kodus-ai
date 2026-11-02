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
}

export type SaveCodeReviewConfigResult =
    | (CentralizedPrMetadata & { mode: 'centralized-pr' })
    | Record<string, unknown>;

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
