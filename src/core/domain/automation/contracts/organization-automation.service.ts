import { OrganizationAutomationEntity } from "../entities/organization-automation.entity";
import { IOrganizationAutomation } from "../interfaces/organization-automation.interface";
import { IOrganizationAutomationRepository } from "./organization-automation.repository";

export const ORGANIZATION_AUTOMATION_SERVICE_TOKEN = Symbol('OrganizationAutomationService');

export interface IOrganizationAutomationService extends IOrganizationAutomationRepository {
    register(
        organizationAutomation: Omit<IOrganizationAutomation, 'uuid'>,
    ): Promise<OrganizationAutomationEntity>;
}
