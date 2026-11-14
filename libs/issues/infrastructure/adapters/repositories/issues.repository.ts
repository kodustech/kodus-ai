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
    MarkScanFindingsSeenParams,
    OpenScanFinding,
    OpenScanFindingArea,
    ResolveUnseenScanFindingsParams,
    ScanRepositoryScope,
    ScanFindingOutcome,
    ScanFindingUpsert,
} from '@libs/issues/domain/contracts/issues.repository';
import { IssuesEntity } from '@libs/issues/domain/entities/issues.entity';
import { normalizeScanPath } from '@libs/issues/domain/scan-fingerprint';
import {
    IIssue,
    IIssueOwner,
    IssueSource,
} from '@libs/issues/domain/interfaces/issues.interface';
import { IContributingSuggestion } from '@libs/issues/domain/interfaces/kodyIssuesManagement.interface';

import { IssuesModel } from './schemas/issues.model';
import { LabelType } from '@libs/common/utils/codeManagement/labels';
import { SeverityLevel } from '@libs/common/utils/enums/severityLevel.enum';

/** Owner origins a security scan sets itself, and may update. */
const SCAN_OWNER_ORIGINS = new Set<string | undefined>([
    'codeowners',
    'last_author',
]);

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
        // A scan issue stores its path normalized; a review issue stores it as
        // the PR spelled it. Either spelling finds both.
        const raw = String(filePath ?? '');
        const spellings = [
            ...new Set([raw, raw ? normalizeScanPath(raw) : raw]),
        ];
        const issues = await this.issuesModel.find({
            'organizationId': organizationId,
            'repository.id': repositoryId,
            'filePath': { $in: spellings },
            'status': status ? status : { $ne: IssueStatus.OPEN },
        });

        return issues ? mapSimpleModelsToEntities(issues, IssuesEntity) : null;
    }

    async changedSince(organizationId: string, since: Date): Promise<boolean> {
        return !!(await this.issuesModel
            .exists({ organizationId, updatedAt: { $gt: since } })
            .exec());
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
            status === IssueStatus.RESOLVED
                ? { $set: { status, resolvedAt: new Date().toISOString() } }
                : { $set: { status }, $unset: { resolvedAt: '' } },
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
            status === IssueStatus.RESOLVED
                ? // Resolved always carries when, as the scan's own path does.
                  { $set: { status, resolvedAt: new Date().toISOString() } }
                : // Out of resolved (reopened by hand), it no longer has one.
                  { $set: { status }, $unset: { resolvedAt: '' } },
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
        organizationId: string,
    ): Promise<IssuesEntity | null> {
        // One conditional push per suggestion: two writers merging the same
        // PR (a redelivered webhook) cannot both add it. The organization is
        // in the filter: the id came from a model's answer.
        const seen = new Set<string>();
        for (const suggestion of suggestions) {
            if (!suggestion?.id || seen.has(suggestion.id)) {
                continue;
            }
            seen.add(suggestion.id);
            await this.issuesModel.updateOne(
                {
                    '_id': uuid,
                    organizationId,
                    'contributingSuggestions.id': { $ne: suggestion.id },
                },
                { $push: { contributingSuggestions: suggestion } },
            );
        }

        const doc = await this.issuesModel
            .findOne({ _id: uuid, organizationId })
            .exec();
        return doc ? mapSimpleModelToEntity(doc, IssuesEntity) : null;
    }

    async upsertScanFinding(
        finding: ScanFindingUpsert,
    ): Promise<{ issue: IssuesEntity; outcome: ScanFindingOutcome }> {
        const now = new Date().toISOString();
        const filter = {
            'organizationId': finding.organizationId,
            'repository.platform': finding.repository.platform,
            'repository.host': finding.repository.host ?? '',
            'repository.id': finding.repository.id,
            'fingerprint': finding.fingerprint,
        };

        // Each pass reads the finding and writes it in one step that lands
        // only if what was read still holds: another worker creating it, a
        // person dismissing or deleting it in between sends it round again.
        let existing = await this.issuesModel.findOne(filter).exec();
        // A duplicate key with nothing under the filter: another index, or
        // the winner deleted already. Retried, and thrown if it never clears.
        let collision: unknown;
        for (let attempt = 0; attempt < 3; attempt++) {
            if (!existing) {
                try {
                    const created = await this.issuesModel.create({
                        ...finding,
                        // Stored as the filter reads it.
                        repository: {
                            ...finding.repository,
                            host: finding.repository.host ?? '',
                        },
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
                    // Another worker wrote it first; the unique index turned
                    // the race into this error.
                    if (error?.code !== 11000) {
                        throw error;
                    }
                    existing = await this.issuesModel.findOne(filter).exec();
                    collision = existing ? undefined : error;
                    continue;
                }
            }

            const { update, outcome, guard } = this.scanSighting(
                existing,
                finding,
                now,
            );
            const doc = await this.issuesModel.findOneAndUpdate(
                { _id: existing._id, status: existing.status, ...guard },
                update,
                { new: true },
            );
            if (doc) {
                return {
                    issue: mapSimpleModelToEntity(doc, IssuesEntity),
                    outcome,
                };
            }
            existing = await this.issuesModel.findOne(filter).exec();
        }

        if (collision) {
            throw collision;
        }
        // It changed under every pass. Failing lets the scan store it again
        // when it runs again; a guessed outcome would leave the sighting
        // unrecorded.
        throw new Error('Scan finding kept changing while it was stored');
    }

    /** What one more sighting of a stored finding changes, given its status. */
    private scanSighting(
        existing: {
            status?: IssueStatus;
            owner?: IIssueOwner;
            lastSeenScanId?: string;
            description?: string;
            severity?: string;
            title?: string;
            startLine?: number;
            endLine?: number;
        },
        finding: ScanFindingUpsert,
        now: string,
    ): {
        update: Record<string, unknown>;
        outcome: ScanFindingOutcome;
        /** More of the read state the write must still find. */
        guard?: Record<string, unknown>;
    } {
        if (
            existing.status !== IssueStatus.DISMISSED &&
            existing.lastSeenScanId === finding.lastSeenScanId
        ) {
            // The same finding stored again by this scan (a unit run again
            // after a worker stopped between storing it and recording the
            // unit): already on the issue, not a second weakness.
            const occurrence = `### Also in this function: ${finding.title}\n\nLines ${finding.startLine}-${finding.endLine}.`;
            const sameAsFirst =
                existing.title === finding.title &&
                existing.startLine === finding.startLine &&
                existing.endLine === finding.endLine;
            if (
                existing.status === IssueStatus.OPEN &&
                (sameAsFirst ||
                    (existing.description ?? '').includes(occurrence))
            ) {
                return {
                    outcome: 'still_open',
                    update: { $set: { lastSeenAt: now } },
                };
            }
            // This scan already stored a finding under this identity: a
            // second weakness of the same kind in the same function. Both
            // stay on the one issue; neither overwrites the other. Resolved
            // since the first one was stored, it is plainly still there.
            const reopen = existing.status === IssueStatus.RESOLVED;
            return {
                outcome: 'merged',
                guard: { description: existing.description },
                update: {
                    ...(reopen ? { $unset: { resolvedAt: '' } } : {}),
                    $set: {
                        ...(reopen ? { status: IssueStatus.OPEN } : {}),
                        description: `${existing.description ?? ''}\n\n---\n\n${occurrence}\n\n${finding.description}`,
                        severity: moreSevere(
                            existing.severity,
                            finding.severity,
                        ),
                        lastSeenAt: now,
                    },
                },
            };
        }
        if (existing.status === IssueStatus.DISMISSED) {
            // Dismissed by a person: keep it dismissed, only record the sighting.
            return {
                outcome: 'dismissed',
                update: {
                    $set: {
                        lastSeenScanId: finding.lastSeenScanId,
                        lastSeenAt: now,
                    },
                },
            };
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
            lastSeenCommitSha: finding.lastSeenCommitSha,
            lastSeenAt: now,
            // An owner the scan decided (CODEOWNERS, last author) follows the
            // repository as it changes; one a person set is kept.
            ...(finding.owner &&
            (!existing.owner || SCAN_OWNER_ORIGINS.has(existing.owner.origin))
                ? { owner: finding.owner }
                : {}),
        };
        // Lands only while no other writer of this scan stored the identity
        // first: the loser goes round again, into the merge.
        const guard = { lastSeenScanId: existing.lastSeenScanId ?? null };
        if (existing.status === IssueStatus.RESOLVED) {
            refreshed.status = IssueStatus.OPEN;
            return {
                outcome: 'reopened',
                guard,
                update: { $set: refreshed, $unset: { resolvedAt: '' } },
            };
        }
        return { outcome: 'still_open', guard, update: { $set: refreshed } };
    }

    async findOpenScanFindingAreas(
        params: ScanRepositoryScope,
    ): Promise<OpenScanFindingArea[]> {
        const docs = await this.issuesModel
            .find(
                {
                    'organizationId': params.organizationId,
                    'repository.platform': params.repositoryPlatform,
                    'repository.host': params.repositoryHost,
                    'repository.id': params.repositoryId,
                    'source': IssueSource.SECURITY_SCAN,
                    'status': IssueStatus.OPEN,
                },
                { filePath: 1, vulnerabilityClass: 1 },
            )
            .lean()
            .exec();
        const areas = new Map<string, OpenScanFindingArea>();
        for (const doc of docs as Array<Partial<IIssue>>) {
            if (!doc.filePath || !doc.vulnerabilityClass) continue;
            const filePath = normalizeScanPath(doc.filePath);
            areas.set(`${filePath}\u0000${doc.vulnerabilityClass}`, {
                filePath,
                vulnerabilityClass: doc.vulnerabilityClass,
            });
        }
        return [...areas.values()];
    }

    async findOpenScanFindings(
        params: ScanRepositoryScope,
    ): Promise<OpenScanFinding[]> {
        const docs = await this.issuesModel
            .find(
                {
                    'organizationId': params.organizationId,
                    'repository.platform': params.repositoryPlatform,
                    'repository.host': params.repositoryHost,
                    'repository.id': params.repositoryId,
                    'source': IssueSource.SECURITY_SCAN,
                    'status': IssueStatus.OPEN,
                },
                {
                    'fingerprint': 1,
                    'filePath': 1,
                    'vulnerabilityClass': 1,
                    'title': 1,
                    'description': 1,
                    'severity': 1,
                    'cwe': 1,
                    'startLine': 1,
                    'endLine': 1,
                    'evidence.attackPath': 1,
                },
            )
            .lean()
            .exec();
        return (docs as Array<Partial<IIssue>>)
            .filter((d) => d.fingerprint && d.filePath && d.vulnerabilityClass)
            .map((d) => ({
                fingerprint: d.fingerprint,
                filePath: normalizeScanPath(d.filePath),
                vulnerabilityClass: d.vulnerabilityClass,
                title: d.title ?? '',
                description: d.description ?? '',
                severity: String(d.severity ?? ''),
                cwe: d.cwe,
                startLine: d.startLine ?? 1,
                endLine: d.endLine ?? d.startLine ?? 1,
                attackPath: d.evidence?.attackPath,
            }));
    }

    async markScanFindingsSeen(
        params: MarkScanFindingsSeenParams,
    ): Promise<{ sighted: number; reopened: number }> {
        if (!params.fingerprints.length) {
            return { sighted: 0, reopened: 0 };
        }
        const now = new Date().toISOString();
        const theseFindings = {
            'organizationId': params.organizationId,
            'repository.platform': params.repositoryPlatform,
            'repository.host': params.repositoryHost,
            'repository.id': params.repositoryId,
            'source': IssueSource.SECURITY_SCAN,
            'fingerprint': { $in: [...new Set(params.fingerprints)] },
        };
        // One this scan already sighted (stored it, or marked it before) is
        // not counted again.
        const sighted = await this.issuesModel.updateMany(
            {
                ...theseFindings,
                status: IssueStatus.OPEN,
                lastSeenScanId: { $ne: params.scanId },
            },
            { $set: { lastSeenScanId: params.scanId, lastSeenAt: now } },
        );
        // Found again after a scan resolved it: back open. A dismissed one
        // stays dismissed, as on a stored sighting.
        const reopened = params.foundAgain
            ? await this.issuesModel.updateMany(
                  { ...theseFindings, status: IssueStatus.RESOLVED },
                  {
                      $set: {
                          status: IssueStatus.OPEN,
                          lastSeenScanId: params.scanId,
                          lastSeenAt: now,
                      },
                      $unset: { resolvedAt: '' },
                  },
              )
            : undefined;
        return {
            sighted: sighted?.modifiedCount ?? 0,
            reopened: reopened?.modifiedCount ?? 0,
        };
    }

    async resolveUnseenScanFindings(
        params: ResolveUnseenScanFindingsParams,
    ): Promise<number> {
        const unseen = {
            'organizationId': params.organizationId,
            // The same id on another platform is another repository.
            'repository.platform': params.repositoryPlatform,
            'repository.host': params.repositoryHost,
            'repository.id': params.repositoryId,
            'source': IssueSource.SECURITY_SCAN,
            'status': IssueStatus.OPEN,
            'lastSeenScanId': { $ne: params.scanId },
            // Sighted by a newer scan that overlapped this one: not gone.
            'lastSeenAt': { $lt: params.scanStartedAt },
        };

        const where: Record<string, unknown>[] = params.examined
            .filter((e) => e.filePaths.length)
            .map((e) => ({
                vulnerabilityClass: e.vulnerabilityClass,
                filePath: { $in: e.filePaths.map(normalizeScanPath) },
            }));
        if (params.trackedFiles?.length) {
            const tracked = new Set(params.trackedFiles.map(normalizeScanPath));
            const open: string[] = await this.issuesModel
                .distinct('filePath', unseen)
                .exec();
            const gone = open.filter(
                (path) => !!path && !tracked.has(normalizeScanPath(path)),
            );
            if (gone.length) {
                where.push({ filePath: { $in: gone } });
            }
        }
        if (!where.length) {
            return 0;
        }

        const result = await this.issuesModel.updateMany(
            { ...unseen, $or: where },
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

const SEVERITY_RANK = new Map(
    ['low', 'medium', 'high', 'critical'].map((s, i) => [s, i] as const),
);

/** The worse of two severities; an unknown one ranks lowest. */
function moreSevere(a: string | undefined, b: string): string {
    return (SEVERITY_RANK.get(a ?? '') ?? -1) > (SEVERITY_RANK.get(b) ?? -1)
        ? (a as string)
        : b;
}
