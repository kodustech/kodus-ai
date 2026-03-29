import { createLogger } from '@kodus/flow';
import { Inject, Injectable } from '@nestjs/common';

import {
    COLLECT_CROSS_FILE_CONTEXTS_SERVICE_TOKEN,
    CollectCrossFileContextsService,
} from '@libs/code-review/infrastructure/adapters/services/collectCrossFileContexts.service';
import {
    ISandboxProvider,
    SANDBOX_PROVIDER_TOKEN,
} from '@libs/code-review/domain/contracts/sandbox.provider';
import { BasePipelineStage } from '@libs/core/infrastructure/pipeline/abstracts/base-stage.abstract';
import { StageVisibility } from '@libs/core/infrastructure/pipeline/enums/stage-visibility.enum';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { PlatformType } from '@libs/core/domain/enums';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import { CliReviewPipelineContext } from '@libs/cli-review/pipeline/context/cli-review-pipeline.context';

/**
 * Parse a git remote URL (HTTPS or SSH) into owner/repo parts.
 * Supports:
 *  - https://github.com/owner/repo.git
 *  - git@github.com:owner/repo.git
 */
export function parseGitRemoteUrl(
    url: string,
): { fullName: string; name: string } | null {
    // HTTPS format: https://github.com/owner/repo.git
    const httpsMatch = url.match(
        /https?:\/\/[^/]+\/([^/]+\/[^/]+?)(?:\.git)?$/,
    );
    if (httpsMatch) {
        const fullName = httpsMatch[1];
        const name = fullName.split('/')[1];
        return { fullName, name };
    }

    // SSH format: git@github.com:owner/repo.git
    const sshMatch = url.match(/[^@]+@[^:]+:([^/]+\/[^/]+?)(?:\.git)?$/);
    if (sshMatch) {
        const fullName = sshMatch[1];
        const name = fullName.split('/')[1];
        return { fullName, name };
    }

    return null;
}

@Injectable()
export class CollectCrossFileContextStage extends BasePipelineStage<CodeReviewPipelineContext> {
    readonly stageName = 'CollectCrossFileContextStage';
    readonly label = 'Gathering Cross-File Context';
    readonly visibility = StageVisibility.PRIMARY;

    private readonly logger = createLogger(CollectCrossFileContextStage.name);

    constructor(
        @Inject(COLLECT_CROSS_FILE_CONTEXTS_SERVICE_TOKEN)
        private readonly collectCrossFileContextsService: CollectCrossFileContextsService,
        @Inject(SANDBOX_PROVIDER_TOKEN)
        private readonly sandboxProvider: ISandboxProvider,
        private readonly codeManagementService: CodeManagementService,
    ) {
        super();
    }

