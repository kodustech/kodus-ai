import { OrganizationAutomationExecutionEntity } from '../entities/organization-automation-execution.entity';
import { IOrganizationAutomationExecution } from '../interfaces/organization-automation-execution.interface';

export const ORGANIZATION_AUTOMATION_EXECUTION_REPOSITORY_TOKEN = Symbol(
    'OrganizationAutomationExecutionRepository',
);

export interface IOrganizationAutomationExecutionRepository {
    create(
        organizationAutomationExecution: Omit<IOrganizationAutomationExecution, 'uuid'>,
    ): Promise<OrganizationAutomationExecutionEntity>;
    update(
        filter: Partial<IOrganizationAutomationExecution>,
        data: Partial<IOrganizationAutomationExecution>,
    ): Promise<OrganizationAutomationExecutionEntity | undefined>;
    delete(uuid: string): Promise<void>;
    findById(uuid: string): Promise<OrganizationAutomationExecutionEntity | null>;
    find(
        filter?: Partial<IOrganizationAutomationExecution>,
    ): Promise<OrganizationAutomationExecutionEntity[]>;
}
