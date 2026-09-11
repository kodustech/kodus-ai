import { Inject, Injectable } from '@nestjs/common';
import type { ContextLayer } from '@libs/ai-engine/infrastructure/adapters/services/context/context-pack';

import { ILoadExternalContextStage } from './contracts/loadExternalContextStage.contract';
import { BasePipelineStage } from '@libs/core/infrastructure/pipeline/abstracts/base-stage.abstract';
import { StageVisibility } from '@libs/core/infrastructure/pipeline/enums/stage-visibility.enum';

import { createLogger } from '@libs/core/log/logger';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import type { TraceContextDecision } from '@libs/cli-review/domain/types/trace-context.types';
import {
    IPromptExternalReferenceManagerService,
    PROMPT_EXTERNAL_REFERENCE_MANAGER_SERVICE_TOKEN,
} from '@libs/ai-engine/domain/prompt/contracts/promptExternalReferenceManager.contract';
import {
    IPromptContextLoaderService,
    PROMPT_CONTEXT_LOADER_SERVICE_TOKEN,
} from '@libs/ai-engine/domain/prompt/contracts/promptContextLoader.contract';
import { CodeReviewContextPackService } from '@libs/ai-engine/infrastructure/adapters/services/context/code-review-context-pack.service';
import { BuildTraceContextPackUseCase } from '@libs/cli-review/application/use-cases/build-trace-context-pack.use-case';
import {
    FeatureGateService,
    FEATURE_KEYS,
    type FeatureKey,
} from '@libs/feature-gate';
import {
    IOrganizationService,
    ORGANIZATION_SERVICE_TOKEN,
} from '@libs/organization/domain/organization/contracts/organization.service.contract';
import { BuildPreviousReviewDecisionsUseCase } from '@libs/code-review/application/use-cases/previousReviewDecisions/build-previous-review-decisions.use-case';
import type { PrDecisionRecord } from '@libs/code-review/domain/contracts/pr-decision-store.contract';

