import { createLogger } from '@kodus/flow';
import { SUPPORTED_LANGUAGES } from '@libs/code-review/domain/contracts/SupportedLanguages';
import {
    DOCUMENTATION_LLM_PLANNER_SERVICE_TOKEN,
    DocumentationLLMPlannerService,
} from '@libs/code-review/infrastructure/adapters/services/documentation-llm-planner.service';
import {
    DOCUMENTATION_PACKAGE_DISCOVERY_SERVICE_TOKEN,
    DocumentationPackageDiscoveryService,
} from '@libs/code-review/infrastructure/adapters/services/documentation-package-discovery.service';
import {
    DOCUMENTATION_SEARCH_EXA_SERVICE_TOKEN,
    DocumentationSearchExaService,
} from '@libs/code-review/infrastructure/adapters/services/documentation-search-exa.service';
import { BasePipelineStage } from '@libs/core/infrastructure/pipeline/abstracts/base-stage.abstract';
import { StageVisibility } from '@libs/core/infrastructure/pipeline/enums/stage-visibility.enum';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import path from 'path';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';

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
        @Inject(DOCUMENTATION_PACKAGE_DISCOVERY_SERVICE_TOKEN)
        private readonly packageDiscoveryService: DocumentationPackageDiscoveryService,
        @Inject(DOCUMENTATION_LLM_PLANNER_SERVICE_TOKEN)
        private readonly llmPlannerService: DocumentationLLMPlannerService,
        @Inject(DOCUMENTATION_SEARCH_EXA_SERVICE_TOKEN)
        private readonly documentationSearchService: DocumentationSearchExaService,
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

        try {
            // Single-sandbox-per-PR: reuse the lease-managed sandbox set up by
            // CreateSandboxStage (which runs earlier in the pipeline). When
            // the sandbox isn't available, package discovery's fallback would
            // be `buildManifestCandidatesForFile`, which walks every parent
            // directory of every changed file × 9 manifest names and calls
            // `getRepositoryContentFile` for each — typically 80-150 GitHub
            // requests per PR that all 404 and consume nothing useful. On the
            // 2026-05-13 rate-limit incident this single fallback was ~70%
            // of QuintoAndar's GitHub quota waste. Skip the stage entirely
            // when there's no sandbox; review continues without external
            // documentation context (degraded but functional).
            const remoteCommands = context.sandboxHandle?.remoteCommands;

            if (!remoteCommands) {
                this.logger.log({
                    message:
                        'Skipping documentation discovery: no sandbox available (would trigger manifest-fan-out fallback)',
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
        }
        // Sandbox lifecycle is owned by SandboxLeaseManager (release →
        // pause); this stage doesn't manage cleanup anymore.
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
        _context: CodeReviewPipelineContext,
    ): Promise<boolean> {
        const hasAPIKey = this.configService.get<string>('API_EXA_KEY');
        return !!hasAPIKey;
    }
}
