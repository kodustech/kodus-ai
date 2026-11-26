import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import type { SecurityScanSchedule } from '../domain/scan-schedule';
import { SecurityScanScheduleModel } from './security-scan-schedule.model';
import type { ScanRepositoryKey } from './security-scan.repository';

export const SECURITY_SCAN_SCHEDULE_REPOSITORY_TOKEN = Symbol.for(
    'SecurityScanScheduleRepository',
);

export type SecurityScanScheduleSettings = Pick<
    SecurityScanSchedule,
    'cadence' | 'budget' | 'mode' | 'modelId' | 'teamId'
> & {
    nextRunAt: string;
    createdBy?: SecurityScanSchedule['createdBy'];
    /** Omitted: an existing schedule keeps its state, a new one is enabled. */
    enabled?: boolean;
};

export interface ISecurityScanScheduleRepository {
    /** The repository's schedule, created or replaced, in one write. */
    save(
        organizationId: string,
        repository: ScanRepositoryKey,
        settings: SecurityScanScheduleSettings,
    ): Promise<SecurityScanSchedule>;
    find(
        organizationId: string,
        repository: ScanRepositoryKey,
    ): Promise<SecurityScanSchedule | null>;
    list(organizationId: string): Promise<SecurityScanSchedule[]>;
    remove(
        organizationId: string,
        repository: ScanRepositoryKey,
    ): Promise<boolean>;
    /**
     * Pauses or resumes the repository's schedule and nothing else, moving
     * its next run when given. Null when it has none.
     */
    setEnabled(
        organizationId: string,
        repository: ScanRepositoryKey,
        enabled: boolean,
        nextRunAt?: Date,
    ): Promise<SecurityScanSchedule | null>;
    /** Enabled schedules due at `now`, oldest first. */
    findDue(now: Date, limit: number): Promise<SecurityScanSchedule[]>;
    /**
     * Moves a due schedule to its next run, only if no other instance did
     * first: true means this caller runs it.
     */
    claim(uuid: string, dueAt: string, nextRunAt: Date): Promise<boolean>;
    recordRun(
        uuid: string,
        run: { lastRunAt: string; lastScanId?: string; lastError?: string },
    ): Promise<void>;
    /** Says why a due run has not started yet, leaving its last run as is. */
    recordError(uuid: string, lastError: string): Promise<void>;
}

const sameRepository = (repository: ScanRepositoryKey) => ({
    'repository.platform': repository.platform,
    'repository.host': repository.host,
    'repository.id': repository.id,
});

@Injectable()
export class SecurityScanScheduleRepository implements ISecurityScanScheduleRepository {
    constructor(
        @InjectModel(SecurityScanScheduleModel.name)
        private readonly model: Model<SecurityScanScheduleModel>,
    ) {}

    async save(
        organizationId: string,
        repository: ScanRepositoryKey,
        settings: SecurityScanScheduleSettings,
    ): Promise<SecurityScanSchedule> {
        const write = () =>
            this.model
                .findOneAndUpdate(
                    { organizationId, ...sameRepository(repository) },
                    {
                        $set: {
                            organizationId,
                            repository: {
                                platform: repository.platform,
                                host: repository.host,
                                id: repository.id,
                            },
                            teamId: settings.teamId,
                            cadence: settings.cadence,
                            budget: settings.budget,
                            mode: settings.mode,
                            ...(typeof settings.enabled === 'boolean'
                                ? { enabled: settings.enabled }
                                : {}),
                            nextRunAt: new Date(settings.nextRunAt),
                            ...(settings.modelId
                                ? { modelId: settings.modelId }
                                : {}),
                            ...(settings.createdBy
                                ? { createdBy: settings.createdBy }
                                : {}),
                        },
                        // Saved without saying (or with no boolean), a
                        // schedule keeps its state; a new one is enabled.
                        ...(typeof settings.enabled === 'boolean'
                            ? {}
                            : { $setOnInsert: { enabled: true } }),
                        // Back to the Deep scan routing when no model is picked.
                        ...(settings.modelId
                            ? {}
                            : { $unset: { modelId: '' } }),
                    },
                    { upsert: true, new: true },
                )
                .lean()
                .exec();
        // Two saves of one repository can both insert: the unique index
        // refuses the second, which then lands as an update of the first.
        const doc = await write().catch((error) => {
            if (error?.code !== 11000) throw error;
            return write();
        });
        return toSchedule(doc);
    }

