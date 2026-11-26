import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';

import { IntegrationEntity } from '../entities/integration.entity';
import { IIntegrationRepository } from './integration.repository.contracts';

export type ConnectionRepositoryHint = {
    id?: string | number;
    name?: string;
    fullName?: string;
};

export type ResolvedConnection = {
    integration?: IntegrationEntity;
    /** Null when there is no connection, or when ambiguous candidates span platforms. */
    platform: PlatformType | null;
    /** Several connections fit and nothing told them apart. */
    ambiguous: boolean;
};

export const INTEGRATION_SERVICE_TOKEN = Symbol.for('IntegrationService');

export interface IIntegrationService extends IIntegrationRepository {
    /** The connection a provider's connect call rewrites; refuses when several match. */
    connectionToUpdate(
        organizationAndTeamData: OrganizationAndTeamData,
        platform: PlatformType,
        newConnection?: boolean,
    ): Promise<IntegrationEntity | undefined>;
    getPlatformAuthDetails<T>(
        organizationAndTeamData: OrganizationAndTeamData,
        platform: PlatformType,
    ): Promise<T>;
    resolveCodeManagementConnection(
        organizationAndTeamData: OrganizationAndTeamData,
        hint?: {
            platform?: PlatformType;
            repository?: ConnectionRepositoryHint;
        },
    ): Promise<ResolvedConnection>;
    getPlatformIntegration(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<{
        codeManagement: string;
    }>;
}
