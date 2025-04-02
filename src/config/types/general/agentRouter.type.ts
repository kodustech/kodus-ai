import { AuthDetailsParams } from '@/core/domain/agents/types/auth-details-params.type';
import { OrganizationAndTeamData } from './organizationAndTeamData';
import { PlatformType } from '@/shared/domain/enums/platform-type.enum';

export type RouterPromptParams = {
    message: string;
    organizationAndTeamData: OrganizationAndTeamData;
    memory?: any;
    authDetailsParams?: AuthDetailsParams;
    route?: string;
    sessionId?: string;
    parameters?: any[];
    platformType?: PlatformType;
};

export type ExecutionRouterPromptParams = {
    router: RouterPromptParams;
    message: string;
    userId: string;
    channel: string;
    sessionId: string;
    userName?: string;
    organizationAndTeamData?: OrganizationAndTeamData;
    platformType?: PlatformType;
    metaData?: Record<string, any>;
};

export type DetermineRouteParams = {
    message: string;
    memory: string;
    sessionId?: string;
    organizationAndTeamData?: OrganizationAndTeamData;
};

export type RunParams = {
    message: string;
    userId: string;
    channel: string;
    sessionId: string;
    userName?: string;
    parameters?: any[];
    organizationAndTeamData?: OrganizationAndTeamData;
    platformType?: PlatformType;
    metaData?: Record<string, any>;
};

export type HandleUserInputParams = {
    input: string;
    context: any;
    organizationAndTeamData?: OrganizationAndTeamData;
};
