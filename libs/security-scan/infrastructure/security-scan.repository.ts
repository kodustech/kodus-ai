import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import {
    ScanReportedFinding,
    ScanUnitProgress,
    SecurityScanRecord,
    SecurityScanStatus,
} from '../domain/security-scan.types';

import { SecurityScanModel } from './security-scan.model';

export const SECURITY_SCAN_REPOSITORY_TOKEN = Symbol.for(
    'SecurityScanRepository',
);

export type NewSecurityScan = Omit<
    SecurityScanRecord,
    'uuid' | 'createdAt' | 'updatedAt'
>;

export interface ISecurityScanRepository {
    create(scan: NewSecurityScan): Promise<SecurityScanRecord>;
    findById(uuid: string): Promise<SecurityScanRecord | null>;
    /**
     * `appendReported` is pushed onto `reported` in the same write. With a
     * `guard`, the write lands only while it holds (null otherwise): a status
     * change never overwrites one another process made in between, and a job
     * that lost the scan (timed out, its claim taken) writes nothing.
     */
    update(
        uuid: string,
        changes: Partial<NewSecurityScan>,
        appendReported?: ScanReportedFinding[],
        guard?: ScanWriteGuard,
    ): Promise<SecurityScanRecord | null>;
    /**
     * Makes `jobId` the one job running the scan while it is active and no
     * other job holds a live claim. Null when it cannot.
     */
    claim(
        uuid: string,
        jobId: string,
        leaseMs: number,
    ): Promise<SecurityScanRecord | null>;
    /**
     * Records one area's progress in place of its earlier entry (a pending
     * one is removed), without reading or rewriting the rest of the scan.
     */
    recordUnit(
        uuid: string,
        progress: ScanUnitProgress,
        changes: Partial<NewSecurityScan>,
        appendReported?: ScanReportedFinding[],
        /** Lands only while this job holds the scan. */
        ownedBy?: string,
    ): Promise<void>;
    findRecent(
        organizationId: string,
        repositoryIds: string[] | undefined,
        limit: number,
    ): Promise<SecurityScanRecord[]>;
    /** A scan of this repository that has not finished yet, if any. */
    findActive(
        organizationId: string,
        repository: ScanRepositoryKey,
    ): Promise<SecurityScanRecord | null>;
    /** The repository's last scan, with its plan, progress and findings. */
    findLatest(
        organizationId: string,
        repository: ScanRepositoryKey,
    ): Promise<SecurityScanRecord | null>;
    /**
     * Marks as failed the organization's scans nothing has touched for their
     * state's window: the worker running them stopped, or the job waiting for
     * one was lost. Returns how many.
     */
    failStale(organizationId: string, after: StaleScanWindows): Promise<number>;
}

export type ScanWriteGuard = {
    /** The states the scan must be in. */
    statuses?: SecurityScanStatus[];
    /** The job that must hold the scan. */
    ownedBy?: string;
    /** With `ownedBy`: a scan no job holds counts too. */
    orUnowned?: boolean;
};

function guardFilter(guard?: ScanWriteGuard): Record<string, unknown> {
    if (!guard) return {};
    return {
        ...(guard.statuses ? { status: { $in: guard.statuses } } : {}),
        ...(guard.ownedBy
            ? guard.orUnowned
                ? {
                      $or: [
                          { runningJobId: guard.ownedBy },
                          { runningJobId: { $exists: false } },
                          { runningJobId: null },
                      ],
                  }
                : { runningJobId: guard.ownedBy }
            : {}),
    };
}

export type StaleScanWindows = {
    /** A running scan writes after every unit. */
    runningMs: number;
    /** A queued scan waits for a worker, as long as the queue's backlog. */
    queuedMs: number;
};

const ACTIVE = [SecurityScanStatus.QUEUED, SecurityScanStatus.RUNNING];

/**
 * A repository within an organization: its platform and its id there. An id
 * is only unique on its platform, and one organization can hold a GitHub
 * repository and a GitLab project with the same one.
 */