    protected async executeStage(
        context: CodeReviewPipelineContext,
    ): Promise<CodeReviewPipelineContext> {
        const isCliMode = context.origin === 'cli';
        const cliContext = isCliMode
            ? (context as unknown as CliReviewPipelineContext)
            : undefined;
        const label = isCliMode
            ? `branch ${cliContext?.gitContext?.branch ?? 'unknown'}`
            : `PR#${context?.pullRequest?.number}`;

        // Guard: skip in fast mode (fast = speed over depth)
        if (cliContext?.isFastMode) {
            this.logger.log({
                message: `Skipping cross-file context collection: fast mode`,
                context: this.stageName,
                metadata: {
                    sandboxDecision: 'skipped',
                    sandboxSkipReason: 'fast_mode',
                },
            });
            return context;
        }

        // Guard: skip if crossFileDependenciesAnalysis is disabled
        if (context.codeReviewConfig?.crossFileDependenciesAnalysis === false) {
            this.logger.log({
                message: `Skipping cross-file context collection: crossFileDependenciesAnalysis is disabled for ${label}`,
                context: this.stageName,
                metadata: {
                    sandboxDecision: 'skipped',
                    sandboxSkipReason: 'disabled',
                    organizationAndTeamData: context?.organizationAndTeamData,
                    prNumber: context?.pullRequest?.number,
                },
            });
            return context;
        }

        // Guard: skip if no changed files
        if (!context?.changedFiles?.length) {
            this.logger.log({
                message: `Skipping cross-file context collection: no changed files for ${label}`,
                context: this.stageName,
                metadata: {
                    sandboxDecision: 'skipped',
                    sandboxSkipReason: 'no_changed_files',
                    organizationAndTeamData: context?.organizationAndTeamData,
                    prNumber: context?.pullRequest?.number,
                },
            });
            return context;
        }

        // Guard: skip if sandbox is not available
        if (!this.sandboxProvider.isAvailable()) {
            this.logger.log({
                message: `Skipping cross-file context collection: no sandbox provider configured for ${label}`,
                context: this.stageName,
                metadata: {
                    sandboxDecision: 'skipped',
                    sandboxSkipReason: 'no_provider',
                    organizationAndTeamData: context?.organizationAndTeamData,
                    prNumber: context?.pullRequest?.number,
                },
            });
            return context;
        }

        // Guard (CLI): skip if no git remote available
        if (isCliMode && !cliContext?.gitContext?.remote) {
            this.logger.log({
                message: `Skipping cross-file context collection: no git remote in CLI context`,
                context: this.stageName,
                metadata: {
                    sandboxDecision: 'skipped',
                    sandboxSkipReason: 'no_git_remote',
                },
            });
            return context;
        }

        let cleanup: (() => Promise<void>) | undefined;

        try {
            const cloneInfo = await this.resolveCloneParams(
                context,
                cliContext,
            );
            if (!cloneInfo) {
                this.logger.warn({
                    message: `[DEBUG] resolveCloneParams returned null for ${label}`,
                    context: this.stageName,
                    metadata: {
                        sandboxDecision: 'skipped',
                        sandboxSkipReason: 'no_clone_params',
                        prNumber: context?.pullRequest?.number,
                    },
                });
                return context;
            }

            this.logger.log({
                message: `[DEBUG] Clone params resolved for ${label}: url=${cloneInfo.url} platform=${cloneInfo.platform} branch=${cloneInfo.branch} prNumber=${cloneInfo.prNumber} hasToken=${!!cloneInfo.authToken}`,
                context: this.stageName,
                metadata: {
                    cloneUrl: cloneInfo.url,
                    platform: cloneInfo.platform,
                    branch: cloneInfo.branch,
                    prNumber: cloneInfo.prNumber,
                    hasAuthToken: !!cloneInfo.authToken,
                    tokenLength: cloneInfo.authToken?.length ?? 0,
                    sandboxProviderType: this.sandboxProvider.constructor.name,
                },
            });

            // Create sandbox and clone repo
            const sandbox = await this.sandboxProvider.createSandboxWithRepo({
                cloneUrl: cloneInfo.url,
                authToken: cloneInfo.authToken,
                authUsername: cloneInfo.authUsername,
                branch: cloneInfo.branch,
                prNumber: cloneInfo.prNumber,
                platform: cloneInfo.platform,
            });

            cleanup = sandbox.cleanup;

            this.logger.log({
                message: `[DEBUG] Sandbox created successfully for ${label}, starting collectContexts`,
                context: this.stageName,
                metadata: {
                    sandboxDecision: 'created',
                    sandboxSkipReason: null,
                    prNumber: context?.pullRequest?.number,
                },
            });

            // Collect cross-file contexts using sandbox remoteCommands
            const result =
                await this.collectCrossFileContextsService.collectContexts({
                    remoteCommands: sandbox.remoteCommands,
                    changedFiles: context.changedFiles,
                    byokConfig: context.codeReviewConfig?.byokConfig,
                    organizationAndTeamData: context.organizationAndTeamData,
                    prNumber: context.pullRequest.number,
                    language:
                        context.codeReviewConfig?.languageResultPrompt ||
                        'en-US',
                    repoRoot: '.',
                });

            this.logger.log({
                message: `Cross-file context collected for ${label}: ${result.contexts.length} snippets from ${result.totalSearches} searches`,
                context: this.stageName,
                metadata: {
                    organizationAndTeamData: context.organizationAndTeamData,
                    prNumber: context.pullRequest.number,
                    contextsCount: result.contexts.length,
                    totalSearches: result.totalSearches,
                    totalSnippetsBeforeDedup: result.totalSnippetsBeforeDedup,
                },
            });

            return this.updateContext(context, (draft) => {
                draft.crossFileContexts = result;
                // Keep sandbox alive for safeguard agent verification
                draft.sandboxHandle = {
                    remoteCommands: sandbox.remoteCommands,
                    cleanup: sandbox.cleanup,
                };
                // Save clone params so safeguard can renew sandbox if it expires
                draft.sandboxCloneParams = {
                    cloneUrl: cloneInfo.url,
                    authToken: cloneInfo.authToken,
                    authUsername: cloneInfo.authUsername,
                    branch: cloneInfo.branch,
                    prNumber: cloneInfo.prNumber,
                    platform: cloneInfo.platform,
                };
            });
        } catch (error) {
            // Non-fatal: log error and return context unchanged
            this.logger.error({
                message: `Failed to collect cross-file context for ${label}, continuing without it`,
                context: this.stageName,
                error,
                metadata: {
                    organizationAndTeamData: context?.organizationAndTeamData,
                    prNumber: context?.pullRequest?.number,
                },
            });
            // Cleanup sandbox on error since we won't store it in context
            if (cleanup) {
                try {
                    await cleanup();
                } catch (cleanupErr) {
                    this.logger.warn({
                        message: `Sandbox cleanup failed after cross-file context error`,
                        context: this.stageName,
                        error: cleanupErr,
                    });
                }
            }
            return context;
        }
    }

