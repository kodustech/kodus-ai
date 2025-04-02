import { OrganizationAutomationExecutionEntity } from "../entities/organization-automation-execution.entity";
import { IOrganizationAutomationExecution } from "../interfaces/organization-automation-execution.interface";
import { IOrganizationAutomationExecutionRepository } from "./organization-automation-execution.repository";

export const ORGANIZATION_AUTOMATION_EXECUTION_SERVICE_TOKEN = Symbol(
    'OrganizationAutomationExecutionService',
);

export interface IOrganizationAutomationExecutionService
    extends IOrganizationAutomationExecutionRepository {
    register(
        organizationAutomationExecution: Omit<IOrganizationAutomationExecution, 'uuid'>,
    ): Promise<OrganizationAutomationExecutionEntity>;
    findOneByOrganizationIdAndIssueId(
        organizationId: string,
        issueId: string,
    ): Promise<boolean>;
}
