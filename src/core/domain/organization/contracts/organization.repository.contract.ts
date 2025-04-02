import { OrganizationEntity } from '../entities/organization.entity';
import { IOrganization } from '../interfaces/organization.interface';

export const ORGANIZATION_REPOSITORY_TOKEN = Symbol('OrganizationRepository');

export interface IOrganizationRepository {
    find(filter: Partial<IOrganization>): Promise<OrganizationEntity[]>;
    findOne(
        filter: Partial<IOrganization>,
    ): Promise<OrganizationEntity | undefined>;
    findById(uuid: string): Promise<OrganizationEntity | undefined>;
    create(
        organizationEntity: IOrganization,
    ): Promise<OrganizationEntity | undefined>;
    deleteOne(filter: Partial<IOrganization>): Promise<void>;
    update(
        filter: Partial<IOrganization>,
        data: Partial<IOrganization>,
    ): Promise<OrganizationEntity | undefined>;
}
