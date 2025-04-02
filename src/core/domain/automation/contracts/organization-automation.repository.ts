import { OrganizationAutomationEntity } from '../entities/organization-automation.entity';
import { IOrganizationAutomation } from '../interfaces/organization-automation.interface';

export const ORGANIZATION_AUTOMATION_REPOSITORY_TOKEN = Symbol(
    'OrganizationAutomationRepository',
);

export interface IOrganizationAutomationRepository {
    create(organizationAutomation: IOrganizationAutomation): Promise<OrganizationAutomationEntity>;
    update(
        filter: Partial<IOrganizationAutomation>,
        data: Partial<IOrganizationAutomation>,
    ): Promise<OrganizationAutomationEntity | undefined>;
    delete(uuid: string): Promise<void>;
    findById(uuid: string): Promise<OrganizationAutomationEntity | null>;
    find(filter?: Partial<IOrganizationAutomation>): Promise<OrganizationAutomationEntity[]>;
}
