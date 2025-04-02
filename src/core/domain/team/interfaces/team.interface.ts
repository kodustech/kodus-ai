import { STATUS } from '@/config/types/database/status.type';
import { IOrganization } from '@/core/domain/organization/interfaces/organization.interface';
import { IntegrationCategory } from '@/shared/domain/enums/integration-category.enum';

export interface ITeam {
    uuid: string;
    name: string;
    organization?: Partial<IOrganization> | null;
    status: STATUS;
}

export interface ITeamWithIntegrations extends ITeam {
    hasCodeManagement: boolean;
    hasProjectManagement: boolean;
    hasCommunication: boolean;
    isCodeManagementConfigured: boolean;
    isProjectManagementConfigured: boolean;
    isCommunicationConfigured: boolean;
}

export enum IntegrationStatusFilter {
    INTEGRATED = 'INTEGRATED',
    CONFIGURED = 'CONFIGURED',
    UNDEFINED = undefined,
}

export interface TeamsFilter {
    organizationId?: string;
    status?: STATUS;
    integrationCategories?: IntegrationCategory[];
    integrationStatus?: IntegrationStatusFilter;
    matchType?: IntegrationMatchType;
}

export enum IntegrationMatchType {
    SOME = 'SOME',
    EVERY = 'EVERY'
}

