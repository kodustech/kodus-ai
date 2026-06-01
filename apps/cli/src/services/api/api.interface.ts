import type { AuthResponse, UserInfo } from '../../types/auth.js';
import type {
    CentralizedConfigActionResponse,
    CentralizedPrMetadata,
    CentralizedConfigStatus,
    CodeReviewParameter,
    ConfigAddRepositoriesResponse,
    ConfigRepository,
    ConfigTeam,
} from '../../types/config.js';
import type {
    MemoryCaptureApiRequest,
    MemoryCaptureApiResponse,
} from '../../types/memory.js';
import type { RepositorySettings } from '../../types/repo-config.js';
import type {
    BusinessValidationResponse,
    PullRequestSuggestionsResponse,
    ReviewConfig,
    ReviewResult,
    TrialReviewResult,
} from '../../types/review.js';
import type {
    CreateKodyRuleRequest,
    KodyRule,
    KodyRuleMutationResult,
    UpdateKodyRuleRequest,
    ViewKodyRulesRequest,
} from '../../types/rules.js';
import type { SessionApiEvent } from '../../types/session-events.js';
import type { TrialStatus } from '../../types/trial.js';

export interface IAuthApi {
    login(email: string, password: string): Promise<AuthResponse>;
    refresh(refreshToken: string): Promise<AuthResponse>;
    logout(accessToken: string): Promise<void>;
    generateCIToken(accessToken: string): Promise<string>;
    verify(accessToken: string): Promise<{ valid: boolean; user?: UserInfo }>;
}

export interface GitMetrics {
    userEmail?: string;
    gitRemote?: string;
    branch?: string;
    commitSha?: string;
    /**
     * Merge-base between HEAD and the upstream default branch. Sent so the
     * sandbox can checkout this commit (always present on the remote) and
     * apply the local diff on top — works for branches not yet pushed and
     * for uncommitted changes.
     */
    mergeBaseSha?: string;
    inferredPlatform?: 'GITHUB' | 'GITLAB' | 'BITBUCKET' | 'AZURE_REPOS';
    cliVersion?: string;
}

export interface IReviewApi {
    analyze(
        diff: string,
        accessToken: string,
        config?: ReviewConfig,
    ): Promise<ReviewResult>;
    analyzeWithMetrics(
        diff: string,
        accessToken: string,
        config?: ReviewConfig,
        metrics?: GitMetrics,
        onProgress?: (status: string) => void,
    ): Promise<ReviewResult>;
    getPullRequestSuggestions(
        accessToken: string,
        params: {
            prUrl?: string;
            prNumber?: number;
            repositoryId?: string;
            format?: 'markdown';
            severity?: string;
            category?: string;
        },
    ): Promise<PullRequestSuggestionsResponse>;
    triggerBusinessValidation(
        accessToken: string,
        params: {
            repository?: string;
            taskUrl?: string;
            taskId?: string;
            diff?: string;
        },
    ): Promise<BusinessValidationResponse>;
    trialAnalyze(
        diff: string,
        fingerprint: string,
        metrics?: GitMetrics,
        githubPat?: string,
    ): Promise<TrialReviewResult>;
}

export interface ITrialApi {
    getStatus(fingerprint: string): Promise<TrialStatus>;
}

export interface IMemoryApi {
    submitCapture(
        payload: MemoryCaptureApiRequest,
        accessToken: string,
    ): Promise<MemoryCaptureApiResponse>;
}

export interface IConfigApi {
    getAvailableRepositories(accessToken: string): Promise<ConfigRepository[]>;
    getSelectedRepositories(accessToken: string): Promise<ConfigRepository[]>;
    getTeams(accessToken: string): Promise<ConfigTeam[]>;
    addRepositories(
        accessToken: string,
        repositoryIds: string[],
    ): Promise<ConfigAddRepositoriesResponse>;
    getCodeReviewParameter(
        accessToken: string,
        teamId: string,
    ): Promise<CodeReviewParameter>;
    createOrUpdateCodeReviewParameter(
        accessToken: string,
        params: {
            teamId: string;
            repositoryId?: string;
            configValue: Record<string, unknown>;
        },
    ): Promise<CodeReviewParameter>;
    updateCodeReviewParameterRepositories(
        accessToken: string,
        teamId: string,
    ): Promise<unknown>;
    getRepositorySettings(
        accessToken: string,
        repositoryId: string,
    ): Promise<RepositorySettings>;
    updateRepositorySettings(
        accessToken: string,
        repositoryId: string,
        settings: RepositorySettings,
    ): Promise<
        RepositorySettings | (CentralizedPrMetadata & { mode: 'centralized-pr' })
    >;
    getCentralizedConfigStatus(
        accessToken: string,
    ): Promise<CentralizedConfigStatus>;
    initCentralizedConfig(
        accessToken: string,
        params: {
            repositoryId: string;
            syncOption: 'pr' | 'manual';
        },
    ): Promise<CentralizedConfigActionResponse>;
    syncCentralizedConfig(
        accessToken: string,
    ): Promise<CentralizedConfigActionResponse>;
    disableCentralizedConfig(
        accessToken: string,
    ): Promise<CentralizedConfigActionResponse>;
    downloadCentralizedConfig(accessToken: string): Promise<Uint8Array>;
}

export interface ISessionsApi {
    sendEvent(event: SessionApiEvent, repoRoot: string): Promise<void>;
}

export interface IRulesApi {
    createRule(
        accessToken: string,
        payload: CreateKodyRuleRequest,
    ): Promise<KodyRuleMutationResult>;
    updateRule(
        accessToken: string,
        ruleId: string,
        payload: UpdateKodyRuleRequest,
    ): Promise<KodyRuleMutationResult>;
    viewRules(
        accessToken: string,
        query?: ViewKodyRulesRequest,
    ): Promise<KodyRule[]>;
}

export interface IKodusApi {
    auth: IAuthApi;
    config: IConfigApi;
    review: IReviewApi;
    trial: ITrialApi;
    memory: IMemoryApi;
    sessions: ISessionsApi;
    rules: IRulesApi;
}