export type ScanRepositoryKey = { platform: string; id: string };

const activeKeyOf = (organizationId: string, repository: ScanRepositoryKey) =>
    `${organizationId}:${repository.platform}:${repository.id}`;

const sameRepository = (repository: ScanRepositoryKey) => ({
    'repository.platform': repository.platform,
    'repository.id': repository.id,
});

export const STALE_SCAN_ERROR =
    'Interrupted: the worker running this scan stopped. Its findings so far are kept; run the scan again to cover the rest.';

@Injectable()
export class SecurityScanRepository implements ISecurityScanRepository {
    constructor(
        @InjectModel(SecurityScanModel.name)
        private readonly model: Model<SecurityScanModel>,
    ) {}

    /** Throws a duplicate-key error (11000) while the repository has an active scan. */
    async create(scan: NewSecurityScan): Promise<SecurityScanRecord> {
        const doc = await this.model.create({
            ...scan,
            ...(ACTIVE.includes(scan.status)
                ? {
                      activeKey: activeKeyOf(
                          scan.organizationId,
                          scan.repository,
                      ),
                  }
                : {}),
        });
        return toRecord(doc);
    }

    async findById(uuid: string): Promise<SecurityScanRecord | null> {
        const doc = await this.model.findById(uuid).exec();
        return doc ? toRecord(doc) : null;
    }

    async update(
        uuid: string,
        changes: Partial<NewSecurityScan>,
        appendReported?: ScanReportedFinding[],
        guard?: ScanWriteGuard,
    ): Promise<SecurityScanRecord | null> {
        const ended = changes.status && !ACTIVE.includes(changes.status);
        // Ended, or queued for its next job: no job holds it any more.
        const released =
            !!changes.status && changes.status !== SecurityScanStatus.RUNNING;
        const doc = await this.model
            .findOneAndUpdate(
                { _id: uuid, ...guardFilter(guard) },
                {
                    $set: changes,
                    ...(ended || released
                        ? {
                              $unset: {
                                  ...(ended ? { activeKey: '' } : {}),
                                  ...(released
                                      ? { runningJobId: '', leaseExpiresAt: '' }
                                      : {}),
                              },
                          }
                        : {}),
                    ...(appendReported?.length
                        ? { $push: { reported: { $each: appendReported } } }
                        : {}),
                },
                { new: true },
            )
            .exec();
        return doc ? toRecord(doc) : null;
    }

    async claim(
        uuid: string,
        jobId: string,
        leaseMs: number,
    ): Promise<SecurityScanRecord | null> {
        const now = new Date();
        const doc = await this.model
            .findOneAndUpdate(
                {
                    _id: uuid,
                    status: { $in: ACTIVE },
                    $or: [
                        { runningJobId: { $exists: false } },
                        { runningJobId: null },
                        { runningJobId: jobId },
                        { leaseExpiresAt: { $lt: now } },
                    ],
                },
                {
                    $set: {
                        status: SecurityScanStatus.RUNNING,
                        runningJobId: jobId,
                        leaseExpiresAt: new Date(now.getTime() + leaseMs),
                    },
                },
                { new: true },
            )
            .exec();
        return doc ? toRecord(doc) : null;
    }

    async recordUnit(
        uuid: string,
        progress: ScanUnitProgress,
        changes: Partial<NewSecurityScan>,
        appendReported?: ScanReportedFinding[],
        ownedBy?: string,
    ): Promise<void> {
        const owned = ownedBy ? { runningJobId: ownedBy } : {};
        const reported = appendReported?.length
            ? { reported: { $each: appendReported } }
            : undefined;
        if (progress.state === 'pending') {
            await this.model
                .updateOne(
                    { _id: uuid, ...owned },
                    {
                        $set: changes,
                        $pull: { progress: { unitId: progress.unitId } },
                        ...(reported ? { $push: reported } : {}),
                    },
                )
                .exec();
            return;
        }
        // Appended only while the area has no entry, in the same write as the
        // check; an area recorded before is replaced in place.
        const appended = await this.model
            .updateOne(
                {
                    '_id': uuid,
                    'progress.unitId': { $ne: progress.unitId },
                    ...owned,
                },
                { $set: changes, $push: { progress, ...reported } },
            )
            .exec();
        if (appended.matchedCount) {
            return;
        }
        await this.model
            .updateOne(
                { '_id': uuid, 'progress.unitId': progress.unitId, ...owned },
                {
                    $set: { ...changes, 'progress.$': progress },
                    ...(reported ? { $push: reported } : {}),
                },
            )
            .exec();
    }

