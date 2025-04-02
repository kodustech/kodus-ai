import { CommunicationManagementConnectionStatus } from '@/shared/utils/decorators/validate-communication-management-integration.decorator';
import { Channel } from '../types/communication/channel.type';
import { ICommonPlatformIntegrationService } from './common.interface';


export interface ICommunicationService
    extends ICommonPlatformIntegrationService {
    getChannel(params: any): Promise<Channel[]>;
    getListMembers(params: any): Promise<any>;
    verifyConnection(params: any): Promise<CommunicationManagementConnectionStatus>;
    newMessagesToProjectLeader(params: any): Promise<{
        success: boolean;
        message: string;
    }>;
    sendInsightMessage(params: any): Promise<any>;
    handlerTemplateMessage(params: any): Promise<any>;
    newBlockMessage(params: any): Promise<any>;
    getChannelIdLeaderTeam(
        params: any,
    ): Promise<{ id: string; name: string }[]>;
    newTextMessage(params: any): Promise<any>;
    getTeamChannelId(params: any): Promise<any>;
    saveChannelSelected(params: any): Promise<void>;
    saveCheckinHistory(params: any): Promise<any>;
    saveCheckinHistoryOrganization(params: any): Promise<any>;
    formatKodyNotification(params: any): Promise<any>;
    formatMetricsMessage(params: any): Promise<any>;
}
