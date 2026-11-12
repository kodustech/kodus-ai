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
    /** `appendReported` is pushed onto `reported` in the same write. */
    update(
        uuid: string,
        changes: Partial<NewSecurityScan>,
        appendReported?: ScanReportedFinding[],
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
    ): Promise<void>;
    findRecent(
        organizationId: string,
        repositoryIds: string[] | undefined,
        limit: number,
    ): Promise<SecurityScanRecord[]>;
    /** A scan of this repository that has not finished yet, if any. */
    findActive(
        organizationId: string,
        repositoryId: string,
    ): Promise<SecurityScanRecord | null>;
    /** The repository's last scan, with its plan, progress and findings. */
    findLatest(
        organizationId: string,
        repositoryId: string,
    ): Promise<SecurityScanRecord | null>;
    /**
     * Marks as failed the organization's scans nothing has touched for their
     * state's window: the worker running them stopped, or the job waiting for
     * one was lost. Returns how many.
     */
    failStale(organizationId: string, after: StaleScanWindows): Promise<number>;
}

export type StaleScanWindows = {
    /** A running scan writes after every unit. */
    runningMs: number;
    /** A queued scan waits for a worker, as long as the queue's backlog. */
    queuedMs: number;
};

const ACTIVE = [SecurityScanStatus.QUEUED, SecurityScanStatus.RUNNING];

const activeKeyOf = (organizationId: string, repositoryId: string) =>
    `${organizationId}:${repositoryId}`;

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
                          scan.repository.id,
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
    ): Promise<SecurityScanRecord | null> {
        const ended = changes.status && !ACTIVE.includes(changes.status);
        const doc = await this.model
            .findByIdAndUpdate(
                uuid,
                {
                    $set: changes,
                    ...(ended ? { $unset: { activeKey: '' } } : {}),
                    ...(appendReported?.length
                        ? { $push: { reported: { $each: appendReported } } }
                        : {}),
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
    ): Promise<void> {
        const reported = appendReported?.length
            ? { reported: { $each: appendReported } }
            : undefined;
        if (progress.state === 'pending') {
            await this.model
                .updateOne(
                    { _id: uuid },
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
                { '_id': uuid, 'progress.unitId': { $ne: progress.unitId } },
                { $set: changes, $push: { progress, ...reported } },
            )
            .exec();
        if (appended.matchedCount) {
            return;
        }
        await this.model
            .updateOne(
                { '_id': uuid, 'progress.unitId': progress.unitId },
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
        repositoryId: string,
    ): Promise<SecurityScanRecord | null> {
        const doc = await this.model
            .findOne({
                organizationId,
                'repository.id': repositoryId,
                'status': { $in: ACTIVE },
            })
            .select({ units: 0, progress: 0, reported: 0 })
            .exec();
        return doc ? toRecord(doc) : null;
    }

    async findLatest(
        organizationId: string,
        repositoryId: string,
    ): Promise<SecurityScanRecord | null> {
        const doc = await this.model
            .findOne({ organizationId, 'repository.id': repositoryId })
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
