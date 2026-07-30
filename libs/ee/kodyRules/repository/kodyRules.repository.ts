import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, PipelineStage } from 'mongoose';

import {
    mapSimpleModelsToEntities,
    mapSimpleModelToEntity,
} from '@libs/core/infrastructure/repositories/mappers';
import { IKodyRulesRepository } from '@libs/kodyRules/domain/contracts/kodyRules.repository.contract';
import { KodyRulesEntity } from '@libs/kodyRules/domain/entities/kodyRules.entity';
import {
    IKodyRule,
    IKodyRules,
    KodyRulesStatus,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';
import { KodyRulesModel } from '@libs/kodyRules/infrastructure/adapters/repositories/schemas/kodyRules.model';
import { KodyRulesValidationService } from '../service/kody-rules-validation.service';

@Injectable()
export class KodyRulesRepository implements IKodyRulesRepository {
    private readonly kodyRulesValidationService: KodyRulesValidationService;

    constructor(
        @InjectModel(KodyRulesModel.name)
        private readonly kodyRulesModel: Model<KodyRulesModel>,
        kodyRulesValidationService: KodyRulesValidationService,
    ) {
        this.kodyRulesValidationService = kodyRulesValidationService;
    }

    getNativeCollection() {
        return this.kodyRulesModel.db.collection('kodyRules');
    }

    //#region Create
    async create(
        kodyRules: Omit<IKodyRules, 'uuid'>,
    ): Promise<KodyRulesEntity> {
        const saved = await this.kodyRulesModel.create(kodyRules);
        return mapSimpleModelToEntity(saved, KodyRulesEntity);
    }
    //#endregion

    //#region Get/Find
    async findById(uuid: string): Promise<IKodyRule | null> {
        const pipeline = [
            { $match: { 'rules.uuid': uuid } },
            { $unwind: '$rules' },
            { $match: { 'rules.uuid': uuid } },
            { $replaceRoot: { newRoot: '$rules' } },
        ];

        const result = await this.kodyRulesModel.aggregate(pipeline).exec();
        return result.length > 0 ? result[0] : null;
    }

    async findOne(
        filter?: Partial<IKodyRules>,
    ): Promise<KodyRulesEntity | null> {
        const doc = await this.kodyRulesModel.findOne(filter).exec();
        return doc ? mapSimpleModelToEntity(doc, KodyRulesEntity) : null;
    }

    async findOrganizationIdsWithRules(): Promise<string[]> {
        // Projection + lean: only the organizationId of docs that have ≥1 rule.
        // The detector sweep needs the org list, not every embedded rules array
        // (loading all of them would grow memory unbounded on a large fleet).
        const docs = await this.kodyRulesModel
            .find({ 'rules.0': { $exists: true } }, { organizationId: 1 })
            .lean()
            .exec();
        return docs
            .map((d: any) => d?.organizationId)
            .filter((id: unknown): id is string => typeof id === 'string');
    }

    async find(filter?: Partial<IKodyRules>): Promise<KodyRulesEntity[]> {
        if (!filter) {
            const docs = await this.kodyRulesModel.find().exec();
            return mapSimpleModelsToEntities(docs, KodyRulesEntity);
        }

        const pipeline: any[] = [];

        // Initial match for organizationId and other top-level properties
        const initialMatch: any = {};
        Object.keys(filter).forEach((key) => {
            if (key !== 'rules' && filter[key] !== undefined) {
                initialMatch[key] = filter[key];
            }
        });

        if (Object.keys(initialMatch).length > 0) {
            pipeline.push({ $match: initialMatch });
        }

        // If there are rules in the filter
        if (filter.rules?.length > 0) {
            // Unwind to separate the rules
            pipeline.push({ $unwind: '$rules' });

            // Build the conditions for the rules
            const rulesConditions = filter?.rules?.map((rule) => {
                const ruleMatch: any = {};

                Object.keys(rule).forEach((key) => {
                    if (rule[key] !== undefined) {
                        ruleMatch[`rules.${key}`] = rule[key];
                    }
                });

                return ruleMatch;
            });

            // Add the $match with $or for the rule conditions
            if (rulesConditions.length > 0) {
                pipeline.push({
                    $match: {
                        $or: rulesConditions.map((condition) => {
                            // Includes rules that match the condition or have undefined properties.
                            return {
                                $or: [condition],
                            };
                        }),
                    },
                });
            }

            // Group back while keeping only the filtered rules
            pipeline.push({
                $group: {
                    _id: '$_id',
                    organizationId: { $first: '$organizationId' },
                    rules: { $push: '$rules' },
                    createdAt: { $first: '$createdAt' },
                    updatedAt: { $first: '$updatedAt' },
                },
            });
        }

        const docs = await this.kodyRulesModel.aggregate(pipeline).exec();

        return mapSimpleModelsToEntities(docs, KodyRulesEntity);
    }

    async findByOrganizationId(
        organizationId: string,
    ): Promise<KodyRulesEntity | null> {
        const doc = await this.kodyRulesModel
            .findOne({ organizationId })
            .exec();
        return doc ? mapSimpleModelToEntity(doc, KodyRulesEntity) : null;
    }

    async countRules(
        organizationId: string,
        status?: KodyRulesStatus,
    ): Promise<number> {
        // Count via aggregation so the doc itself (which embeds the
        // full rules array — can be large on active orgs) never leaves
        // MongoDB just to return a single number. Requires the
        // organizationId index from kodyRules.model.ts for sub-ms
        // lookups.
        const pipeline: PipelineStage[] = [
            { $match: { organizationId } },
        ];
        if (status) {
            pipeline.push(
                { $project: {
                    total: {
                        $size: {
                            $filter: {
                                input: { $ifNull: ['$rules', []] },
                                as: 'rule',
                                cond: { $eq: ['$$rule.status', status] },
                            },
                        },
                    },
                } },
            );
        } else {
            pipeline.push(
                { $project: { total: { $size: { $ifNull: ['$rules', []] } } } },
            );
        }
        const [result] = await this.kodyRulesModel
            .aggregate<{ total: number }>(pipeline)
            .exec();
        return result?.total ?? 0;
    }

    async countRulesByRepository(
        organizationId: string,
        statuses: KodyRulesStatus[],
    ): Promise<
        Array<{
            repositoryId: string;
            directoryId: string | null;
            count: number;
        }>
    > {
        // One aggregation returns the per-(repo, directory) counts for the
        // whole org, instead of one full-array fetch per repository card.
        // Unwinds the embedded array, keeps the requested statuses, then
        // groups. directoryId is null for repository-level rules (the field
        // is absent on those, which $group collapses to null).
        const pipeline: PipelineStage[] = [
            { $match: { organizationId } },
            { $unwind: '$rules' },
            { $match: { 'rules.status': { $in: statuses } } },
            {
                $group: {
                    _id: {
                        repositoryId: '$rules.repositoryId',
                        directoryId: '$rules.directoryId',
                    },
                    count: { $sum: 1 },
                },
            },
            {
                $project: {
                    _id: 0,
                    repositoryId: '$_id.repositoryId',
                    directoryId: { $ifNull: ['$_id.directoryId', null] },
                    count: 1,
                },
            },
        ];

        return this.kodyRulesModel
            .aggregate<{
                repositoryId: string;
                directoryId: string | null;
                count: number;
            }>(pipeline)
            .exec();
    }
    //#endregion

    //#region Update
    async update(
        uuid: string,
        updateData: Partial<IKodyRules>,
    ): Promise<KodyRulesEntity | null> {
        const updated = await this.kodyRulesModel
            .findOneAndUpdate(
                { _id: uuid },
                { $set: updateData },
                { new: true },
            )
            .exec();
        return updated
            ? mapSimpleModelToEntity(updated, KodyRulesEntity)
            : null;
    }

    async addRule(
        uuid: string,
        newRule: Partial<IKodyRule>,
    ): Promise<KodyRulesEntity | null> {
        const updated = await this.kodyRulesModel
            .findOneAndUpdate(
                { _id: uuid },
                { $push: { rules: newRule } },
                { new: true },
            )
            .exec();

        return mapSimpleModelToEntity(updated, KodyRulesEntity);
    }

    async updateRule(
        uuid: string,
        ruleId: string,
        updateData: Partial<IKodyRule>,
    ): Promise<KodyRulesEntity | null> {
        // Field-level $set (`rules.$.field`) instead of replacing the whole
        // matched element (`rules.$`). Replacing the element means a caller
        // that passes a Partial — which the signature explicitly allows —
        // silently wipes every field it omitted. Per-field $set also narrows
        // the concurrency window: two edits touching DIFFERENT fields of the
        // same rule no longer clobber each other (only same-field edits race,
        // last-write-wins, which is expected). `uuid` is undefined-safe.
        const setFields: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(updateData)) {
            if (value !== undefined) {
                setFields[`rules.$.${key}`] = value;
            }
        }

        // Nothing concrete to set (all-undefined patch) — avoid an empty $set,
        // which Mongo rejects. Return the current doc unchanged.
        if (Object.keys(setFields).length === 0) {
            const current = await this.kodyRulesModel
                .findOne({ '_id': uuid, 'rules.uuid': ruleId })
                .exec();
            return current
                ? mapSimpleModelToEntity(current, KodyRulesEntity)
                : null;
        }

        const updated = await this.kodyRulesModel
            .findOneAndUpdate(
                { '_id': uuid, 'rules.uuid': ruleId },
                { $set: setFields },
                { new: true },
            )
            .exec();
        return updated
            ? mapSimpleModelToEntity(updated, KodyRulesEntity)
            : null;
    }
    //#endregion

    //#region Delete
    async delete(uuid: string): Promise<boolean> {
        const deleted = await this.kodyRulesModel.deleteOne({ _id: uuid });
        return deleted.deletedCount === 1;
    }

    async deleteRule(uuid: string, ruleId: string): Promise<boolean> {
        const deleted = await this.kodyRulesModel
            .updateOne({ _id: uuid }, { $pull: { rules: { uuid: ruleId } } })
            .exec();

        return deleted.acknowledged;
    }

    async deleteRuleLogically(
        uuid: string,
        ruleId: string,
    ): Promise<KodyRulesEntity | null> {
        const updated = await this.kodyRulesModel
            .findOneAndUpdate(
                { '_id': uuid, 'rules.uuid': ruleId },
                { $set: { 'rules.$.status': KodyRulesStatus.DELETED } },
                { new: true },
            )
            .exec();
        return updated
            ? mapSimpleModelToEntity(updated, KodyRulesEntity)
            : null;
    }

    async updateRulesStatusByFilter(
        organizationId: string,
        repositoryId: string,
        directoryId?: string,
        newStatus: KodyRulesStatus = KodyRulesStatus.DELETED,
    ): Promise<KodyRulesEntity | null> {
        const filter: any = {
            organizationId,
            'rules.repositoryId': repositoryId,
        };

        if (directoryId) {
            filter['rules.directoryId'] = directoryId;
        }

        const updated = await this.kodyRulesModel
            .findOneAndUpdate(
                filter,
                {
                    $set: {
                        'rules.$[elem].status': newStatus,
                        'rules.$[elem].updatedAt': new Date(),
                    },
                },
                {
                    new: true,
                    arrayFilters: [
                        {
                            'elem.repositoryId': repositoryId,
                            ...(directoryId
                                ? { 'elem.directoryId': directoryId }
                                : {}),
                            'elem.status': { $ne: KodyRulesStatus.DELETED },
                        },
                    ],
                },
            )
            .exec();

        return updated
            ? mapSimpleModelToEntity(updated, KodyRulesEntity)
            : null;
    }
    //#endregion
}
