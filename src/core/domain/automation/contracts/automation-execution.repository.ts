import { AutomationExecutionEntity } from '../entities/automation-execution.entity';
import { IAutomationExecution } from '../interfaces/automation-execution.interface';

export const AUTOMATION_EXECUTION_REPOSITORY_TOKEN = Symbol(
    'AutomationExecutionRepository',
);

export interface IAutomationExecutionRepository {
    create(
        automationExecution: Omit<IAutomationExecution, 'uuid'>,
    ): Promise<AutomationExecutionEntity>;
    update(
        filter: Partial<IAutomationExecution>,
        data: Partial<IAutomationExecution>,
    ): Promise<AutomationExecutionEntity | undefined>;
    delete(uuid: string): Promise<void>;
    findById(uuid: string): Promise<AutomationExecutionEntity | null>;
    find(
        filter?: Partial<IAutomationExecution>,
    ): Promise<AutomationExecutionEntity[]>;
    findLatestExecutionByDataExecutionFilter(
        dataExecutionFilter: Partial<any>,
        additionalFilters?: Partial<any>,
    ): Promise<AutomationExecutionEntity | null>;
}
