import { createLogger } from '@kodus/flow';
import { CliReviewPipelineContext } from '@libs/cli-review/pipeline/context/cli-review-pipeline.context';
import {
    ISandboxProvider,
    SANDBOX_PROVIDER_TOKEN,
} from '@libs/code-review/domain/contracts/sandbox.provider';
import { SUPPORTED_LANGUAGES } from '@libs/code-review/domain/contracts/SupportedLanguages';
import { DocumentationLLMPlannerService } from '@libs/code-review/infrastructure/adapters/services/documentation-llm-planner.service';
import { DocumentationPackageDiscoveryService } from '@libs/code-review/infrastructure/adapters/services/documentation-package-discovery.service';
import { DocumentationSearchExaService } from '@libs/code-review/infrastructure/adapters/services/documentation-search-exa.service';
import posthog, { FEATURE_FLAGS } from '@libs/common/utils/posthog';
import { PlatformType } from '@libs/core/domain/enums';
import { BasePipelineStage } from '@libs/core/infrastructure/pipeline/abstracts/base-stage.abstract';
import { StageVisibility } from '@libs/core/infrastructure/pipeline/enums/stage-visibility.enum';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import path from 'path';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';

function parseGitRemoteUrl(
    url: string,
): { fullName: string; name: string } | null {
    const httpsMatch = url.match(
        /https?:\/\/[^/]+\/([^/]+\/[^/]+?)(?:\.git)?$/,
    );
    if (httpsMatch) {
        const fullName = httpsMatch[1];
        const name = fullName.split('/')[1];
        return { fullName, name };
    }

    const sshMatch = url.match(/[^@]+@[^:]+:([^/]+\/[^/]+?)(?:\.git)?$/);
    if (sshMatch) {
        const fullName = sshMatch[1];
        const name = fullName.split('/')[1];
        return { fullName, name };
    }

    return null;
}

@Injectable()
export class GatherDocumentationContextStage extends BasePipelineStage<CodeReviewPipelineContext> {
    readonly stageName = 'GatherDocumentationContextStage';
    readonly label = 'Gathering Documentation Context';
    readonly visibility = StageVisibility.SECONDARY;

    private readonly logger = createLogger(
        GatherDocumentationContextStage.name,
    );

    constructor(
        private readonly configService: ConfigService,
        private readonly packageDiscoveryService: DocumentationPackageDiscoveryService,
        private readonly llmPlannerService: DocumentationLLMPlannerService,
        private readonly documentationSearchService: DocumentationSearchExaService,
        @Inject(SANDBOX_PROVIDER_TOKEN)
        private readonly sandboxProvider: ISandboxProvider,
        private readonly codeManagementService: CodeManagementService,
    ) {
        super();
    }

