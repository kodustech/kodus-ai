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
    Inject,
    Injectable,
} from '@nestjs/common';

import { createLogger } from '@libs/core/log/logger';
import type { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';

import { validateBudget } from '../domain/budget-meter';
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

/** Most scheduled scans one cron run starts; the rest stay due for the next. */
export const MAX_SCHEDULED_STARTS_PER_RUN = 20;

export interface SaveScheduleInput {
    organizationAndTeamData: OrganizationAndTeamData;
    repositoryId: string;
    cadence: ScanCadence;
    budget: SecurityScanBudget;
    mode?: SecurityScanMode;
    modelId?: string;
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
        return visibleRepositoryIds
            ? all.filter((s) => visibleRepositoryIds.includes(s.repository.id))
            : all;
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
        const budgetError = validateBudget(input.budget, true);
        if (budgetError) {
            throw new BadRequestException(budgetError);
        }
        const repositoryKey = await this.startSecurityScan.repositoryKeyOf(
            input.organizationAndTeamData,
            input.repositoryId,
        );
        return this.schedules.save(
            input.organizationAndTeamData.organizationId,
            repositoryKey,
            {
                teamId: input.organizationAndTeamData.teamId,
                cadence: input.cadence,
                budget: input.budget,
                mode: input.mode ?? 'incremental',
                modelId: input.modelId,
                enabled: input.enabled !== false,
                nextRunAt: nextRunAt(input.cadence, now).toISOString(),
                createdBy: input.requestedBy,
            },
        );
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
            const next = nextRunAt(
                schedule.cadence,
                now,
                schedule.lastRunAt ? new Date(schedule.lastRunAt) : undefined,
            );
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
                // Said to the person who set it: a running scan, a model or
                // a repository no longer there.
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
