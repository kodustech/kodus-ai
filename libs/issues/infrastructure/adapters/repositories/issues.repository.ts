import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { IssueStatus } from '@libs/core/infrastructure/config/types/general/issues.type';
import {
    mapSimpleModelsToEntities,
    mapSimpleModelToEntity,
} from '@libs/core/infrastructure/repositories/mappers';
import {
    AddScanOccurrenceParams,
    FoldScanIssueParams,
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
    IIssueOccurrence,
    IIssueOwner,
    IssueSource,
} from '@libs/issues/domain/interfaces/issues.interface';
import { IContributingSuggestion } from '@libs/issues/domain/interfaces/kodyIssuesManagement.interface';

import { MONGO_QUERY_MAX_TIME_MS } from '@libs/core/infrastructure/database/mongo/query-timeout';

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
                'source': 1,
                'cwe': 1,
                'owner': 1,
            })
            .exec();
        return mapSimpleModelsToEntities(docs, IssuesEntity);
    }

    async count(filter?: Partial<IIssue>): Promise<number> {
        return await this.issuesModel
            .countDocuments(filter)
            .maxTimeMS(MONGO_QUERY_MAX_TIME_MS)
            .exec();
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
                : {
                      $set: { status, consecutiveScanMisses: 0 },
                      $unset: { resolvedAt: '' },
                  },
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
                  {
                      $set: { status, consecutiveScanMisses: 0 },
                      $unset: { resolvedAt: '' },
                  },
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
        // A place already folded into another issue (its own issue folded
        // as a duplicate, or recorded as an occurrence there) is that issue
        // found again, never an issue of its own.
        const scope = {
            organizationId: finding.organizationId,
            repositoryPlatform: finding.repository.platform,
            repositoryHost: finding.repository.host ?? '',
            repositoryId: finding.repository.id,
        };
        // Followed only while the issue stays dismissed as a duplicate: one a
        // person reopened is its own issue again, sighted on its own.
        const holder =
            (existing?.status === IssueStatus.DISMISSED
                ? existing.duplicateOf
                : undefined) ??
            (existing
                ? undefined
                : (
                      await this.issuesModel
                          .findOne(
                              {
                                  ...filter,
                                  fingerprint: { $ne: finding.fingerprint },
                                  fingerprintAliases: finding.fingerprint,
                                  source: IssueSource.SECURITY_SCAN,
                              },
                              { fingerprint: 1 },
                          )
                          .exec()
                  )?.fingerprint);
        if (holder && holder !== finding.fingerprint) {
            const folded = await this.addScanFindingOccurrence({
                ...scope,
                holderFingerprint: holder,
                occurrence: occurrenceOfUpsert(finding),
                scanId: finding.lastSeenScanId,
            });
            if (folded) {
                return folded;
            }
        }
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
                        ownSeverity: finding.severity,
                        source: IssueSource.SECURITY_SCAN,
                        status: IssueStatus.OPEN,
                        contributingSuggestions: [],
                        lastSeenAt: now,
                        consecutiveScanMisses: 0,
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
            ownSeverity?: string;
            title?: string;
            startLine?: number;
            endLine?: number;
            occurrences?: IIssueOccurrence[];
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
                    update: {
                        $set: { lastSeenAt: now, consecutiveScanMisses: 0 },
                    },
                };
            }
            // This scan already stored a finding under this identity: a
            // second weakness of the same kind in the same function. Both
            // stay on the one issue; neither overwrites the other. Resolved
            // since the first one was stored, it is plainly still there.
            const reopen = existing.status === IssueStatus.RESOLVED;
            return {
                outcome: 'merged',
                guard: {
                    description: existing.description,
                    ...sameOccurrences(existing),
                },
                update: {
                    ...(reopen ? { $unset: { resolvedAt: '' } } : {}),
                    $set: {
                        ...(reopen ? { status: IssueStatus.OPEN } : {}),
                        description: `${existing.description ?? ''}\n\n---\n\n${occurrence}\n\n${finding.description}`,
                        severity: moreSevere(
                            existing.severity,
                            finding.severity,
                        ),
                        // Both weaknesses are the issue's own place.
                        ownSeverity: moreSevere(
                            existing.ownSeverity ?? existing.severity,
                            finding.severity,
                        ),
                        lastSeenAt: now,
                        consecutiveScanMisses: 0,
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
                        consecutiveScanMisses: 0,
                    },
                },
            };
        }
        const refreshed: Partial<IIssue> = {
            filePath: normalizeScanPath(finding.filePath),
            title: finding.title,
            description: finding.description,
            // As severe as its worst place: its own sighting does not undo
            // the severity of a place folded into it.
            severity: (existing.occurrences ?? []).reduce<string>(
                (worst, o) => moreSevere(worst, o.severity ?? ''),
                finding.severity,
            ) as SeverityLevel,
            ownSeverity: finding.severity,
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
            consecutiveScanMisses: 0,
            // An owner the scan decided (CODEOWNERS, last author) follows the
            // repository as it changes; one a person set is kept.
            ...(finding.owner &&
            (!existing.owner || SCAN_OWNER_ORIGINS.has(existing.owner.origin))
                ? { owner: finding.owner }
                : {}),
        };
        // Lands only while no other writer of this scan stored the identity
        // first: the loser goes round again, into the merge.
        // Nor while a place was added: the severity is worked out from them.
        const guard = {
            lastSeenScanId: existing.lastSeenScanId ?? null,
            ...sameOccurrences(existing),
        };
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

    async addScanFindingOccurrence(
        params: AddScanOccurrenceParams,
    ): Promise<{ issue: IssuesEntity; outcome: ScanFindingOutcome } | null> {
        const scope = scanScope(params);
        let target = params.holderFingerprint;
        for (let attempt = 0; attempt < 4; attempt++) {
            const holder = await this.issuesModel
                .findOne({ ...scope, fingerprint: target })
                .lean()
                .exec();
            if (!holder) {
                return null;
            }
            // Folded into another issue since: the place goes there.
            if (holder.duplicateOf && holder.duplicateOf !== target) {
                target = holder.duplicateOf;
                continue;
            }
            const now = new Date().toISOString();
            const update = withOccurrence(holder, {
                ...params.occurrence,
                lastSeenScanId: params.scanId,
                lastSeenAt: now,
            });
            const dismissed = holder.status === IssueStatus.DISMISSED;
            const reopen = holder.status === IssueStatus.RESOLVED;
            const doc = await this.issuesModel.findOneAndUpdate(
                {
                    _id: holder._id,
                    status: holder.status,
                    occurrences: holder.occurrences ?? { $exists: false },
                    ...sameSeverity(holder),
                },
                {
                    $set: {
                        ...update,
                        // Seen through this place: not resolved as unseen.
                        lastSeenScanId: params.scanId,
                        lastSeenAt: now,
                        consecutiveScanMisses: 0,
                        ...(dismissed ? { severity: holder.severity } : {}),
                        ...(reopen ? { status: IssueStatus.OPEN } : {}),
                    },
                    ...(reopen ? { $unset: { resolvedAt: '' } } : {}),
                },
                { new: true },
            );
            if (doc) {
                return {
                    issue: mapSimpleModelToEntity(doc, IssuesEntity),
                    outcome: dismissed
                        ? 'dismissed'
                        : reopen
                          ? 'reopened'
                          : 'merged',
                };
            }
        }
        throw new Error(
            'Scan finding occurrence kept changing while it was stored',
        );
    }

    async foldScanIssueInto(params: FoldScanIssueParams): Promise<boolean> {
        const scope = scanScope(params);
        if (params.fingerprint === params.into) {
            return false;
        }
        const [folded, holder] = await Promise.all([
            this.issuesModel
                .findOne({
                    ...scope,
                    fingerprint: params.fingerprint,
                    status: IssueStatus.OPEN,
                })
                .lean()
                .exec(),
            this.issuesModel
                .findOne({ ...scope, fingerprint: params.into })
                .lean()
                .exec(),
        ]);
        if (!folded || !holder || holder.duplicateOf) {
            return false;
        }
        // The folded issue's place and the places it already held.
        const places: IIssueOccurrence[] = [
            {
                fingerprint: folded.fingerprint,
                title: folded.title,
                cwe: folded.cwe,
                filePath: folded.filePath,
                startLine: folded.startLine ?? 1,
                endLine: folded.endLine ?? folded.startLine ?? 1,
                symbol: folded.symbol,
                // Its own: its places come along on their own, with theirs.
                severity: String(folded.ownSeverity ?? folded.severity ?? ''),
                vulnerabilityClass: folded.vulnerabilityClass,
                lastSeenScanId: folded.lastSeenScanId,
                lastSeenAt: folded.lastSeenAt,
            },
            ...(folded.occurrences ?? []),
        ];
        let update: Record<string, unknown> = {};
        let state: Partial<IIssue> = holder;
        for (const place of places) {
            // Merged: the own severity only the first place sets is kept.
            update = { ...update, ...withOccurrence(state, place) };
            state = { ...state, ...update } as Partial<IIssue>;
        }
        const moved = await this.issuesModel.updateOne(
            {
                _id: holder._id,
                occurrences: holder.occurrences ?? { $exists: false },
                ...sameSeverity(holder),
            },
            { $set: update },
        );
        // Matched is enough: a holder that already lists these places (an
        // earlier attempt that stopped before the dismissal) changes nothing.
        if (!moved?.matchedCount) {
            return false;
        }
        const dismissed = await this.issuesModel.updateOne(
            { _id: folded._id, status: IssueStatus.OPEN },
            {
                $set: {
                    status: IssueStatus.DISMISSED,
                    duplicateOf: holder.fingerprint,
                    consolidatedAt: new Date().toISOString(),
                },
            },
        );
        return (dismissed?.modifiedCount ?? 0) > 0;
    }

    async markScanIssuesConsolidated(
        params: ScanRepositoryScope & { fingerprints: string[]; at: string },
    ): Promise<void> {
        if (!params.fingerprints.length) {
            return;
        }
        await this.issuesModel.updateMany(
            {
                ...scanScope(params),
                fingerprint: { $in: [...new Set(params.fingerprints)] },
            },
            { $set: { consolidatedAt: params.at } },
        );
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
                    'symbol': 1,
                    'fingerprintAliases': 1,
                    'consolidatedAt': 1,
                    'lastSeenAt': 1,
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
                symbol: d.symbol,
                fingerprintAliases: d.fingerprintAliases,
                consolidatedAt: d.consolidatedAt,
                lastSeenAt: d.lastSeenAt,
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
            {
                $set: {
                    lastSeenScanId: params.scanId,
                    lastSeenAt: now,
                    consecutiveScanMisses: 0,
                },
            },
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
                          consecutiveScanMisses: 0,
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
            'lastMissedScanId': { $ne: params.scanId },
        };

        // Places first: an issue resolves only once it holds none (one fix,
        // one issue: a place still there is the root cause still there).
        await this.pruneUnseenOccurrences(params);
        const holdsNoPlace = { 'occurrences.0': { $exists: false } };

        let resolved = 0;
        if (params.trackedFiles?.length) {
            const tracked = new Set(params.trackedFiles.map(normalizeScanPath));
            const open: string[] = await this.issuesModel
                .distinct('filePath', unseen)
                .exec();
            const gone = open.filter(
                (path) => !!path && !tracked.has(normalizeScanPath(path)),
            );
            // A file that left the branch is not a model miss: what it held
            // is gone with it, on this scan.
            if (gone.length) {
                const result = await this.issuesModel.updateMany(
                    { ...unseen, ...holdsNoPlace, filePath: { $in: gone } },
                    {
                        $set: {
                            status: IssueStatus.RESOLVED,
                            resolvedAt: new Date().toISOString(),
                            lastMissedScanId: params.scanId,
                        },
                        $inc: { consecutiveScanMisses: 1 },
                    },
                );
                resolved += result?.modifiedCount ?? 0;
            }
        }

        const where: Record<string, unknown>[] = params.examined
            .filter((e) => e.filePaths.length)
            .map((e) => ({
                vulnerabilityClass: e.vulnerabilityClass,
                filePath: { $in: e.filePaths.map(normalizeScanPath) },
            }));
        if (!where.length) {
            return resolved;
        }

        // A single model miss is not a fix. Two distinct completed scans
        // must miss it in an examined area; a replay cannot add another miss.
        const result = await this.issuesModel.updateMany(
            {
                ...unseen,
                ...holdsNoPlace,
                $or: where,
                consecutiveScanMisses: { $gte: 1 },
            },
            {
                $set: {
                    status: IssueStatus.RESOLVED,
                    resolvedAt: new Date().toISOString(),
                    lastMissedScanId: params.scanId,
                },
                $inc: { consecutiveScanMisses: 1 },
            },
        );
        await this.issuesModel.updateMany(
            {
                ...unseen,
                $or: where,
                $and: [
                    {
                        $or: [
                            { consecutiveScanMisses: { $exists: false } },
                            { consecutiveScanMisses: 0 },
                        ],
                    },
                ],
            },
            {
                $set: {
                    consecutiveScanMisses: 1,
                    lastMissedScanId: params.scanId,
                },
            },
        );

        return resolved + (result?.modifiedCount ?? 0);
    }

    /**
     * Drops from open issues the places this scan shows are gone: a place
     * whose file left the branch, and a place of a class this scan read in
     * its file without finding it again. Found again later, it comes back as
     * an occurrence; its alias keeps routing it to the same issue.
     */
    private async pruneUnseenOccurrences(
        params: ResolveUnseenScanFindingsParams,
    ): Promise<void> {
        const scope = {
            ...scanScope(params),
            status: IssueStatus.OPEN,
            occurrences: { $exists: true, $ne: [] },
        };
        // A place a scan that overlapped this one saw after it started is not
        // gone (a place stored before sightings were timed has no time).
        const seenBefore = {
            lastSeenAt: { $not: { $gte: params.scanStartedAt } },
        };
        const seenBeforeExpr = {
            $not: [{ $gte: ['$$o.lastSeenAt', params.scanStartedAt] }],
        };
        if (params.trackedFiles?.length) {
            const tracked = new Set(params.trackedFiles.map(normalizeScanPath));
            // Streamed: the repository's places, one path at a time.
            const gone: string[] = [];
            const places = this.issuesModel
                .aggregate<{ _id: string }>([
                    { $match: scope },
                    { $unwind: '$occurrences' },
                    { $group: { _id: '$occurrences.filePath' } },
                ])
                .allowDiskUse(true)
                .cursor();
            for await (const { _id: path } of places) {
                if (path && !tracked.has(normalizeScanPath(path))) {
                    gone.push(path);
                }
            }
            if (gone.length) {
                await this.issuesModel.updateMany(
                    {
                        ...scope,
                        occurrences: {
                            $elemMatch: {
                                filePath: { $in: gone },
                                ...seenBefore,
                            },
                        },
                    },
                    withoutPlaces({
                        $and: [{ $in: ['$$o.filePath', gone] }, seenBeforeExpr],
                    }),
                    { updatePipeline: true },
                );
            }
        }
        for (const area of params.examined) {
            if (!area.filePaths.length) continue;
            const filePaths = area.filePaths.map(normalizeScanPath);
            await this.issuesModel.updateMany(
                {
                    ...scope,
                    occurrences: {
                        $elemMatch: {
                            vulnerabilityClass: area.vulnerabilityClass,
                            filePath: { $in: filePaths },
                            lastSeenScanId: { $ne: params.scanId },
                            ...seenBefore,
                        },
                    },
                },
                withoutPlaces({
                    $and: [
                        {
                            $eq: [
                                '$$o.vulnerabilityClass',
                                area.vulnerabilityClass,
                            ],
                        },
                        { $in: ['$$o.filePath', filePaths] },
                        { $ne: ['$$o.lastSeenScanId', params.scanId] },
                        seenBeforeExpr,
                    ],
                }),
                { updatePipeline: true },
            );
        }
    }
}