    protected async executeStage(
        context: CodeReviewPipelineContext,
    ): Promise<CodeReviewPipelineContext> {
        const shouldRunDocumentationContext =
            await this.shouldRunDocumentationContext(context);

        if (!shouldRunDocumentationContext) {
            this.logger.log({
                message:
                    'Documentation context stage disabled by feature flag; skipping',
                context: this.stageName,
                metadata: {
                    prNumber: context.pullRequest.number,
                    repository: context.repository.name,
                    organizationAndTeamData: context.organizationAndTeamData,
                },
            });

            return this.updateContext(context, (draft) => {
                draft.discoveredPackages = [];
                draft.documentationQueryPlanByFile = {};
                draft.documentationByFile = {};
            });
        }

        if (!context.changedFiles?.length) {
            return context;
        }

        const codeFiles = context.changedFiles.filter((file) =>
            this.isCodeFile(file.filename),
        );

        if (!codeFiles.length) {
            this.logger.log({
                message:
                    'No supported code files found for documentation context stage',
                context: this.stageName,
                metadata: {
                    prNumber: context.pullRequest.number,
                    repository: context.repository.name,
                    organizationAndTeamData: context.organizationAndTeamData,
                },
            });

            return this.updateContext(context, (draft) => {
                draft.documentationQueryPlanByFile = {};
                draft.documentationByFile = {};
            });
        }

        let cleanup: (() => Promise<void>) | undefined;

        try {
            let remoteCommands = context.sandboxHandle?.remoteCommands;

            if (!remoteCommands && this.sandboxProvider.isAvailable()) {
                try {
                    const cloneInfo = await this.resolveCloneParams(context);

                    if (cloneInfo) {
                        const sandbox =
                            await this.sandboxProvider.createSandboxWithRepo({
                                cloneUrl: cloneInfo.url,
                                authToken: cloneInfo.authToken,
                                branch: cloneInfo.branch,
                                prNumber: cloneInfo.prNumber,
                                platform: cloneInfo.platform,
                            });

                        remoteCommands = sandbox.remoteCommands;
                        cleanup = sandbox.cleanup;
                    }
                } catch (sandboxError) {
                    this.logger.warn({
                        message:
                            'Failed to initialize sandbox for ripgrep manifest discovery, using fallback manifest resolution',
                        context: this.stageName,
                        metadata: {
                            prNumber: context.pullRequest.number,
                            repository: context.repository.name,
                            organizationAndTeamData:
                                context.organizationAndTeamData,
                        },
                        error: sandboxError,
                    });
                }
            }

            const discovery =
                await this.packageDiscoveryService.discoverPackages(context, {
                    remoteCommands,
                });

            if (!discovery.packages.length) {
                this.logger.log({
                    message:
                        'No packages discovered for documentation context stage',
                    context: this.stageName,
                    metadata: {
                        prNumber: context.pullRequest.number,
                        repository: context.repository.name,
                        organizationAndTeamData:
                            context.organizationAndTeamData,
                    },
                });

                return this.updateContext(context, (draft) => {
                    draft.discoveredPackages = [];
                    draft.documentationQueryPlanByFile = {};
                    draft.documentationByFile = {};
                });
            }

            const documentationQueryPlanByFile =
                await this.llmPlannerService.planDocumentationByFile({
                    packages: discovery.packages,
                    changedFiles: codeFiles,
                    byokConfig: context.codeReviewConfig?.byokConfig,
                    organizationAndTeamData: context.organizationAndTeamData,
                });

            const hasPlannerQueries = Object.values(
                documentationQueryPlanByFile || {},
            ).some((plan) => (plan?.queryTasks || []).length > 0);

            if (!hasPlannerQueries) {
                this.logger.log({
                    message:
                        'Documentation planner returned no queries; skipping documentation retrieval stage',
                    context: this.stageName,
                    metadata: {
                        prNumber: context.pullRequest.number,
                        repository: context.repository.name,
                        discoveredPackages: discovery.packages.length,
                        organizationAndTeamData:
                            context.organizationAndTeamData,
                    },
                });

                return this.updateContext(context, (draft) => {
                    draft.discoveredPackages = discovery.packages;
                    draft.documentationQueryPlanByFile =
                        documentationQueryPlanByFile;
                    draft.documentationByFile = {};
                });
            }

            const documentationByFile =
                await this.documentationSearchService.searchByFilePlan(
                    documentationQueryPlanByFile,
                    {
                        organizationAndTeamData:
                            context.organizationAndTeamData,
                        prNumber: context.pullRequest.number,
                        byokConfig: context.codeReviewConfig?.byokConfig,
                    },
                );

            this.logger.log({
                message: `Documentation context gathered for PR#${context.pullRequest.number}`,
                context: this.stageName,
                metadata: {
                    prNumber: context.pullRequest.number,
                    repository: context.repository.name,
                    discoveredPackages: discovery.packages.length,
                    manifestFiles: discovery.manifestFiles,
                    filesWithDocumentation:
                        Object.keys(documentationByFile).length,
                    organizationAndTeamData: context.organizationAndTeamData,
                },
            });

            return this.updateContext(context, (draft) => {
                draft.discoveredPackages = discovery.packages;
                draft.documentationQueryPlanByFile =
                    documentationQueryPlanByFile;
                draft.documentationByFile = documentationByFile;
            });
        } catch (error) {
            this.logger.error({
                message:
                    'Failed to gather documentation context, continuing without documentation',
                context: this.stageName,
                error,
                metadata: {
                    prNumber: context.pullRequest.number,
                    repository: context.repository.name,
                    organizationAndTeamData: context.organizationAndTeamData,
                },
            });

            return context;
        } finally {
            if (cleanup) {
                try {
                    await cleanup();
                } catch (cleanupError) {
                    this.logger.warn({
                        message:
                            'Sandbox cleanup failed after documentation manifest discovery',
                        context: this.stageName,
                        metadata: {
                            prNumber: context.pullRequest.number,
                            repository: context.repository.name,
                            organizationAndTeamData:
                                context.organizationAndTeamData,
                        },
                        error: cleanupError,
                    });
                }
            }
        }
    }

    private isCodeFile(filePath: string): boolean {
        const extension = path.posix.extname(filePath).toLowerCase();

        if (!extension) {
            return false;
        }

        return Object.values(SUPPORTED_LANGUAGES).some((lang) =>
            lang.extensions.includes(extension),
        );
    }

    private async shouldRunDocumentationContext(
        context: CodeReviewPipelineContext,
    ): Promise<boolean> {
        const featureIdentifier =
            context.organizationAndTeamData?.organizationId ||
            context.organizationAndTeamData?.teamId ||
            'unknown';

        const isFeatureEnabled = await posthog.isFeatureEnabled(
            FEATURE_FLAGS.documentationContext,
            featureIdentifier,
            context.organizationAndTeamData,
        );

        const hasAPIKey = this.configService.get<string>('API_EXA_KEY');

        return !!hasAPIKey && isFeatureEnabled;
    }

    private async resolveCloneParams(
        context: CodeReviewPipelineContext,
    ): Promise<{
        url: string;
        authToken: string;
        branch: string;
        prNumber?: number;
        platform: PlatformType;
    } | null> {
        if (context.origin !== 'cli') {
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
                branch: context.branch,
                prNumber: context.pullRequest.number,
                platform: context.platformType,
            };
        }

        const cliContext = context as unknown as CliReviewPipelineContext;
        const gitContext = cliContext?.gitContext;

        if (!gitContext?.remote) {
            return null;
        }

        const parsed = parseGitRemoteUrl(gitContext.remote);
        if (!parsed) {
            return null;
        }

        const platform = gitContext.inferredPlatform || PlatformType.GITHUB;
        const branch = gitContext.branch || 'main';
        let authToken = '';
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
            if (cloneParams.url) {
                cloneUrl = cloneParams.url;
            }
        } catch {
            // Continue without token for public repositories.
        }

        if (cloneUrl.startsWith('git@')) {
            const sshMatch = cloneUrl.match(/git@([^:]+):(.+?)(?:\.git)?$/);
            if (!sshMatch) {
                return null;
            }

            cloneUrl = `https://${sshMatch[1]}/${sshMatch[2]}`;
        }

        return {
            url: cloneUrl,
            authToken,
            branch,
            prNumber: undefined,
            platform,
        };
    }
}
