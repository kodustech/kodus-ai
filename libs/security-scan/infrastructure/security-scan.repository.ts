import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import {
    ScanReportedFinding,
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
    /**
     * Marks as failed the organization's queued or running scans nothing has
     * touched for `staleAfterMs`: the worker running them stopped. Returns how
     * many.
     */
    failStale(organizationId: string, staleAfterMs: number): Promise<number>;
}

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

    async failStale(
        organizationId: string,
        staleAfterMs: number,
    ): Promise<number> {
        const result = await this.model.updateMany(
            {
                organizationId,
                status: { $in: ACTIVE },
                updatedAt: { $lt: new Date(Date.now() - staleAfterMs) },
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
