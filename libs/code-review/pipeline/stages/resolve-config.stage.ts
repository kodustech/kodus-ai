import { is429Error } from '@libs/core/infrastructure/http/rate-limit-retry';
import { StageMessageHelper } from '@libs/core/infrastructure/pipeline/utils/stage-message.helper';
import { PipelineReasons } from '@libs/core/infrastructure/pipeline/constants/pipeline-reasons.const';
import { PullRequestChangesUnreadableError } from '@libs/code-review/domain/errors/pull-request-changes-unreadable.error';
import { Inject, Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { BasePipelineStage } from '@libs/core/infrastructure/pipeline/abstracts/base-stage.abstract';
import { CentralizedConfigSyncUseCase } from '@libs/centralized-config/application/use-cases/centralized-config-sync.use-case';
import {
    CODE_BASE_CONFIG_SERVICE_TOKEN,
    ICodeBaseConfigService,
} from '@libs/code-review/domain/contracts/CodeBaseConfigService.contract';
import {
    IPullRequestManagerService,
    PULL_REQUEST_MANAGER_SERVICE_TOKEN,
} from '@libs/code-review/domain/contracts/PullRequestManagerService.contract';
import {
    IPullRequestMessagesService,
    PULL_REQUEST_MESSAGES_SERVICE_TOKEN,
} from '@libs/code-review/domain/pullRequestMessages/contracts/pullRequestMessages.service.contract';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/parameters/contracts/parameters.service.contract';
import { createLogger } from '@libs/core/log/logger';
import { ParametersKey } from '@libs/core/domain/enums';
import {
    AutomationMessage,
    AutomationStatus,
} from '@libs/automation/domain/automation/enum/automation-status';
import { IPullRequestMessages } from '@libs/code-review/domain/pullRequestMessages/interfaces/pullRequestMessages.interface';
import { ConfigLevel } from '@libs/core/infrastructure/config/types/general/pullRequestMessages.type';
import { StageVisibility } from '@libs/core/infrastructure/pipeline/enums/stage-visibility.enum';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import type { FileChange } from '@libs/core/infrastructure/config/types/general/codeReview.type';

@Injectable()
export class ResolveConfigStage extends BasePipelineStage<CodeReviewPipelineContext> {
    readonly stageName = 'ResolveConfigStage';
    readonly visibility = StageVisibility.SECONDARY;

    private readonly logger = createLogger(ResolveConfigStage.name);

    constructor(
        @Inject(CODE_BASE_CONFIG_SERVICE_TOKEN)
        private readonly codeBaseConfigService: ICodeBaseConfigService,
        @Inject(PULL_REQUEST_MANAGER_SERVICE_TOKEN)
        private readonly pullRequestHandlerService: IPullRequestManagerService,
        @Inject(PULL_REQUEST_MESSAGES_SERVICE_TOKEN)
        private readonly pullRequestMessagesService: IPullRequestMessagesService,
        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,

        private readonly moduleRef: ModuleRef,
    ) {
        super();
    }

    protected override async executeStage(
        context: CodeReviewPipelineContext,
    ): Promise<CodeReviewPipelineContext> {
        try {
            // Webhooks (notably GitLab) do not always carry the target SHA.
            // Fill missing refs from the normalized host contract, but never
            // replace a webhook head with a newer, unreviewed head.
            let pullRequest = context.pullRequest;
            if (
                context.origin !== 'cli' &&
                (!pullRequest.head?.sha || !pullRequest.base?.sha)
            ) {
                try {
                    const live =
                        await this.pullRequestHandlerService.getPullRequestDetails(
                            context.organizationAndTeamData,
                            context.repository,
                            pullRequest.number,
                        );
                    if (
                        live?.head?.sha &&
                        live?.base?.sha &&
                        (!pullRequest.head?.sha ||
                            live.head.sha === pullRequest.head.sha) &&
                        (!pullRequest.base?.sha ||
                            live.base.sha === pullRequest.base.sha)
                    ) {
                        pullRequest = {
                            ...pullRequest,
                            head: { ...pullRequest.head, sha: live.head.sha },
                            base: { ...pullRequest.base, sha: live.base.sha },
                        };
                    }
                } catch (error) {
                    this.logger.warn({
                        message: 'Could not hydrate the reviewed PR snapshot',
                        context: this.stageName,
                        error,
                    });
                }
            }
            const forceFullRerun = Boolean(
                context.pipelineMetadata?.forceFullRerun,
            );
            const baseCommit = forceFullRerun
                ? undefined
                : context?.lastExecution?.lastAnalyzedCommit;

            // Busca apenas metadados dos arquivos (sem conteúdo) - mais rápido
            // O conteúdo será buscado depois no FetchChangedFilesStage apenas para arquivos não ignorados
            // After a rebase, ValidateNewCommitsStage already read what changed.
            const preliminaryFiles =
                context.rebaseInterdiffFiles ??
                (await this.pullRequestHandlerService.getChangedFilesMetadata(
                    context.organizationAndTeamData,
                    context.repository,
                    pullRequest,
                    baseCommit,
                    context.lastExecution?.reviewedBaseBranch,
                ));

            if (!preliminaryFiles || preliminaryFiles.length === 0) {
                this.logger.warn({
                    message: 'No files found in PR',
                    context: this.stageName,
                    metadata: {
                        organizationAndTeamData:
                            context.organizationAndTeamData,
                        repository: context.repository.name,
                        pullRequestNumber: context.pullRequest.number,
                    },
                });

                return this.updateContext(context, (draft) => {
                    draft.statusInfo = {
                        status: AutomationStatus.SKIPPED,
                        message: AutomationMessage.NO_FILES_IN_PR,
                    };
                });
            }

            await this.syncCentralizedConfigIfEnabled(
                context.organizationAndTeamData,
            );

            let config = await this.codeBaseConfigService.getConfig(
                context.organizationAndTeamData,
                context.repository,
                preliminaryFiles,
            );

            // Review files stay incremental; risk and approval use every path
            // in the current PR, including paths changed before this push.
            let fullPrFiles: FileChange[] | undefined;
            let riskConfigurationUnavailable = false;
            const riskMayBeActive = config.riskAssessmentMayBeActive ?? true;
            const approvalMayVary =
                config.approvalSettingsMayVaryByDirectory === true;
            try {
                const needsPrWideSettings = riskMayBeActive || approvalMayVary;
                if (!baseCommit && !context.rebaseInterdiffFiles) {
                    fullPrFiles = preliminaryFiles;
                } else if (needsPrWideSettings) {
                    fullPrFiles =
                        await this.pullRequestHandlerService.getChangedFilesMetadata(
                            context.organizationAndTeamData,
                            context.repository,
                            pullRequest,
                            undefined,
                            undefined,
                        );
                }
                // Without PR-wide settings, approval file conditions fetch a
                // complete diff only if they need it after the review.
                if (fullPrFiles || needsPrWideSettings) {
                    if (
                        !fullPrFiles?.length ||
                        fullPrFiles.some((file) => !file.filename)
                    ) {
                        throw new Error(
                            'The complete PR file list is unavailable',
                        );
                    }
                    const prWideConfig =
                        fullPrFiles === preliminaryFiles
                            ? config
                            : await this.codeBaseConfigService.getConfig(
                                  context.organizationAndTeamData,
                                  context.repository,
                                  fullPrFiles,
                              );
                    for (const key of [
                        'riskAssessmentActive',
                        'riskAssessmentSource',
                        'riskCriteria',
                        'riskReviewRouting',
                        'reviewSettingsError',
                        'pullRequestApprovalActive',
                        'approvalPolicies',
                        'approvalPolicySource',
                        'approvalLabels',
                        'approvalAuthors',
                        'approvalSensitivePaths',
                        'approvalRiskActive',
                        'approvalRiskInstructions',
                    ] as const) {
                        config = { ...config, [key]: prWideConfig[key] };
                    }
                    if (prWideConfig.riskAssessmentActive === true) {
                        config = {
                            ...config,
                            reviewMode: prWideConfig.reviewMode,
                        };
                    }
                }
            } catch (error) {
                this.logger.warn({
                    message:
                        'Could not resolve PR-wide risk and approval settings',
                    context: this.stageName,
                    error,
                    metadata: {
                        organizationAndTeamData:
                            context.organizationAndTeamData,
                        repositoryId: context.repository.id,
                        prNumber: context.pullRequest.number,
                    },
                });
                // An unreadable scope may contain an enabled risk override.
                // Continue the review in its default mode, but veto approval.
                if (riskMayBeActive) {
                    config = { ...config, riskAssessmentActive: true };
                    riskConfigurationUnavailable = true;
                }
                if (approvalMayVary)
                    config = {
                        ...config,
                        reviewSettingsError:
                            'Kody could not resolve PR-wide approval settings.',
                    };
            }

            const pullRequestMessagesConfig =
                await this.setPullRequestMessagesConfig(context);

            return this.updateContext(context, (draft) => {
                draft.codeReviewConfig = config;
                draft.pullRequest = pullRequest;
                draft.pullRequestMessagesConfig = pullRequestMessagesConfig;
                draft.preliminaryFiles = preliminaryFiles;
                draft.fullPrFiles = fullPrFiles;
                draft.riskConfigurationUnavailable =
                    riskConfigurationUnavailable ||
                    !!config.reviewSettingsError;
            });
        } catch (error) {
            // Not a configuration problem. Set here: a thrown error would be
            // overwritten by the next stage's own skip.
            if (error instanceof PullRequestChangesUnreadableError) {
                this.logger.warn({
                    message: error.message,
                    context: this.stageName,
                    metadata: {
                        organizationId:
                            context?.organizationAndTeamData?.organizationId,
                        prNumber: context?.pullRequest?.number,
                        repositoryId: context?.repository?.id,
                        reason: 'changes_unreadable',
                    },
                });
                return this.updateContext(context, (draft) => {
                    draft.statusInfo = {
                        status: AutomationStatus.SKIPPED,
                        message: StageMessageHelper.skippedWithReason(
                            PipelineReasons.FILES.UNREADABLE,
                            error.message,
                        ),
                    };
                });
            }
            // A rate-limited diff read is not a config problem either; mapped
            // as ValidateNewCommitsStage maps it.
            if (is429Error(error)) {
                this.logger.warn({
                    message: `Skipping code review for PR#${context?.pullRequest?.number} — provider rate-limited the diff fetch (HTTP 429)`,
                    context: this.stageName,
                    metadata: {
                        organizationId:
                            context?.organizationAndTeamData?.organizationId,
                        prNumber: context?.pullRequest?.number,
                        repositoryId: context?.repository?.id,
                        reason: 'provider_rate_limited',
                    },
                });
                return this.updateContext(context, (draft) => {
                    draft.statusInfo = {
                        status: AutomationStatus.SKIPPED,
                        message: StageMessageHelper.skippedWithReason(
                            PipelineReasons.COMMITS.PROVIDER_RATE_LIMITED,
                            'Provider rate-limited the diff fetch (HTTP 429)',
                        ),
                    };
                });
            }
            this.logger.error({
                message: `Error in ResolveConfigStage for PR#${context?.pullRequest?.number}`,
                error,
                context: this.stageName,
                metadata: {
                    organizationAndTeamData: context?.organizationAndTeamData,
                    prNumber: context?.pullRequest?.number,
                    repositoryId: context?.repository?.id,
                },
            });

            return this.updateContext(context, (draft) => {
                draft.statusInfo = {
                    status: AutomationStatus.SKIPPED,
                    message: AutomationMessage.FAILED_RESOLVE_CONFIG,
                };
            });
        }
    }

    private async syncCentralizedConfigIfEnabled(
        organizationAndTeamData: CodeReviewPipelineContext['organizationAndTeamData'],
    ): Promise<void> {
        try {
            const centralizedConfig = await this.parametersService.findByKey(
                ParametersKey.CENTRALIZED_CONFIG,
                organizationAndTeamData,
            );

            if (!centralizedConfig?.configValue?.enabled) {
                return;
            }

            const syncUseCase = await this.moduleRef.resolve(
                CentralizedConfigSyncUseCase,
                undefined,
                { strict: false },
            );

            await syncUseCase.execute({ organizationAndTeamData });
        } catch (error) {
            this.logger.warn({
                message:
                    'Failed to sync centralized config before review; falling back to current DB state',
                context: this.stageName,
                error,
                metadata: { organizationAndTeamData },
            });
        }
    }

    private async setPullRequestMessagesConfig(
        context: CodeReviewPipelineContext,
    ): Promise<IPullRequestMessages | null> {
        const repositoryId = context.repository.id;
        const organizationId = context.organizationAndTeamData.organizationId;

        let pullRequestMessagesConfig = null;

        if (context.codeReviewConfig?.configLevel === ConfigLevel.DIRECTORY) {
            pullRequestMessagesConfig =
                await this.pullRequestMessagesService.findOne({
                    organizationId,
                    repositoryId,
                    directoryId: context.codeReviewConfig?.directoryId,
                    configLevel: ConfigLevel.DIRECTORY,
                });
        }

        if (!pullRequestMessagesConfig) {
            pullRequestMessagesConfig =
                await this.pullRequestMessagesService.findOne({
                    organizationId,
                    repositoryId,
                    configLevel: ConfigLevel.REPOSITORY,
                });
        }

        if (!pullRequestMessagesConfig) {
            pullRequestMessagesConfig =
                await this.pullRequestMessagesService.findOne({
                    organizationId,
                    configLevel: ConfigLevel.GLOBAL,
                });
        }

        return pullRequestMessagesConfig;
    }
}
