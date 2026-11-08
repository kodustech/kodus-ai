import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { IssueStatus } from '@libs/core/infrastructure/config/types/general/issues.type';
import {
    mapSimpleModelsToEntities,
    mapSimpleModelToEntity,
} from '@libs/core/infrastructure/repositories/mappers';
import {
    IIssuesRepository,
    ResolveUnseenScanFindingsParams,
    ScanFindingOutcome,
    ScanFindingUpsert,
} from '@libs/issues/domain/contracts/issues.repository';
import { IssuesEntity } from '@libs/issues/domain/entities/issues.entity';
import { normalizeScanPath } from '@libs/issues/domain/scan-fingerprint';
import {
    IIssue,
    IssueSource,
} from '@libs/issues/domain/interfaces/issues.interface';
import { IContributingSuggestion } from '@libs/issues/domain/interfaces/kodyIssuesManagement.interface';

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
        // The mapper returns null for an empty list; callers expect an array.
        return mapSimpleModelsToEntities(docs, IssuesEntity) ?? [];
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
                'source': 1,
                'cwe': 1,
                'owner': 1,
            })
            .exec();
        return mapSimpleModelsToEntities(docs, IssuesEntity);
    }

    async count(filter?: Partial<IIssue>): Promise<number> {
        return await this.issuesModel.countDocuments(filter).exec();
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

    /**
     * Appends the PR suggestions a merge matched to this issue. It used to
     * `$addToSet` into `contributingSuggestionIds`, a field the schema never
     * declared, so strict mode dropped the write and every match was lost.
     */
    async addContributingSuggestions(
        uuid: string,
        suggestions: IContributingSuggestion[],
    ): Promise<IssuesEntity | null> {
        // One conditional push per suggestion: two writers merging the same
        // PR (a redelivered webhook) cannot both add it.
        const seen = new Set<string>();
        for (const suggestion of suggestions) {
            if (!suggestion?.id || seen.has(suggestion.id)) {
                continue;
            }
            seen.add(suggestion.id);
            await this.issuesModel.updateOne(
                {
                    '_id': uuid,
                    'contributingSuggestions.id': { $ne: suggestion.id },
                },
                { $push: { contributingSuggestions: suggestion } },
            );
        }

        const doc = await this.issuesModel.findById(uuid).exec();
        return doc ? mapSimpleModelToEntity(doc, IssuesEntity) : null;
    }

    async upsertScanFinding(
        finding: ScanFindingUpsert,
    ): Promise<{ issue: IssuesEntity; outcome: ScanFindingOutcome }> {
        const now = new Date().toISOString();
        const filter = {
            'organizationId': finding.organizationId,
            'repository.id': finding.repository.id,
            'fingerprint': finding.fingerprint,
        };

        let existing = await this.issuesModel.findOne(filter).exec();

        if (!existing) {
            try {
                const created = await this.issuesModel.create({
                    ...finding,
                    filePath: normalizeScanPath(finding.filePath),
                    source: IssueSource.SECURITY_SCAN,
                    status: IssueStatus.OPEN,
                    contributingSuggestions: [],
                    lastSeenAt: now,
                });
                return {
                    issue: mapSimpleModelToEntity(created, IssuesEntity),
                    outcome: 'created',
                };
            } catch (error) {
                // Another worker scanning the same repository wrote it first;
                // the unique index turned the race into this error.
                if (error?.code !== 11000) {
                    throw error;
                }
                existing = await this.issuesModel.findOne(filter).exec();
                if (!existing) {
                    throw error;
                }
            }
        }

        const refreshed: Partial<IIssue> = {
            filePath: normalizeScanPath(finding.filePath),
            title: finding.title,
            description: finding.description,
            severity: finding.severity,
            language: finding.language,
            cwe: finding.cwe,
            vulnerabilityClass: finding.vulnerabilityClass,
            symbol: finding.symbol,
            startLine: finding.startLine,
            endLine: finding.endLine,
            evidence: finding.evidence,
            lastSeenScanId: finding.lastSeenScanId,
            lastSeenAt: now,
            // A person may have reassigned it since; only fill a missing owner.
            ...(existing.owner ? {} : { owner: finding.owner }),
        };

        let outcome: ScanFindingOutcome = 'still_open';
        const update: Record<string, unknown> = { $set: refreshed };

        if (existing.status === IssueStatus.RESOLVED) {
            outcome = 'reopened';
            refreshed.status = IssueStatus.OPEN;
            update.$unset = { resolvedAt: '' };
        } else if (existing.status === IssueStatus.DISMISSED) {
            // Dismissed by a person: keep it dismissed, only record the sighting.
            outcome = 'dismissed';
            update.$set = {
                lastSeenScanId: finding.lastSeenScanId,
                lastSeenAt: now,
            };
        }

        const doc = await this.issuesModel.findByIdAndUpdate(
            existing._id,
            update,
            { new: true },
        );

        return {
            issue: mapSimpleModelToEntity(doc ?? existing, IssuesEntity),
            outcome,
        };
    }

    async resolveUnseenScanFindings(
        params: ResolveUnseenScanFindingsParams,
    ): Promise<number> {
        if (!params.filePaths.length) {
            return 0;
        }

        const result = await this.issuesModel.updateMany(
            {
                'organizationId': params.organizationId,
                'repository.id': params.repositoryId,
                'source': IssueSource.SECURITY_SCAN,
                'status': IssueStatus.OPEN,
                'filePath': { $in: params.filePaths.map(normalizeScanPath) },
                'lastSeenScanId': { $ne: params.scanId },
                // Sighted by a newer scan that overlapped this one: not gone.
                'lastSeenAt': { $lt: params.scanStartedAt },
            },
            {
                $set: {
                    status: IssueStatus.RESOLVED,
                    resolvedAt: new Date().toISOString(),
                },
            },
        );

        return result?.modifiedCount ?? 0;
    }
}