    async find(
        organizationId: string,
        repository: ScanRepositoryKey,
    ): Promise<SecurityScanSchedule | null> {
        const doc = await this.model
            .findOne({ organizationId, ...sameRepository(repository) })
            .lean()
            .exec();
        return doc ? toSchedule(doc) : null;
    }

    async list(organizationId: string): Promise<SecurityScanSchedule[]> {
        const docs = await this.model.find({ organizationId }).lean().exec();
        return docs.map(toSchedule);
    }

    async remove(
        organizationId: string,
        repository: ScanRepositoryKey,
    ): Promise<boolean> {
        const result = await this.model.deleteOne({
            organizationId,
            ...sameRepository(repository),
        });
        return result.deletedCount > 0;
    }

    async setEnabled(
        organizationId: string,
        repository: ScanRepositoryKey,
        enabled: boolean,
        nextRunAt?: Date,
    ): Promise<SecurityScanSchedule | null> {
        const doc = await this.model
            .findOneAndUpdate(
                { organizationId, ...sameRepository(repository) },
                { $set: { enabled, ...(nextRunAt ? { nextRunAt } : {}) } },
                { new: true },
            )
            .lean()
            .exec();
        return doc ? toSchedule(doc) : null;
    }

    async findDue(now: Date, limit: number): Promise<SecurityScanSchedule[]> {
        const docs = await this.model
            .find({ enabled: true, nextRunAt: { $lte: now } })
            .sort({ nextRunAt: 1 })
            .limit(limit)
            .lean()
            .exec();
        return docs.map(toSchedule);
    }

    async claim(
        uuid: string,
        dueAt: string,
        nextRunAt: Date,
    ): Promise<boolean> {
        const result = await this.model.updateOne(
            { _id: uuid, enabled: true, nextRunAt: new Date(dueAt) },
            { $set: { nextRunAt } },
        );
        return (result?.modifiedCount ?? 0) > 0;
    }

    async recordError(uuid: string, lastError: string): Promise<void> {
        await this.model.updateOne({ _id: uuid }, { $set: { lastError } });
    }

    async recordRun(
        uuid: string,
        run: { lastRunAt: string; lastScanId?: string; lastError?: string },
    ): Promise<void> {
        await this.model.updateOne(
            { _id: uuid },
            run.lastError
                ? {
                      $set: {
                          lastRunAt: run.lastRunAt,
                          lastError: run.lastError,
                      },
                  }
                : {
                      $set: {
                          lastRunAt: run.lastRunAt,
                          lastScanId: run.lastScanId,
                      },
                      $unset: { lastError: '' },
                  },
        );
    }
}

function toSchedule(doc: any): SecurityScanSchedule {
    const iso = (d: unknown) =>
        d instanceof Date ? d.toISOString() : (d as string | undefined);
    return {
        uuid: String(doc._id ?? doc.uuid),
        organizationId: doc.organizationId,
        teamId: doc.teamId,
        repository: doc.repository,
        cadence: doc.cadence,
        budget: doc.budget ?? {},
        mode: doc.mode ?? 'incremental',
        ...(doc.modelId ? { modelId: doc.modelId } : {}),
        enabled: doc.enabled !== false,
        nextRunAt: iso(doc.nextRunAt)!,
        ...(doc.lastRunAt ? { lastRunAt: doc.lastRunAt } : {}),
        ...(doc.lastScanId ? { lastScanId: doc.lastScanId } : {}),
        ...(doc.lastError ? { lastError: doc.lastError } : {}),
        ...(doc.createdBy ? { createdBy: doc.createdBy } : {}),
    };
}
