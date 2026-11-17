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
    IKodyRuleIndexEntry,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';
import { KodyRulesModel } from '@libs/kodyRules/infrastructure/adapters/repositories/schemas/kodyRules.model';
import { KodyRulesValidationService } from '../service/kody-rules-validation.service';

/**
 * Field-level $set (`rules.$.field`) instead of replacing the whole matched
 * element (`rules.$`). Replacing the element means a caller that passes a
 * Partial silently wipes every field it omitted. Per-field $set also narrows
 * the concurrency window: two edits touching DIFFERENT fields of the same
 * rule no longer clobber each other (only same-field edits race,
 * last-write-wins, which is expected). Undefined fields are skipped, `null`
 * is written. Null when nothing is left to set (Mongo rejects an empty $set).
 */
function ruleFieldSet(
    updateData: Partial<IKodyRule>,
): Record<string, unknown> | null {
    const setFields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(updateData)) {
        if (value !== undefined) {
            setFields[`rules.$.${key}`] = value;
        }
    }
    return Object.keys(setFields).length > 0 ? setFields : null;
}

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
    async findById(
        uuid: string,
        organizationId: string,
    ): Promise<IKodyRule | null> {
        const pipeline = [
            {
                $match: {
                    'rules.uuid': uuid,
                    organizationId,
                },
            },
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

    async findRulesIndex(
        organizationId: string,
    ): Promise<IKodyRuleIndexEntry[]> {
        // Project inside MongoDB: the embedded rules array carries each
        // rule's body, examples and compiled detector, and a picker only
        // needs the title and where the rule lives. Uses the organizationId
        // index from kodyRules.model.ts.
        const pipeline: PipelineStage[] = [
            { $match: { organizationId } },
            { $unwind: '$rules' },
            {
                $project: {
                    _id: 0,
                    uuid: '$rules.uuid',
                    title: '$rules.title',
                    repositoryId: '$rules.repositoryId',
                    directoryId: '$rules.directoryId',
                    type: '$rules.type',
                    status: '$rules.status',
                },
            },
        ];

        return this.kodyRulesModel
            .aggregate<IKodyRuleIndexEntry>(pipeline)
            .exec();
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
        const pipeline: PipelineStage[] = [{ $match: { organizationId } }];
        if (status) {
            pipeline.push({
                $project: {
                    total: {
                        $size: {
                            $filter: {
                                input: { $ifNull: ['$rules', []] },
                                as: 'rule',
                                cond: { $eq: ['$$rule.status', status] },
                            },
                        },
                    },
                },
            });
        } else {
            pipeline.push({
                $project: { total: { $size: { $ifNull: ['$rules', []] } } },
            });
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
        const setFields = ruleFieldSet(updateData);

        // Nothing concrete to set (all-undefined patch) — avoid an empty $set,
        // which Mongo rejects. Return the current doc unchanged.
        if (!setFields) {
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

    /**
     * Same field-level `$set` as `updateRule`, addressed by organization and
     * rule id, and returning only the touched rule.
     *
     * Why not findByOrganizationId + updateRule: that pair loads the
     * organization's whole document (every rule) to find one rule, then
     * `{ new: true }` deserializes the whole document a second time. For an
     * organization with hundreds of rules, a sync that touches each rule paid
     * that per rule, synchronously, on the worker event loop. The
     * `rules.uuid` index serves this filter; the `$elemMatch` projection
     * brings back the one rule.
     */
    async updateRuleFieldsByOrganization(
        organizationId: string,
        ruleId: string,
        updateData: Partial<IKodyRule>,
    ): Promise<Partial<IKodyRule> | null> {
        const setFields = ruleFieldSet(updateData);
        const filter = { organizationId, 'rules.uuid': ruleId };
        const projection = { rules: { $elemMatch: { uuid: ruleId } } };

        // All-undefined patch: Mongo rejects an empty $set, so read instead.
        const doc = !setFields
            ? await this.kodyRulesModel
                  .findOne(filter, projection)
                  .lean()
                  .exec()
            : await this.kodyRulesModel
                  .findOneAndUpdate(
                      filter,
                      { $set: setFields },
                      { new: true, projection },
                  )
                  .lean()
                  .exec();

        const rule = (doc as { rules?: Partial<IKodyRule>[] } | null)
            ?.rules?.[0];
        if (!rule) {
            return null;
        }
        // Same normalization the entity applies when a caller reads
        // `entity.rules` (scope defaults to FILE).
        return KodyRulesEntity.create({
            organizationId,
            rules: [rule],
        } as IKodyRules).rules[0];
    }

    async existsForOrganization(organizationId: string): Promise<boolean> {
        const found = await this.kodyRulesModel
            .exists({ organizationId })
            .exec();
        return !!found;
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

    async markAutoPausesDigested(
        organizationId: string,
        ruleId: string,
        pausedAts: Date[],
        digestedAt: Date,
    ): Promise<boolean> {
        const result = await this.kodyRulesModel
            .updateOne(
                { organizationId },
                {
                    $set: {
                        'rules.$[current].autoPause.digestedAt': digestedAt,
                        'rules.$[previous].lastAutoPause.digestedAt':
                            digestedAt,
                    },
                },
                {
                    arrayFilters: [
                        {
                            'current.uuid': ruleId,
                            'current.autoPause.pausedAt': { $in: pausedAts },
                        },
                        {
                            'previous.uuid': ruleId,
                            'previous.lastAutoPause.pausedAt': {
                                $in: pausedAts,
                            },
                        },
                    ],
                },
            )
            .exec();
        return result.modifiedCount > 0;
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