    /**
     * Resolve clone parameters based on context origin.
     * - PR mode: uses codeManagementService.getCloneParams() as before
     * - CLI mode: parses git remote URL and tries to get auth from platform integration
     */
    private async resolveCloneParams(
        context: CodeReviewPipelineContext,
        cliContext?: CliReviewPipelineContext,
    ): Promise<{
        url: string;
        authToken: string;
        authUsername?: string;
        branch: string;
        prNumber?: number;
        platform: PlatformType;
    } | null> {
        if (context.origin !== 'cli') {
            // PR mode: use platform integration directly
            const cloneParams = await this.codeManagementService.getCloneParams(
                {
                    repository: context.repository,
                    organizationAndTeamData: context.organizationAndTeamData,
                },
                context.platformType,
            );

            return {
                url: cloneParams.url,
                authToken: cloneParams.auth?.token || '',
                authUsername: cloneParams.auth?.username,
                branch: context.branch,
                prNumber: context.pullRequest.number,
                platform: context.platformType,
            };
        }

        // CLI mode: resolve from gitContext
        const gitContext = cliContext?.gitContext;
        if (!gitContext?.remote) return null;

        const parsed = parseGitRemoteUrl(gitContext.remote);
        if (!parsed) {
            this.logger.warn({
                message: `Could not parse git remote URL: ${gitContext.remote}`,
                context: this.stageName,
            });
            return null;
        }

        const platform = gitContext.inferredPlatform || PlatformType.GITHUB;
        const branch = gitContext.branch || 'main';

        // Try to get clone params (HTTPS URL + auth token) from team's platform integration
        let authToken = '';
        let authUsername: string | undefined;
        let cloneUrl = gitContext.remote;
        try {
            const cloneParams = await this.codeManagementService.getCloneParams(
                {
                    repository: {
                        id: '0',
                        defaultBranch: branch,
                        fullName: parsed.fullName,
                        name: parsed.name,
                    },
                    organizationAndTeamData: context.organizationAndTeamData,
                },
                platform,
            );
            authToken = cloneParams.auth?.token || '';
            authUsername = cloneParams.auth?.username;
            // Use the HTTPS URL from the platform service (E2B sandbox requires HTTPS for token auth)
            if (cloneParams.url) {
                cloneUrl = cloneParams.url;
            }
        } catch (error) {
            // Fallback: no auth (works for public repos)
            this.logger.warn({
                message: `Could not get auth token for CLI cross-file context, trying without auth`,
                context: this.stageName,
                error,
            });
        }

        // Ensure we always use HTTPS (E2B sandbox uses http.extraHeader which only works over HTTPS)
        if (cloneUrl.startsWith('git@')) {
            const sshMatch = cloneUrl.match(/git@([^:]+):(.+?)(?:\.git)?$/);
            if (sshMatch) {
                cloneUrl = `https://${sshMatch[1]}/${sshMatch[2]}`;
            } else {
                this.logger.warn({
                    message: `Could not parse SSH-like git remote URL: ${cloneUrl}`,
                    context: this.stageName,
                });
                return null;
            }
        }

        return {
            url: cloneUrl,
            authToken,
            authUsername,
            branch,
            prNumber: undefined,
            platform,
        };
    }
}
