import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { IssueStatus } from '@libs/core/infrastructure/config/types/general/issues.type';
import {
    mapSimpleModelsToEntities,
    mapSimpleModelToEntity,
} from '@libs/core/infrastructure/repositories/mappers';
import { IIssuesRepository } from '@libs/issues/domain/contracts/issues.repository';
import { IssuesEntity } from '@libs/issues/domain/entities/issues.entity';
import { IIssue } from '@libs/issues/domain/interfaces/issues.interface';

import { IssuesModel } from './schemas/issues.model';
import { LabelType } from '@libs/common/utils/codeManagement/labels';
import { SeverityLevel } from '@libs/common/utils/enums/severityLevel.enum';

@Injectable()
export class IssuesRepository implements IIssuesRepository {
    constructor(
        @InjectModel(IssuesModel.name)
        private readonly issuesModel: Model<IssuesModel>,
    ) {}

    getNativeCollection() {
        return this.issuesModel.db.collection('issues');
    }

    async create(issue: Omit<IIssue, 'uuid'>): Promise<IssuesEntity> {
        const saved = await this.issuesModel.create(issue);
        return mapSimpleModelToEntity(saved, IssuesEntity);
    }

    async findById(uuid: string): Promise<IssuesEntity | null> {
        const doc = await this.issuesModel.findById(uuid).exec();
        return doc ? mapSimpleModelToEntity(doc, IssuesEntity) : null;
    }

    async findOne(filter?: Partial<IIssue>): Promise<IssuesEntity | null> {
        const doc = await this.issuesModel.findOne(filter).exec();
        return doc ? mapSimpleModelToEntity(doc, IssuesEntity) : null;
    }

    async findByFileAndStatus(
        organizationId: string,
        repositoryId: string,
        filePath: string,
        status?: IssueStatus,
    ): Promise<IssuesEntity[] | null> {
        const issues = await this.issuesModel.find({
            'organizationId': organizationId,
            'repository.id': repositoryId,
            'filePath': filePath,
            'status': status ? status : { $ne: IssueStatus.OPEN },
        });

        return issues ? mapSimpleModelsToEntities(issues, IssuesEntity) : null;
    }

    async findByFilters(filter?: Partial<IIssue>): Promise<IssuesEntity[]> {
        const query = this.issuesModel.find(filter);

        const docs = await query.exec();
        return mapSimpleModelsToEntities(docs, IssuesEntity);
    }

    async find(organizationId: string): Promise<IssuesEntity[]> {
        const docs = await this.issuesModel
            .find({
                organizationId: organizationId,
            })
            .select({
                'uuid': 1,
                'title': 1,
                'filePath': 1,
                'label': 1,
                'severity': 1,
                'status': 1,
                'repository.id': 1,
                'repository.name': 1,
                'contributingSuggestions': 1,
                'createdAt': 1,
                '_id': 1,
            })
            .exec();
        return mapSimpleModelsToEntities(docs, IssuesEntity);
    }

    async count(filter?: Partial<IIssue>): Promise<number> {
        return await this.issuesModel.countDocuments(filter).exec();
    }

    async findBySuggestionId(
        suggestionId: string,
    ): Promise<IssuesEntity | null> {
        const doc = await this.issuesModel
            .findOne({
                contributingSuggestionIds: suggestionId,
            })
            .exec();

        return doc ? mapSimpleModelToEntity(doc, IssuesEntity) : null;
    }

    //#region Update
    async update(
        issue: IssuesEntity,
        updateData: Omit<Partial<IIssue>, 'uuid' | 'id'>,
    ): Promise<IssuesEntity | null> {
        const doc = await this.issuesModel.findByIdAndUpdate(
            issue.uuid,
            { $set: updateData },
            { new: true },
        );
        return doc ? mapSimpleModelToEntity(doc, IssuesEntity) : null;
    }

    async updateLabel(
        uuid: string,
        label: LabelType,
    ): Promise<IssuesEntity | null> {
        const doc = await this.issuesModel.findByIdAndUpdate(
            uuid,
            {
                $set: {
                    'label': label,
                    'representativeSuggestion.label': label,
                },
            },
            { new: true },
        );
        return doc ? mapSimpleModelToEntity(doc, IssuesEntity) : null;
    }

    async updateSeverity(
        uuid: string,
        severity: SeverityLevel,
    ): Promise<IssuesEntity | null> {
        const doc = await this.issuesModel.findByIdAndUpdate(
            uuid,
            {
                $set: {
                    'severity': severity,
                    'representativeSuggestion.severity': severity,
                },
            },
            { new: true },
        );
        return doc ? mapSimpleModelToEntity(doc, IssuesEntity) : null;
    }

    async updateStatus(
        uuid: string,
        status: IssueStatus,
    ): Promise<IssuesEntity | null> {
        const doc = await this.issuesModel.findByIdAndUpdate(
            uuid,
            { $set: { status: status } },
            { new: true },
        );
        return doc ? mapSimpleModelToEntity(doc, IssuesEntity) : null;
    }

    async updateStatusByIds(
        uuids: string[],
        status: IssueStatus,
    ): Promise<IssuesEntity[] | null> {
        await this.issuesModel.updateMany(
            { _id: { $in: uuids } },
            { $set: { status: status } },
        );

        const docs = await this.issuesModel.find({ _id: { $in: uuids } });
        return mapSimpleModelsToEntities(docs, IssuesEntity);
    }
    //#endregion

    async addSuggestionIds(
        uuid: string,
        suggestionIds: string[],
    ): Promise<IssuesEntity | null> {
        const doc = await this.issuesModel.findByIdAndUpdate(
            uuid,
            {
                $addToSet: {
                    contributingSuggestionIds: { $each: suggestionIds },
                },
            },
            { new: true },
        );
        return doc ? mapSimpleModelToEntity(doc, IssuesEntity) : null;
    }
}
