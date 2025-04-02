import { CreateAuthIntegrationUseCase } from './create-integration.use-case';
import { CreateOrUpdateIntegrationConfigUseCase } from './create-or-update-configs.use-case';
import { GetChannelsUseCase } from './get-channels';
import { GetCommunicationMemberListUseCase } from './get-communication-members-list.use-case';
import { SaveChannelSelectedUseCase } from './save-channel-selected.use-case';
import { SendKodyNotificationOnChannelUseCase } from './sendNotification/send-kody-notification-on-channel.use-case';
import { SendKodyNotificationOnDmUseCase } from './sendNotification/send-kody-notification-on-dm.use-case';
import { SendKodyNotificationToTeamMemberUseCase } from './sendNotification/send-kody-notification-to-team-member.use-case';
import { UpdateAuthIntegrationUseCase } from './update-integration.use-case';
import { VerifyConnectionCommunicationListUseCase } from './verify-connection-communication-list.use-case';

export default [
    GetCommunicationMemberListUseCase,
    CreateAuthIntegrationUseCase,
    UpdateAuthIntegrationUseCase,
    CreateOrUpdateIntegrationConfigUseCase,
    VerifyConnectionCommunicationListUseCase,
    GetChannelsUseCase,
    SaveChannelSelectedUseCase,
    SendKodyNotificationOnChannelUseCase,
    SendKodyNotificationOnDmUseCase,
    SendKodyNotificationToTeamMemberUseCase,
];
