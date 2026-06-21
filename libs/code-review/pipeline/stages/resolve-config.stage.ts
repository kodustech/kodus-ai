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
import {
    DRY_RUN_SERVICE_TOKEN,
    IDryRunService,
} from '@libs/dryRun/domain/contracts/dryRun.service.contract';
import { createLogger } from '@kodus/flow';
import { ParametersKey } from '@libs/core/domain/enums';
import {
    AutomationMessage,
    AutomationStatus,
} from '@libs/automation/domain/automation/enum/automation-status';
import { IPullRequestMessages } from '@libs/code-review/domain/pullRequestMessages/interfaces/pullRequestMessages.interface';
import { ConfigLevel } from '@libs/core/infrastructure/config/types/general/pullRequestMessages.type';
import { StageVisibility } from '@libs/core/infrastructure/pipeline/enums/stage-visibility.enum';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';

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

        @Inject(DRY_RUN_SERVICE_TOKEN)
        private readonly dryRunService: IDryRunService,

        private readonly moduleRef: ModuleRef,
    ) {
        super();
    }

    protected override async executeStage(
        context: CodeReviewPipelineContext,
    ): Promise<CodeReviewPipelineContext> {
        try {
            const forceFullRerun = Boolean(
                context.pipelineMetadata?.forceFullRerun,
            );
            const baseCommit = forceFullRerun
                ? undefined
                : context?.lastExecution?.lastAnalyzedCommit;

            // Busca apenas metadados dos arquivos (sem conteúdo) - mais rápido
            // O conteúdo será buscado depois no FetchChangedFilesStage apenas para arquivos não ignorados
            const preliminaryFiles =
                await this.pullRequestHandlerService.getChangedFilesMetadata(
                    context.organizationAndTeamData,
                    context.repository,
                    context.pullRequest,
                    baseCommit,
                );

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

            const config = await this.codeBaseConfigService.getConfig(
                context.organizationAndTeamData,
                context.repository,
                preliminaryFiles,
            );

            const pullRequestMessagesConfig =
                await this.setPullRequestMessagesConfig(context);

            if (context.dryRun?.enabled) {
                const codeReviewConfigId = (
                    await this.parametersService.findByKey(
                        ParametersKey.CODE_REVIEW_CONFIG,
                        context.organizationAndTeamData,
                    )
                )?.uuid;

                await this.dryRunService.addConfigsToDryRun({
                    id: context.dryRun?.id,
                    organizationAndTeamData: context.organizationAndTeamData,
                    config,
                    configId: codeReviewConfigId,
                    pullRequestMessagesConfig,
                    pullRequestMessagesId: pullRequestMessagesConfig?.uuid,
                });
            }

            return this.updateContext(context, (draft) => {
                draft.codeReviewConfig = config;
                draft.pullRequestMessagesConfig = pullRequestMessagesConfig;
                draft.preliminaryFiles = preliminaryFiles;
            });
        } catch (error) {
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
