/**
 * A repository's deep scan on a clock: daily or weekly, within a spend limit,
 * incremental by default, so each run pays only for what changed since the
 * last. Due schedules are claimed one by one (an instance that moves a
 * schedule's next run first is the one that starts it), so the cron can run
 * on every API instance without starting a scan twice.
 */
import {
    BadRequestException,
    HttpException,
    HttpStatus,
    Inject,
    Injectable,
    NotFoundException,
} from '@nestjs/common';

import { createLogger } from '@libs/core/log/logger';
import type { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';

import type { SecurityScanMode } from '../domain/coverage-ledger';
import {
    nextRunAt,
    SCAN_CADENCES,
    type ScanCadence,
    type SecurityScanSchedule,
} from '../domain/scan-schedule';
import type { SecurityScanBudget } from '../domain/security-scan.types';
import {
    ISecurityScanScheduleRepository,
    SECURITY_SCAN_SCHEDULE_REPOSITORY_TOKEN,
} from '../infrastructure/security-scan-schedule.repository';
import { DEEP_SCAN_NOT_ENABLED_MESSAGE, DeepScanGate } from './deep-scan.gate';
import { StartSecurityScanUseCase } from './start-security-scan.use-case';

const logger = createLogger('SecurityScanSchedules');

export const SCHEDULE_NOT_FOUND_MESSAGE =
    'This repository has no deep scan schedule.';

/** How long a run that found no room waits before trying again. */
const BUSY_RETRY_MS = 30 * 60 * 1000;

/**
 * Why a run found no room, said in our words: a refusal that waiting beats,
 * by its status. The exception's own text is not stored.
 */
export const BUSY_REASONS: ReadonlyMap<number, string> = new Map([
    [
        HttpStatus.TOO_MANY_REQUESTS,
        "The organization's running deep scans are at their limit.",
    ],
    [HttpStatus.CONFLICT, 'This repository is already being scanned.'],
    [
        HttpStatus.SERVICE_UNAVAILABLE,
        'The deep scan workers are not taking scans right now.',
    ],
]);

/** Most scheduled scans one cron run starts; the rest stay due for the next. */
export const MAX_SCHEDULED_STARTS_PER_RUN = 20;

export interface SaveScheduleInput {
    organizationAndTeamData: OrganizationAndTeamData;
    repositoryId: string;
    cadence: ScanCadence;
    budget: SecurityScanBudget;
    mode?: SecurityScanMode;
    modelId?: string;
    /** Omitted: the schedule keeps its state (a new one starts enabled). */
    enabled?: boolean;
    requestedBy?: { userId?: string; email?: string };
}

@Injectable()
export class SecurityScanSchedulesUseCase {
    constructor(
        @Inject(SECURITY_SCAN_SCHEDULE_REPOSITORY_TOKEN)
        private readonly schedules: ISecurityScanScheduleRepository,
        private readonly startSecurityScan: StartSecurityScanUseCase,
        private readonly deepScanGate: DeepScanGate,
    ) {}

    /** The organization's schedules, within the repositories the caller sees. */
    async list(
        organizationId: string,
        visibleRepositoryIds?: string[],
    ): Promise<SecurityScanSchedule[]> {
        const all = await this.schedules.list(organizationId);
        if (!visibleRepositoryIds) return all;
        const visible = new Set(visibleRepositoryIds);
        return all.filter((s) => visible.has(s.repository.id));
    }

    async save(
        input: SaveScheduleInput,
        now = new Date(),
    ): Promise<SecurityScanSchedule> {
        if (!SCAN_CADENCES.includes(input.cadence)) {
            throw new BadRequestException(
                `cadence must be one of ${SCAN_CADENCES.join(', ')}.`,
            );
        }
        // A scheduled scan runs with nobody watching: it needs a limit.
        if (
            input.budget.maxUsd === undefined &&
            input.budget.maxTokens === undefined
        ) {
            throw new BadRequestException(
                'A scheduled scan needs a spend limit: each run stops there.',
            );
        }
        // Refused now, as a run would refuse it: a limit the model cannot be
        // held to, or a picked model that is gone.
        await this.startSecurityScan.scanModelFor(
            input.organizationAndTeamData,
            input.budget,
            input.modelId,
        );
        const repositoryKey = await this.startSecurityScan.repositoryKeyOf(
            input.organizationAndTeamData,
            input.repositoryId,
        );
        // An edit is not a new run: the next run is left untouched while the
        // cadence is the same (not even written, so a time the cron moved in
        // between stays), and a new cadence counts from the last run (a
        // weekly one, a week after it).
        const existing = await this.schedules.find(
            input.organizationAndTeamData.organizationId,
            repositoryKey,
        );
        const next =
            existing && existing.cadence === input.cadence
                ? undefined
                : nextRunAt(
                      input.cadence,
                      now,
                      existing?.lastRunAt
                          ? new Date(existing.lastRunAt)
                          : undefined,
                  ).toISOString();
        return this.schedules.save(
            input.organizationAndTeamData.organizationId,
            repositoryKey,
            {
                teamId: input.organizationAndTeamData.teamId,
                cadence: input.cadence,
                budget: input.budget,
                mode: input.mode ?? 'incremental',
                modelId: input.modelId,
                // Omitted, the stored state stays (editing a paused schedule
                // does not resume it); a new schedule starts enabled.
                enabled: input.enabled,
                nextRunAt: next,
                createdBy: input.requestedBy,
            },
        );
    }

    /**
     * Pauses or resumes a schedule without touching its settings. Resumed, it
     * runs at its next time from now, not at once for the run it missed.
     */
    async setEnabled(
        organizationAndTeamData: OrganizationAndTeamData,
        repositoryId: string,
        enabled: boolean,
        now = new Date(),
    ): Promise<SecurityScanSchedule> {
        const repositoryKey = await this.startSecurityScan.repositoryKeyOf(
            organizationAndTeamData,
            repositoryId,
        );
        const organizationId = organizationAndTeamData.organizationId;
        const current = await this.schedules.find(
            organizationId,
            repositoryKey,
        );
        if (!current) {
            throw new NotFoundException(SCHEDULE_NOT_FOUND_MESSAGE);
        }
        const updated = await this.schedules.setEnabled(
            organizationId,
            repositoryKey,
            enabled,
            enabled ? nextRunAt(current.cadence, now) : undefined,
        );
        if (!updated) {
            throw new NotFoundException(SCHEDULE_NOT_FOUND_MESSAGE);
        }
        return updated;
    }

    async remove(
        organizationAndTeamData: OrganizationAndTeamData,
        repositoryId: string,
    ): Promise<boolean> {
        const repositoryKey = await this.startSecurityScan.repositoryKeyOf(
            organizationAndTeamData,
            repositoryId,
        );
        return this.schedules.remove(
            organizationAndTeamData.organizationId,
            repositoryKey,
        );
    }

    /**
     * Starts the scans due at `now`. Each schedule is claimed first (its next
     * run moved forward): one another instance claimed is skipped, and a
     * start that fails says why on the schedule instead of retrying it every
     * minute. Returns how many scans started.
     */
    async runDue(now = new Date()): Promise<number> {
        const due = await this.schedules.findDue(
            now,
            MAX_SCHEDULED_STARTS_PER_RUN,
        );
        let started = 0;
        for (const schedule of due) {
            // Counted from the run starting now: a weekly one comes back a
            // week later, also after its first run.
            const next = nextRunAt(schedule.cadence, now, now);
            if (
                !(await this.schedules.claim(
                    schedule.uuid,
                    schedule.nextRunAt,
                    next,
                ))
            ) {
                continue;
            }
            const lastRunAt = now.toISOString();
            try {
                if (
                    !(await this.deepScanGate.isEnabledFor(
                        schedule.organizationId,
                    ))
                ) {
                    throw new BadRequestException(
                        DEEP_SCAN_NOT_ENABLED_MESSAGE,
                    );
                }
                const scan = await this.startSecurityScan.execute({
                    organizationAndTeamData: {
                        organizationId: schedule.organizationId,
                        teamId: schedule.teamId,
                    },
                    repositoryId: schedule.repository.id,
                    budget: schedule.budget,
                    mode: schedule.mode,
                    modelId: schedule.modelId,
                    scheduleId: schedule.uuid,
                    requestedBy: { email: 'schedule' },
                });
                await this.schedules.recordRun(schedule.uuid, {
                    lastRunAt,
                    lastScanId: scan.uuid,
                });
                started++;
            } catch (error) {
                // No room now (the organization's share of running scans is
                // taken, this repository is being scanned, or the workers are
                // between deploys): the run waits
                // a little and tries again instead of losing its turn, or the
                // same schedules would lose it every day.
                const busy =
                    error instanceof HttpException
                        ? BUSY_REASONS.get(error.getStatus())
                        : undefined;
                const retryAt = new Date(now.getTime() + BUSY_RETRY_MS);
                if (busy && retryAt < next) {
                    const deferred = await this.schedules
                        .claim(schedule.uuid, next.toISOString(), retryAt)
                        .catch(() => false);
                    if (deferred) {
                        await this.schedules
                            .recordError(
                                schedule.uuid,
                                `${busy} It tries again at ${retryAt.toISOString().slice(11, 16)} UTC.`,
                            )
                            .catch(() => undefined);
                        continue;
                    }
                }
                // Said to the person who set it: a model or a repository no
                // longer there.
                const message =
                    error instanceof HttpException
                        ? error.message
                        : 'The scheduled scan could not start. It runs again at its next time.';
                await this.schedules
                    .recordRun(schedule.uuid, { lastRunAt, lastError: message })
                    .catch(() => undefined);
                logger.warn({
                    message: 'Scheduled deep scan did not start',
                    context: SecurityScanSchedulesUseCase.name,
                    error,
                    metadata: {
                        organizationId: schedule.organizationId,
                        repositoryId: schedule.repository.id,
                        scheduleId: schedule.uuid,
                    },
                });
            }
        }
        return started;
    }
}