@Injectable()
export class LoadExternalContextStage
    extends BasePipelineStage<CodeReviewPipelineContext>
    implements ILoadExternalContextStage
{
    readonly stageName = 'LoadExternalContextStage';
    readonly label = 'Loading Context';
    readonly visibility = StageVisibility.PRIMARY;

    private readonly logger = createLogger(LoadExternalContextStage.name);

    constructor(
        @Inject(PROMPT_EXTERNAL_REFERENCE_MANAGER_SERVICE_TOKEN)
        private readonly promptReferenceManager: IPromptExternalReferenceManagerService,
        @Inject(PROMPT_CONTEXT_LOADER_SERVICE_TOKEN)
        private readonly promptContextLoader: IPromptContextLoaderService,
        private readonly contextPackService: CodeReviewContextPackService,
        private readonly buildTraceContextPackUseCase: BuildTraceContextPackUseCase,
        private readonly featureGate: FeatureGateService,
        @Inject(ORGANIZATION_SERVICE_TOKEN)
        private readonly organizationService: IOrganizationService,
        private readonly buildPreviousReviewDecisionsUseCase: BuildPreviousReviewDecisionsUseCase,
    ) {
        super();
    }

    /**
     * Shared alpha-gate evaluator: fail-closed (disabled) on ANY error —
     * PostHog outage, release-track lookup failure, whatever — so a flaky
     * flag provider only ever costs the optional context, never the review
     * itself. Both `traceDecisions` and `previousDecisions` gate through this
     * same shape; the only per-feature bits are the key and the log label.
     */
    private async evaluateAlphaGate(
        context: CodeReviewPipelineContext,
        featureKey: FeatureKey,
        gateLabel: string,
    ): Promise<boolean> {
        const organizationAndTeamData = context.organizationAndTeamData;

        try {
            const releaseTrack = await this.organizationService.getReleaseTrack(
                organizationAndTeamData.organizationId,
            );

            return await this.featureGate.isEnabled(featureKey, {
                identifier: organizationAndTeamData.organizationId,
                organizationAndTeamData,
                releaseTrack,
                groups: {
                    team: organizationAndTeamData.teamId,
                    repository: String(context.repository.id),
                },
            });
        } catch (error) {
            this.logger.warn({
                message: `${gateLabel} alpha gate could not be evaluated; feature remains disabled`,
                context: this.stageName,
                metadata: {
                    organizationId: organizationAndTeamData.organizationId,
                    teamId: organizationAndTeamData.teamId,
                    repositoryId: context.repository?.id,
                    errorName:
                        error instanceof Error ? error.name : 'UnknownError',
                },
            });
            return false;
        }
    }

    private async isTraceReviewContextEnabled(
        context: CodeReviewPipelineContext,
    ): Promise<boolean> {
        return this.evaluateAlphaGate(
            context,
            FEATURE_KEYS.kodusTraceReviewContext,
            'Kodus Trace',
        );
    }

    /**
     * Decisions recorded by Kodus Trace for the files in this diff.
     *
     * Returns undefined — not an empty array — when nothing matches, so a
     * repository with no recorded decisions produces a review prompt that is
     * byte-identical to current behaviour.
     */
    private async loadTraceDecisions(
        context: CodeReviewPipelineContext,
    ): Promise<TraceContextDecision[] | undefined> {
        try {
            if (!(await this.isTraceReviewContextEnabled(context))) {
                return undefined;
            }

            const changedFilePaths = (context.changedFiles ?? [])
                .map((file) => file?.filename)
                .filter((filename): filename is string => !!filename);

            if (changedFilePaths.length === 0) {
                return undefined;
            }

            const pack = await this.buildTraceContextPackUseCase.execute({
                organizationAndTeamData: context.organizationAndTeamData,
                repository: {
                    id: String(context.repository.id),
                    name: context.repository.name,
                },
                changedFilePaths,
                branch: context.pullRequest?.head?.ref,
            });

            if (pack.decisions.length === 0) {
                return undefined;
            }

            this.logger.log({
                message: `Loaded ${pack.decisions.length} recorded decisions for PR#${context.pullRequest?.number}`,
                context: this.stageName,
                metadata: {
                    organizationAndTeamData: context.organizationAndTeamData,
                    prNumber: context.pullRequest?.number,
                    droppedForBudget: pack.droppedForBudget,
                    estimatedTokens: pack.estimatedTokens,
                },
            });

            return pack.decisions;
        } catch (error) {
            // Never fail a review over the decision store.
            this.logger.warn({
                message: 'Failed to load recorded decisions',
                context: this.stageName,
                error,
                metadata: {
                    organizationAndTeamData: context.organizationAndTeamData,
                },
            });
            return undefined;
        }
    }

    /**
     * Suggestions already posted on THIS PR in a previous review round
     * (issue #1313). Unconditional — every org gets this, no alpha gate.
     * Fail-open discipline preserved: returns undefined — never throws — on
     * any store failure, so a review with no history (or an unavailable
     * store) is byte-identical to current behaviour.
     */
    private async loadPreviousReviewDecisions(
        context: CodeReviewPipelineContext,
    ): Promise<PrDecisionRecord[] | undefined> {
        try {
            const changedFilePaths = (context.changedFiles ?? [])
                .map((file) => file?.filename)
                .filter((filename): filename is string => !!filename);

            if (changedFilePaths.length === 0) {
                return undefined;
            }

            const repositoryFullName =
                context.repository?.fullName ||
                context.pullRequest?.base?.repo?.fullName;
            const prNumber = context.pullRequest?.number;

            if (!repositoryFullName || !prNumber) {
                return undefined;
            }

            const decisions = await this.buildPreviousReviewDecisionsUseCase.execute({
                organizationId: context.organizationAndTeamData.organizationId,
                prNumber,
                repositoryFullName,
                filePaths: changedFilePaths,
            });

            if (decisions.length === 0) {
                return undefined;
            }

            this.logger.log({
                message: `Loaded ${decisions.length} previous review decisions for PR#${prNumber}`,
                context: this.stageName,
                metadata: {
                    organizationAndTeamData: context.organizationAndTeamData,
                    prNumber,
                },
            });

            return decisions;
        } catch (error) {
            // Never fail a review over the decision store.
            this.logger.warn({
                message: 'Failed to load previous review decisions',
                context: this.stageName,
                error,
                metadata: {
                    organizationAndTeamData: context.organizationAndTeamData,
                },
            });
            return undefined;
        }
    }

    protected async executeStage(
        context: CodeReviewPipelineContext,
    ): Promise<CodeReviewPipelineContext> {
        try {
            const { organizationId } = context.organizationAndTeamData;
            const repositoryId = context.repository?.id;
            const directoryId = context.codeReviewConfig?.directoryId;

            const configKeys =
                this.promptReferenceManager.buildConfigKeysHierarchy(
                    context.organizationAndTeamData,
                    repositoryId,
                    directoryId,
                );

            const allReferences =
                await this.promptReferenceManager.findByConfigKeys(configKeys, {
                    contextReferenceId:
                        context.codeReviewConfig?.contextReferenceId,
                });

            const priorityMap = new Map(
                configKeys.map((key, index) => [key, index]),
            );

            const sortedReferences = [...(allReferences ?? [])].sort((a, b) => {
                const aPriority =
                    priorityMap.get(a.configKey) ?? Number.MAX_SAFE_INTEGER;
                const bPriority =
                    priorityMap.get(b.configKey) ?? Number.MAX_SAFE_INTEGER;
                return aPriority - bPriority;
            });

            let externalContext = {};
            let contextLayers: ContextLayer[] | undefined;

            if (sortedReferences.length > 0) {
                const loadResult =
                    await this.promptContextLoader.loadExternalContext(
                        {
                            organizationAndTeamData:
                                context.organizationAndTeamData,
                            repository: context.repository,
                            pullRequest: context.pullRequest,
                            allReferences: sortedReferences,
                        },
                        { buildLayers: true },
                    );

                externalContext = loadResult.externalContext;
                contextLayers = loadResult.contextLayers;
            }

            const traceDecisions = await this.loadTraceDecisions(context);
            const previousDecisions =
                await this.loadPreviousReviewDecisions(context);

            let sharedContextPack = undefined;
            let updatedCodeReviewConfig = context.codeReviewConfig;

            if (
                context.codeReviewConfig?.contextReferenceId &&
                (context.sharedContextPack?.metadata?.contextReferenceId ??
                    context.sharedContextPack?.metadata
                        ?.configContextReferenceId) !==
                    context.codeReviewConfig.contextReferenceId
            ) {
                try {
                    const resolved =
                        await this.contextPackService.buildContextPack({
                            organizationAndTeamData:
                                context.organizationAndTeamData,
                            overrides:
                                context.codeReviewConfig?.v2PromptOverrides,
                            contextReferenceId:
                                context.codeReviewConfig.contextReferenceId,
                            externalLayers: contextLayers,
                            repository: context.repository,
                            pullRequest: context.pullRequest,
                        });

                    if (resolved.sanitizedOverrides) {
                        updatedCodeReviewConfig = {
                            ...context.codeReviewConfig,
                            v2PromptOverrides: resolved.sanitizedOverrides,
                        };
                    }

                    if (resolved.pack) {
                        sharedContextPack = resolved.pack;
                    }
                } catch (error) {
                    this.logger.warn({
                        message: 'Failed to build context pack',
                        context: this.stageName,
                        error,
                        metadata: {
                            organizationId,
                            contextReferenceId:
                                context.codeReviewConfig?.contextReferenceId,
                        },
                    });
                }
            }

            return {
                ...context,
                codeReviewConfig: updatedCodeReviewConfig,
                externalPromptContext: externalContext,
                externalPromptLayers: contextLayers,
                sharedContextPack,
                traceDecisions,
                previousDecisions,
            };
        } catch (error) {
            this.logger.error({
                message: 'Error loading external context',
                context: this.stageName,
                error,
                metadata: {
                    organizationAndTeamData: context.organizationAndTeamData,
                    prNumber: context.pullRequest.number,
                },
            });

            return {
                ...context,
                externalPromptContext: {},
                externalPromptLayers: undefined,
                sharedContextPack: undefined,
                traceDecisions: undefined,
                previousDecisions: undefined,
            };
        }
    }
}
