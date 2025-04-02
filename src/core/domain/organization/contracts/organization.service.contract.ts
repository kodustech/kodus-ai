import { OrganizationEntity } from '../entities/organization.entity';
import { IOrganization } from '../interfaces/organization.interface';
import { IOrganizationRepository } from './organization.repository.contract';

export const ORGANIZATION_SERVICE_TOKEN = Symbol('OrganizationService');

export interface IOrganizationService extends IOrganizationRepository {
    createOrganizationWithTenant(
        organizationData: Partial<IOrganization>,
    ): Promise<OrganizationEntity | undefined>;
    findOneByUserId(user_id: string): Promise<OrganizationEntity | undefined>;
}
