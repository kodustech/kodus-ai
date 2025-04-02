import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
    mapSimpleModelsToEntities,
    mapSimpleModelToEntity,
} from '@/shared/infrastructure/repositories/mappers';
import { IConversationRepository } from '@/core/domain/conversation/contracts/conversations.repository.contracts';
import { IConversation } from '@/core/domain/conversation/interfaces/conversation.interface';
import { ConversationModel } from './schema/conversation.model';
import { ConversationEntity } from '@/core/domain/conversation/entities/conversation.entity';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';

@Injectable()
export class ConversationRepository implements IConversationRepository {
    constructor(
        @InjectModel(ConversationModel.name)
        private readonly conversationModel: Model<ConversationModel>,
    ) {}

    async delete(uuid: string): Promise<boolean> {
        try {
            const result = await this.conversationModel
                .deleteOne({ _id: uuid })
                .exec();

            return result.acknowledged;
        } catch (error) {
            console.log(error);
            throw error;
        }
    }

    async updateTitle(
        uuid: string,
        title: string,
    ): Promise<ConversationEntity> {
        try {
            const updatedConversation =
                await this.conversationModel.findOneAndUpdate(
                    { _id: uuid },
                    { title: title },
                    { new: true },
                );

            if (!updatedConversation) {
                throw new Error('Covnersation not found');
            }

            return mapSimpleModelToEntity(
                updatedConversation,
                ConversationEntity,
            );
        } catch (error) {
            console.error(error);
            throw error;
        }
    }

    findOne(filter: Partial<IConversation>): Promise<ConversationEntity> {
        throw new Error('Method not implemented.');
    }

    async findById(
        uuid: string,
        userId: string,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<any> {
        try {
            const result = await this.conversationModel.aggregate([
                { $match: { _id: new Types.ObjectId(uuid) } },
                {
                    $lookup: {
                        from: 'session',
                        let: { sessionId: { $toObjectId: '$sessionId' } }, // Converts sessionId to ObjectId
                        pipeline: [
                            {
                                $match: {
                                    $expr: { $eq: ['$_id', '$$sessionId'] },
                                },
                            },
                            {
                                $project: {
                                    _id: 0, // Removes the _id field
                                    uuid: '$_id', // Renames _id to uuid
                                    date: 1,
                                    platformUserId: 1,
                                    platformName: 1,
                                    route: 1,
                                    organizationId: 1,
                                    teamId: 1,
                                    createdAt: 1,
                                    updatedAt: 1,
                                },
                            },
                        ],
                        as: 'session',
                    },
                },
                {
                    $unwind: {
                        path: '$session',
                        preserveNullAndEmptyArrays: true,
                    },
                }, // Ensures that session is a unique object
                {
                    $project: {
                        _id: 1,
                        title: 1,
                        type: 1,
                        createdAt: 1,
                        updatedAt: 1,
                        session: 1, // Keeps session data in the result
                    },
                },
            ]);

            // Checks if the result is empty
            if (!result || result.length === 0) {
                throw new NotFoundException(
                    `Conversation with ID ${uuid} not found or access denied.`,
                );
            }

            // Gets the first item from the array
            const conversation = result[0];

            // Maps the conversation to the entity
            return mapSimpleModelToEntity(conversation, ConversationEntity);
        } catch (error) {
            console.error(error);
            throw error;
        }
    }

    async find(
        userId: string,
        organizationAndTeamData: OrganizationAndTeamData,
        filter?: Partial<IConversation>,
    ): Promise<ConversationEntity[]> {
        try {
            const conversations = await this.conversationModel
                .find({
                    ...filter,
                    sessionId: { $exists: true },
                })
                .populate({
                    path: 'sessionId',
                    match: {
                        platformUserId: userId,
                        organizationId: organizationAndTeamData.organizationId,
                        teamId: organizationAndTeamData.teamId,
                    },
                    select: '_id platformUserId organizationId teamId', // Selects only the necessary fields
                })
                .select('title type createdAt updatedAt')
                .sort({ updatedAt: -1 })
                .lean()
                .exec();

            const filteredConversations = conversations.filter(
                (conversation) => conversation.sessionId !== null,
            );

            filteredConversations.forEach((conversation) => {
                if (conversation.sessionId) {
                    delete conversation.sessionId;
                }
            });

            return mapSimpleModelsToEntities(
                filteredConversations,
                ConversationEntity,
            );
        } catch (error) {
            console.log(error);
            throw error;
        }
    }

    async create(conversation: IConversation): Promise<any> {
        try {
            const conversationSaved =
                await this.conversationModel.create(conversation);

            return mapSimpleModelToEntity(
                conversationSaved,
                ConversationEntity,
            );
        } catch (error) {
            console.log(error);
            throw error;
        }
    }

    getNativeCollection() {
        try {
            const nativeConnection =
                this.conversationModel.db.collection('conversation');

            return nativeConnection;
        } catch (error) {
            console.log(error);
            throw error;
        }
    }
}
