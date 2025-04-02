import {
    ExecutionRouterPromptParams,
    RouterPromptParams,
} from '@/config/types/general/agentRouter.type';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { AuthDetailsParams } from '../types/auth-details-params.type';
import { PlatformType } from '@/shared/domain/enums/platform-type.enum';
import { LanguageValue } from '@/shared/domain/enums/language-parameter.enum';

export const AGENT_SERVICE_TOKEN = Symbol('AgentService');

export interface IAgentService {
    getRouter(routerPromptParams: RouterPromptParams): Promise<any>;
    executionRouterPrompt(
        executionRouterPromptParams: ExecutionRouterPromptParams,
    ): Promise<any>;
    getMemory(sessionId: string): Promise<any>;
    getAuthDetails(
        filters: AuthDetailsParams,
    ): Promise<OrganizationAndTeamData>;
    createSession(
        platformUserId: string,
        platformName: string,
        route: string,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<any>;
    checkIfHasActiveSessions(
        platformUserId: string,
        organizationAndTeamData?: OrganizationAndTeamData,
    ): Promise<any>;
    getAuthDetailsByOrganization(filter: any);
    sendMetricMessage(
        organizationAndTeamData: OrganizationAndTeamData,
        channelId: string,
        language: LanguageValue,
    );
    handlerCheckMultiConfigurationTeams(
        routerPromptParams: RouterPromptParams,
    ): Promise<any>;
    executeTools(
        tools: any,
        organizationAndTeamData: OrganizationAndTeamData,
        platformType?: PlatformType,
    );
    conversationWithKody(
        organizationAndTeamData: OrganizationAndTeamData,
        platformUserId: string,
        message: string,
        userName?: string,
        sessionId?: string,
    ): Promise<any>;
}
