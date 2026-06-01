import { IPullRequestMessagesRepository } from '@libs/code-review/domain/pullRequestMessages/contracts/pullRequestMessages.repository.contract';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { IPullRequestMessages } from '@libs/code-review/domain/pullRequestMessages/interfaces/pullRequestMessages.interface';
import { PullRequestMessagesEntity } from '@libs/code-review/domain/pullRequestMessages/entities/pullRequestMessages.entity';
import {
    mapSimpleModelsToEntities,
    mapSimpleModelToEntity,
} from '@libs/core/infrastructure/repositories/mappers';
import { PullRequestMessagesModel } from './schemas/mongoose/pullRequestMessages.model';

@Injectable()
export class PullRequestMessagesRepository implements IPullRequestMessagesRepository {
    constructor(
        @InjectModel(PullRequestMessagesModel.name)
        private readonly pullRequestMessagesModel: Model<PullRequestMessagesModel>,
    ) {}

    async create(
        pullRequestMessages: Omit<IPullRequestMessages, 'uuid'>,
    ): Promise<PullRequestMessagesEntity> {
        const saved =
            await this.pullRequestMessagesModel.create(pullRequestMessages);
        return mapSimpleModelToEntity(saved, PullRequestMessagesEntity);
    }

    async update(
        pullRequestMessages: IPullRequestMessages,
    ): Promise<PullRequestMessagesEntity> {
        const updated = await this.pullRequestMessagesModel
            .findByIdAndUpdate(pullRequestMessages.uuid, pullRequestMessages, {
                new: true,
            })
            .lean();
        return mapSimpleModelToEntity(updated, PullRequestMessagesEntity);
    }

    async delete(uuid: string): Promise<void> {
        await this.pullRequestMessagesModel.findByIdAndDelete(uuid);
    }

    async deleteByFilter(
        filter: Partial<IPullRequestMessages>,
    ): Promise<boolean> {
        if (!filter || Object.keys(filter).length === 0) {
            return false;
        }

        if (
            !filter.organizationId &&
            !filter.repositoryId &&
            !filter.configLevel
        ) {
            throw new Error(
                'OrganizationId, repositoryId and configLevel are required',
            );
        }

        const result = await this.pullRequestMessagesModel
            .findOneAndDelete(filter)
            .select({ _id: 1 });
        return result !== null;
    }

    async find(
        filter?: Partial<IPullRequestMessages>,
    ): Promise<PullRequestMessagesEntity[]> {
        const docs = await this.pullRequestMessagesModel
            .find(filter)
            .lean()
            .exec();
        return mapSimpleModelsToEntities(docs, PullRequestMessagesEntity);
    }

    async findOne(
        filter?: Partial<IPullRequestMessages>,
    ): Promise<PullRequestMessagesEntity | null> {
        const doc = await this.pullRequestMessagesModel
            .findOne(filter)
            .lean()
            .exec();
        return doc
            ? mapSimpleModelToEntity(doc, PullRequestMessagesEntity)
            : null;
    }

    async findById(uuid: string): Promise<PullRequestMessagesEntity | null> {
        const doc = await this.pullRequestMessagesModel
            .findById(uuid)
            .lean()
            .exec();
        return doc
            ? mapSimpleModelToEntity(doc, PullRequestMessagesEntity)
            : null;
    }
}