/** One repository's scan issues, as every scan query reads them. */
function scanScope(params: ScanRepositoryScope) {
    return {
        'organizationId': params.organizationId,
        'repository.platform': params.repositoryPlatform,
        'repository.host': params.repositoryHost,
        'repository.id': params.repositoryId,
        'source': IssueSource.SECURITY_SCAN,
    };
}

/** The issue's places as read: a write that must not race a new place. */
function sameOccurrences(issue: { occurrences?: IIssueOccurrence[] }) {
    return {
        occurrences: issue.occurrences?.length
            ? issue.occurrences
            : { $in: [null, []] },
    };
}

/**
 * The issue's severities as read: a write that works them out from them must
 * not land over a sighting that changed them in between.
 */
function sameSeverity(issue: { severity?: string; ownSeverity?: string }) {
    return {
        severity: issue.severity ?? { $exists: false },
        ownSeverity: issue.ownSeverity ?? { $exists: false },
    };
}

/** The most places one issue lists; the oldest go first. */
const MAX_OCCURRENCES = 50;

/**
 * An issue's occurrences and aliases with one more place: the same place
 * replaced, not listed twice, and the issue as severe as its worst place.
 */
function withOccurrence(
    issue: Partial<IIssue>,
    place: IIssueOccurrence,
): Pick<
    IIssue,
    'occurrences' | 'fingerprintAliases' | 'severity' | 'ownSeverity'
