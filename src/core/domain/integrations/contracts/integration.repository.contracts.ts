import { PlatformType } from '@/shared/domain/enums/platform-type.enum';
import { IntegrationEntity } from '../entities/integration.entity';
import { IIntegration } from '../interfaces/integration.interface';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';

export const INTEGRATION_REPOSITORY_TOKEN = Symbol('IntegrationRepository');

export interface IIntegrationRepository {
    find(filter?: Partial<IIntegration>): Promise<IntegrationEntity[]>;
    findById(uuid: string): Promise<IntegrationEntity | undefined>;
    findOne(
        filter?: Partial<IIntegration>,
    ): Promise<IntegrationEntity | undefined>;
    create(integration: IIntegration): Promise<IntegrationEntity | undefined>;
    update(
        filter: Partial<IIntegration>,
        data: Partial<IIntegration>,
    ): Promise<IntegrationEntity | undefined>;
    delete(uuid: string): Promise<void>;
    getFullIntegrationDetails(
        organizationAndTeamData: OrganizationAndTeamData,
        platform: PlatformType,
    ): Promise<IntegrationEntity>;
}
