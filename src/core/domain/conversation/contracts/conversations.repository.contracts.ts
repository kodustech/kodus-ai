import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { ConversationEntity } from '../entities/conversation.entity';
import { IConversation } from '../interfaces/conversation.interface';

export const CONVERSATION_REPOSITORY_TOKEN = Symbol('ConversationRepository');

export interface IConversationRepository {
    create(conversation: Omit<IConversation, 'uuid'>): Promise<any>;
    findById(
        uuid: string,
        userId: string,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<ConversationEntity>;
    findOne(filter: Partial<IConversation>): Promise<ConversationEntity>;
    find(
        userId: string,
        organizationAndTeamData: OrganizationAndTeamData,
        filter?: Partial<IConversation>,
    ): Promise<ConversationEntity[]>;
    updateTitle(uuid: string, title: string): Promise<ConversationEntity>;
    delete(uuid: string): Promise<boolean>;
}