> {
    const own = place.fingerprint === issue.fingerprint;
    return {
        // An issue stored before its own severity was kept holds no place
        // yet, so its severity is still its own: kept before it is raised.
        ...(issue.ownSeverity ? {} : { ownSeverity: issue.severity }),
        occurrences: own
            ? (issue.occurrences ?? [])
            : [
                  ...(issue.occurrences ?? []).filter(
                      (o) => o.fingerprint !== place.fingerprint,
                  ),
                  place,
              ].slice(-MAX_OCCURRENCES),
        fingerprintAliases: own
            ? (issue.fingerprintAliases ?? [])
            : [
                  ...new Set([
                      ...(issue.fingerprintAliases ?? []),
                      place.fingerprint,
                  ]),
              ],
        severity: moreSevere(
            issue.severity,
            place.severity ?? '',
        ) as SeverityLevel,
    };
}

function occurrenceOfUpsert(finding: ScanFindingUpsert): IIssueOccurrence {
    return {
        fingerprint: finding.fingerprint,
        title: finding.title,
        cwe: finding.cwe,
        filePath: normalizeScanPath(finding.filePath),
        startLine: finding.startLine ?? 1,
        endLine: finding.endLine ?? finding.startLine ?? 1,
        symbol: finding.symbol,
        severity: finding.severity,
        vulnerabilityClass: finding.vulnerabilityClass,
    };
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

/**
 * An update that drops the places `drop` matches (`$$o` is the place) and,
 * when one went, sets the issue's severity back to the worst of its own and
 * the places it keeps: a place that leaves takes its severity with it. An
 * issue stored before its own severity was kept stays as it is.
 */
function withoutPlaces(drop: Record<string, unknown>) {
    const ranks = [...SEVERITY_RANK.keys()];
    const kept = {
        $filter: { input: '$occurrences', as: 'o', cond: { $not: [drop] } },
    };
    const worst = {
        $max: {
            $map: {
                input: { $concatArrays: [['$ownSeverity'], '$$kept.severity'] },
                as: 's',
                in: { $indexOfArray: [ranks, '$$s'] },
            },
        },
    };
    return [
        {
            $set: {
                occurrences: kept,
                severity: {
                    $let: {
                        vars: { kept },
                        in: {
                            $cond: [
                                { $eq: [{ $type: '$ownSeverity' }, 'missing'] },
                                '$severity',
                                {
                                    $let: {
                                        vars: { rank: worst },
                                        in: {
                                            $cond: [
                                                { $gte: ['$$rank', 0] },
                                                {
                                                    $arrayElemAt: [
                                                        ranks,
                                                        '$$rank',
                                                    ],
                                                },
                                                '$ownSeverity',
                                            ],
                                        },
                                    },
                                },
                            ],
                        },
                    },
                },
            },
        },
    ];
}
