import { CodeReviewExecutionEntity } from '@libs/automation/domain/codeReviewExecutions/entities/codeReviewExecution.entity';
import { IAutomationExecutionRepository } from './automation-execution.repository';
import { AutomationExecutionEntity } from '../entities/automation-execution.entity';
import { IAutomationExecution } from '../interfaces/automation-execution.interface';
import { CodeReviewExecution } from '../../codeReviewExecutions/interfaces/codeReviewExecution.interface';
import { AutomationStatus } from '../../automation/enum/automation-status';

export const AUTOMATION_EXECUTION_SERVICE_TOKEN = Symbol(
    'AutomationExecutionService',
);

export interface IAutomationExecutionService extends IAutomationExecutionRepository {
    findOneByOrganizationIdAndIssueId(
        organizationId: string,
        issueId: string,
    ): Promise<boolean>;

    createCodeReview(
        automationExecution: Omit<
            IAutomationExecution,
            'uuid' | 'createdAt' | 'updatedAt' | 'codeReviewExecutions'
        >,
        message: string,
        stageName?: string,
        metadata?: Record<string, any>,
    ): Promise<{
        execution: AutomationExecutionEntity;
        stageLog?: CodeReviewExecutionEntity<IAutomationExecution>;
    } | null>;

    updateCodeReview(
        filter: Partial<IAutomationExecution>,
        automationExecution: Partial<
            Omit<
                IAutomationExecution,
                'uuid' | 'createdAt' | 'updatedAt' | 'codeReviewExecutions'
            >
        >,
        message: string,
        stageName?: string,
        metadata?: Record<string, any>,
    ): Promise<{
        execution: AutomationExecutionEntity;
        stageLog?: CodeReviewExecutionEntity<IAutomationExecution>;
    } | null>;

    updateStageLog(
        uuid: string,
        data: Partial<
            Omit<
                CodeReviewExecution<IAutomationExecution>,
                'uuid' | 'createdAt' | 'updatedAt'
            >
        >,
    ): Promise<void>;

    finalizeInProgressStageLogs(
        executionUuid: string,
        status: AutomationStatus,
        message: string,
    ): Promise<number>;

    findLatestStageLog(
        executionId: string,
        stageName: string,
    ): Promise<CodeReviewExecutionEntity<IAutomationExecution> | null>;

    hasStageWithStatus(
        executionId: string,
        stageNames: string[],
        statuses: AutomationStatus[],
    ): Promise<boolean>;
}
