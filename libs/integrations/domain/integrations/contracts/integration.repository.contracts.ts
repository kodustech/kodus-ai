import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';

import { IntegrationEntity } from '../entities/integration.entity';
import { IIntegration } from '../interfaces/integration.interface';

export const INTEGRATION_REPOSITORY_TOKEN = Symbol.for('IntegrationRepository');

export interface IIntegrationRepository {
    find(filter?: Partial<IIntegration>): Promise<IntegrationEntity[]>;
    findById(uuid: string): Promise<IntegrationEntity | undefined>;
    findOne(
        filter?: Partial<IIntegration>,
    ): Promise<IntegrationEntity | undefined>;
    create(integration: IIntegration): Promise<IntegrationEntity | undefined>;
    saveCodeManagementAuth(
        organizationAndTeamData: OrganizationAndTeamData,
        platform: PlatformType,
        authDetails: Record<string, unknown>,
    ): Promise<IntegrationEntity>;
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
