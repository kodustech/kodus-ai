import { Inject, Injectable } from '@nestjs/common';
import { BasePipelineStage } from '../../../pipeline/base-stage.abstract';
import {
    AUTOMATION_EXECUTION_SERVICE_TOKEN,
    IAutomationExecutionService,
} from '@/core/domain/automation/contracts/automation-execution.service';
import {
    IPullRequestManagerService,
    PULL_REQUEST_MANAGER_SERVICE_TOKEN,
} from '@/core/domain/codeBase/contracts/PullRequestManagerService.contract';
import { AutomationStatus } from '@/core/domain/automation/enums/automation-status';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import { PipelineStatus } from '../../../pipeline/interfaces/pipeline-context.interface';
import { PinoLoggerService } from '../../../logger/pino.service';

@Injectable()
export class FetchChangedFilesStage extends BasePipelineStage<CodeReviewPipelineContext> {
    stageName = 'FetchChangedFilesStage';

    private maxFilesToAnalyze = 200;

    constructor(
        @Inject(AUTOMATION_EXECUTION_SERVICE_TOKEN)
        private automationExecutionService: IAutomationExecutionService,
        @Inject(PULL_REQUEST_MANAGER_SERVICE_TOKEN)
        private pullRequestHandlerService: IPullRequestManagerService,

        private logger: PinoLoggerService,
    ) {
        super();
    }

    protected async executeStage(
        context: CodeReviewPipelineContext,
    ): Promise<CodeReviewPipelineContext> {
        const lastExecution =
            await this.automationExecutionService.findLatestExecutionByDataExecutionFilter(
                {
                    pullRequestNumber: context.pullRequest.number,
                    platformType: context.platformType,
                },
                {
                    status: AutomationStatus.SUCCESS,
                    teamAutomation: { uuid: context.teamAutomationId },
                },
            );

        const files = await this.pullRequestHandlerService.getChangedFiles(
            context.organizationAndTeamData,
            context.repository,
            context.pullRequest,
            context.codeReviewConfig.ignorePaths,
            lastExecution?.dataExecution?.lastAnalyzedCommit,
        );

        if (!files?.length || files.length > this.maxFilesToAnalyze) {
            this.logger.warn({
                message: `No files to review after filtering PR#${context.pullRequest.number}`,
                context: FetchChangedFilesStage.name,
            });
            return this.updateContext(context, (draft) => {
                draft.status = PipelineStatus.SKIP;
            });
        }

        const lastExecutionResult = lastExecution
            ? {
                  commentId: lastExecution?.dataExecution?.commentId,
                  noteId: lastExecution?.dataExecution?.noteId,
                  threadId: lastExecution?.dataExecution?.threadId,
                  lastAnalyzedCommit:
                      lastExecution?.dataExecution?.lastAnalyzedCommit,
              }
            : undefined;

        return this.updateContext(context, (draft) => {
            draft.changedFiles = files;
            draft.lastExecution = lastExecutionResult;
            draft.pipelineMetadata = {
                ...draft.pipelineMetadata,
            };
        });
    }
}
