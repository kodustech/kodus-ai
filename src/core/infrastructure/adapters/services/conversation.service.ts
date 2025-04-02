import {
    GroupedConversations,
    IConversationService,
} from '@/core/domain/conversation/contracts/conversation.service.contracts';
import { ConversationEntity } from '@/core/domain/conversation/entities/conversation.entity';
import { IConversation } from '@/core/domain/conversation/interfaces/conversation.interface';
import { Inject, Injectable } from '@nestjs/common';
import {
    CONVERSATION_REPOSITORY_TOKEN,
    IConversationRepository,
} from '@/core/domain/conversation/contracts/conversations.repository.contracts';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';

@Injectable()
export class ConversationService implements IConversationService {
    constructor(
        @Inject(CONVERSATION_REPOSITORY_TOKEN)
        private readonly conversationRepository: IConversationRepository,
    ) {}

    async delete(uuid: string): Promise<boolean> {
        return await this.conversationRepository.delete(uuid);
    }

    async updateTitle(
        uuid: string,
        title: string,
    ): Promise<ConversationEntity> {
        return await this.conversationRepository.updateTitle(uuid, title);
    }

    findOne(filter: Partial<IConversation>): Promise<ConversationEntity> {
        throw new Error('Method not implemented.');
    }

    async findById(
        uuid: string,
        userId: string,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<ConversationEntity> {
        return await this.conversationRepository.findById(
            uuid,
            userId,
            organizationAndTeamData,
        );
    }

    async findConverstionAndFormat(
        userId: string,
        organizationAndTeamData: OrganizationAndTeamData,
        filter?: Partial<IConversation>,
    ): Promise<GroupedConversations> {
        const groupedConversations: GroupedConversations = {
            today: [],
            yesterday: [],
            threeDaysAgo: [],
            fourDaysAgo: [],
            fiveDaysAgo: [],
            sixDaysAgo: [],
            lastWeek: [],
            twoWeeksAgo: [],
            older: [],
        };

        const now = new Date();

        const thresholds = [
            {
                key: 'today',
                start: new Date(
                    now.getFullYear(),
                    now.getMonth(),
                    now.getDate(),
                ),
            },
            {
                key: 'yesterday',
                start: new Date(
                    now.getFullYear(),
                    now.getMonth(),
                    now.getDate() - 1,
                ),
            },
            {
                key: 'threeDaysAgo',
                start: new Date(
                    now.getFullYear(),
                    now.getMonth(),
                    now.getDate() - 3,
                ),
            },
            {
                key: 'fourDaysAgo',
                start: new Date(
                    now.getFullYear(),
                    now.getMonth(),
                    now.getDate() - 4,
                ),
            },
            {
                key: 'fiveDaysAgo',
                start: new Date(
                    now.getFullYear(),
                    now.getMonth(),
                    now.getDate() - 5,
                ),
            },
            {
                key: 'sixDaysAgo',
                start: new Date(
                    now.getFullYear(),
                    now.getMonth(),
                    now.getDate() - 6,
                ),
            },
            {
                key: 'lastWeek',
                start: new Date(
                    now.getFullYear(),
                    now.getMonth(),
                    now.getDate() - 7,
                ),
            },
            {
                key: 'twoWeeksAgo',
                start: new Date(
                    now.getFullYear(),
                    now.getMonth(),
                    now.getDate() - 14,
                ),
            },
        ];

        const conversations = await this.find(
            userId,
            organizationAndTeamData,
            filter,
        );

        if (!conversations) {
            return groupedConversations;
        }

        conversations.forEach((conversation) => {
            const createdAt = new Date(conversation.createdAt);
            let categorized = false;

            for (const { key, start } of thresholds) {
                if (createdAt >= start) {
                    groupedConversations[
                        key as keyof GroupedConversations
                    ].push(conversation);
                    categorized = true;
                    break;
                }
            }

            if (!categorized) {
                groupedConversations.older.push(conversation);
            }
        });

        return groupedConversations;
    }

    async find(
        userId: string,
        organizationAndTeamData: OrganizationAndTeamData,
        filter?: Partial<IConversation>,
    ): Promise<any> {
        return await this.conversationRepository.find(
            userId,
            organizationAndTeamData,
            filter,
        );
    }

    async create(
        conversation: Omit<IConversation, 'uuid'>,
    ): Promise<ConversationEntity> {
        try {
            return await this.conversationRepository.create(conversation);
        } catch (err) {
            console.error(err);
            throw err;
        }
    }
}
