import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { IConversation } from '../interfaces/conversation.interface';
import { IConversationRepository } from './conversations.repository.contracts';

export const CONVERSATION_SERVICE_TOKEN = Symbol('ConversationService');

export interface GroupedConversations {
    today: IConversation[];
    yesterday: IConversation[];
    threeDaysAgo: IConversation[];
    fourDaysAgo: IConversation[];
    fiveDaysAgo: IConversation[];
    sixDaysAgo: IConversation[];
    lastWeek: IConversation[];
    twoWeeksAgo: IConversation[];
    older: IConversation[];
}

export interface IConversationService extends IConversationRepository {
    findConverstionAndFormat(
        userId: string,
        organizationAndTeamData: OrganizationAndTeamData,
        filter?: Partial<IConversation>,
    ): Promise<GroupedConversations>;
}