    async findRecent(
        organizationId: string,
        repositoryIds: string[] | undefined,
        limit: number,
    ): Promise<SecurityScanRecord[]> {
        const docs = await this.model
            .find({
                organizationId,
                ...(repositoryIds
                    ? { 'repository.id': { $in: repositoryIds } }
                    : {}),
            })
            // The plan and the per-unit progress can be large; the list does
            // not show them.
            .select({ units: 0, progress: 0, reported: 0 })
            .sort({ createdAt: -1 })
            .limit(limit)
            .exec();
        return docs.map(toRecord);
    }

    async findActive(
        organizationId: string,
        repository: ScanRepositoryKey,
    ): Promise<SecurityScanRecord | null> {
        const doc = await this.model
            .findOne({
                organizationId,
                ...sameRepository(repository),
                status: { $in: ACTIVE },
            })
            .select({ units: 0, progress: 0, reported: 0 })
            .exec();
        return doc ? toRecord(doc) : null;
    }

    async findLatest(
        organizationId: string,
        repository: ScanRepositoryKey,
    ): Promise<SecurityScanRecord | null> {
        const doc = await this.model
            .findOne({ organizationId, ...sameRepository(repository) })
            .sort({ createdAt: -1 })
            .exec();
        return doc ? toRecord(doc) : null;
    }

    async failStale(
        organizationId: string,
        after: StaleScanWindows,
    ): Promise<number> {
        const silentFor = (ms: number) => ({
            $lt: new Date(Date.now() - ms),
        });
        const result = await this.model.updateMany(
            {
                organizationId,
                $or: [
                    {
                        status: SecurityScanStatus.RUNNING,
                        updatedAt: silentFor(after.runningMs),
                    },
                    {
                        status: SecurityScanStatus.QUEUED,
                        updatedAt: silentFor(after.queuedMs),
                    },
                ],
            },
            {
                $set: {
                    status: SecurityScanStatus.FAILED,
                    error: STALE_SCAN_ERROR,
                    finishedAt: new Date().toISOString(),
                },
                $unset: { activeKey: '' },
            },
        );
        return result.modifiedCount;
    }
}

function toRecord(doc: any): SecurityScanRecord {
    // Read the raw document like the shared mappers do: toObject() runs the
    // app's schema transforms, which drop `_id`.
    const o = doc?._doc ?? doc;
    return {
        uuid: String(o._id ?? doc._id ?? o.uuid),
        organizationId: o.organizationId,
        teamId: o.teamId,
        repository: o.repository,
        status: o.status,
        budget: o.budget ?? {},
        spend: o.spend,
        commitSha: o.commitSha,
        planCommitSha: o.planCommitSha,
        units: o.units ?? [],
        progress: o.progress ?? [],
        reported: o.reported ?? [],
        coverage: o.coverage,
        outcome: o.outcome,
        modelName: o.modelName,
        requestedBy: o.requestedBy,
        error: o.error,
        startedAt: o.startedAt,
        finishedAt: o.finishedAt,
        createdAt:
            o.createdAt instanceof Date
                ? o.createdAt.toISOString()
                : o.createdAt,
        updatedAt:
            o.updatedAt instanceof Date
                ? o.updatedAt.toISOString()
                : o.updatedAt,
    };
}
