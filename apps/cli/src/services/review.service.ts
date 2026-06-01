import { api } from './api/index.js';
import { authService } from './auth.service.js';
import { gitService } from './git.service.js';
import { getTrialIdentifier } from '../utils/rate-limit.js';
import { loadConfig } from '../utils/config.js';
import { CLI_VERSION } from '../constants.js';
import chalk from 'chalk';
import { cliDebug } from '../utils/logger.js';
import { withTeamKeyFallback } from './review-auth-fallback.js';
import { buildReviewConfig } from './review-config-builder.js';
import { filterReviewFiles } from './review-file-filter.js';
import {
    createAnalyzeApiRequestVerboseMessages,
    createAnalyzeApiResponseVerboseMessages,
    createAnalyzeStartVerboseMessages,
    createFullFileContentsVerboseMessages,
    createTrialAnalyzeResponseVerboseMessages,
    createTrialAnalyzeStartVerboseMessages,
} from './review-verbose.js';
import {
    normalizeSeverity,
    normalizeSuggestionsResponse,
} from './review-normalizer.js';
import type {
    BusinessValidationResponse,
    ReviewConfig,
    ReviewResult,
    Severity,
    TrialReviewResult,
} from '../types/review.js';

class ReviewService {
    private verbose: boolean = false;

    setVerbose(verbose: boolean): void {
        this.verbose = verbose;
    }

    private logVerbose(message: string): void {
        if (!this.verbose) {
            return;
        }
        cliDebug(chalk.dim(message));
    }

    async analyze(
        diff: string,
        rulesOnly?: boolean,
        fast?: boolean,
        options?: {
            files?: string[];
            staged?: boolean;
            commit?: string;
            branch?: string;
            quiet?: boolean;
            onProgress?: (status: string) => void;
        },
    ): Promise<ReviewResult> {
        const token = await authService.getValidToken();

        createAnalyzeStartVerboseMessages({ diff, rulesOnly, fast }).forEach(
            (message) => this.logVerbose(message),
        );

        const reviewConfig: ReviewConfig = await buildReviewConfig({
            rulesOnly,
            fast,
            options,
            getFullFileContents: (files, fileOptions) =>
                gitService.getFullFileContents(files, fileOptions),
            filterFiles: filterReviewFiles,
        });

        createFullFileContentsVerboseMessages(reviewConfig.files).forEach(
            (message) => this.logVerbose(message),
        );

        const teamConfig = await loadConfig();
        const isTeamKey = token.startsWith('kodus_');

        if (isTeamKey && teamConfig) {
            const gitInfo = await gitService.getGitInfo();
            const inferredPlatform = gitInfo.remote
                ? gitService.inferPlatform(gitInfo.remote)
                : undefined;

            createAnalyzeApiRequestVerboseMessages({
                diff,
                reviewConfig,
                mode: 'team-key',
                gitInfo: {
                    branch: gitInfo.branch,
                    remote: gitInfo.remote,
                },
            }).forEach((message) => this.logVerbose(message));

            const result = await api.review.analyzeWithMetrics(
                diff,
                token,
                reviewConfig,
                {
                    userEmail: gitInfo.userEmail,
                    gitRemote: gitInfo.remote || undefined,
                    branch: gitInfo.branch,
                    commitSha: gitInfo.commitSha,
                    mergeBaseSha: gitInfo.mergeBaseSha,
                    inferredPlatform,
                    cliVersion: CLI_VERSION,
                },
                options?.onProgress,
            );

            createAnalyzeApiResponseVerboseMessages({
                summary: result.summary,
                issuesCount: result.issues?.length ?? 0,
                filesAnalyzed: result.filesAnalyzed,
            }).forEach((message) => this.logVerbose(message));

            return result;
        }

        // Personal token: also send git context for repository-scoped rules
        const gitInfo = await gitService.getGitInfo();
        const inferredPlatform = gitInfo.remote
            ? gitService.inferPlatform(gitInfo.remote)
            : undefined;

        createAnalyzeApiRequestVerboseMessages({
            diff,
            reviewConfig,
            mode: 'personal-token',
            gitInfo: {
                branch: gitInfo.branch,
                remote: gitInfo.remote,
            },
        }).forEach((message) => this.logVerbose(message));

        const result = await api.review.analyzeWithMetrics(
            diff,
            token,
            reviewConfig,
            {
                userEmail: gitInfo.userEmail,
                gitRemote: gitInfo.remote || undefined,
                branch: gitInfo.branch,
                commitSha: gitInfo.commitSha,
                mergeBaseSha: gitInfo.mergeBaseSha,
                inferredPlatform,
                cliVersion: CLI_VERSION,
            },
            options?.onProgress,
        );

        createAnalyzeApiResponseVerboseMessages({
            summary: result.summary,
            issuesCount: result.issues?.length ?? 0,
            filesAnalyzed: result.filesAnalyzed,
        }).forEach((message) => this.logVerbose(message));

        return result;
    }

    async getPullRequestSuggestions(params: {
        prUrl?: string;
        prNumber?: number;
        repositoryId?: string;
        format?: 'markdown';
        severity?: string;
        category?: string;
    }): Promise<{ result: ReviewResult; markdown?: string }> {
        if (!params.prUrl && !(params.prNumber && params.repositoryId)) {
            throw new Error(
                'Provide prUrl or prNumber with repositoryId to fetch pull request suggestions.',
            );
        }

        const token = await authService.getValidToken();

        const response = await withTeamKeyFallback({
            token,
            loadConfig,
            operation: (activeToken) =>
                api.review.getPullRequestSuggestions(activeToken, params),
        });

        return {
            result: normalizeSuggestionsResponse(response),
            markdown: response.markdown,
        };
    }

    async triggerBusinessValidation(params: {
        repository?: string;
        taskUrl?: string;
        taskId?: string;
        diff?: string;
    }): Promise<BusinessValidationResponse> {
        const token = await authService.getValidToken();

        return await withTeamKeyFallback({
            token,
            loadConfig,
            operation: (activeToken) =>
                api.review.triggerBusinessValidation(activeToken, params),
        });
    }

    async trialAnalyze(
        diff: string,
        options?: { githubPat?: string },
    ): Promise<TrialReviewResult> {
        const fingerprint = await getTrialIdentifier();

        // Pull git context so the sandbox can clone+apply (mergeBaseSha,
        // remote, branch, commitSha). Failures are non-fatal — getGitInfo
        // already swallows individual lookup errors.
        const gitInfo = await gitService.getGitInfo();
        const inferredPlatform = gitInfo.remote
            ? gitService.inferPlatform(gitInfo.remote)
            : undefined;

        createTrialAnalyzeStartVerboseMessages(diff).forEach((message) =>
            this.logVerbose(message),
        );

        const result = await api.review.trialAnalyze(
            diff,
            fingerprint,
            {
                userEmail: gitInfo.userEmail,
                gitRemote: gitInfo.remote || undefined,
                branch: gitInfo.branch,
                commitSha: gitInfo.commitSha,
                mergeBaseSha: gitInfo.mergeBaseSha,
                inferredPlatform,
                cliVersion: CLI_VERSION,
            },
            options?.githubPat,
        );

        createTrialAnalyzeResponseVerboseMessages({
            summary: result.summary,
            issuesCount: result.issues?.length ?? 0,
            filesAnalyzed: result.filesAnalyzed,
        }).forEach((message) => this.logVerbose(message));

        return result;
    }

    normalizeSeverity(severity?: string): Severity {
        return normalizeSeverity(severity);
    }
}

export const reviewService = new ReviewService();
