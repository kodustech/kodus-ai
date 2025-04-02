import { AutomationExecutionEntity } from '../entities/automation-execution.entity';
import { IAutomationExecution } from '../interfaces/automation-execution.interface';
import { IAutomationExecutionRepository } from './automation-execution.repository';

export const AUTOMATION_EXECUTION_SERVICE_TOKEN = Symbol(
    'AutomationExecutionService',
);

export interface IAutomationExecutionService
    extends IAutomationExecutionRepository {
    register(
        automationExecution: Omit<IAutomationExecution, 'uuid'>,
    ): Promise<AutomationExecutionEntity>;
    findOneByOrganizationIdAndIssueId(
        organizationId: string,
        issueId: string,
    ): Promise<boolean>;
}
