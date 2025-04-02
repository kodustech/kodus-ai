import { OauthV2AccessResponse } from '@slack/web-api';
import { SaveIntegrationSelected } from '@/config/types/integrations.type';
import { Channel } from '../../platformIntegrations/types/communication/channel.type';

export const SLACK_SERVICE_TOKEN = Symbol('SlackService');

export interface ISlackService {
    verifyConnection(params: any): Promise<{ hasConnection: boolean }>;
    createIntegration(
        code: string,
        userId: string,
        organizationId: string,
    ): Promise<OauthV2AccessResponse>;
    getUserList(organizationId: string): Promise<any>;
    getChannels(organizationId: string): Promise<Channel[] | []>;
    newMessageBYChannelId(channel: string, message: string): Promise<void>;
    newBlockMessage(message: any, organizationId: string, channelId: string);
    newMessage(
        message: string,
        organizationId: string,
        channelId: string,
    ): Promise<{ success: boolean; message: string }>;
    saveSlackChannelSelected(
        body: SaveIntegrationSelected,
        organizationId: string,
    ): Promise<void>;
}
