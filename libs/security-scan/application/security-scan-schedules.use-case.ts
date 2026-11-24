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
    severitiesFrom,
    type ScanCadence,
    type ScanExportTarget,
    type SecurityScanSchedule,
} from '../domain/scan-schedule';
import { SecurityScanStatus } from '../domain/security-scan.types';
import {
    ISecurityScanRepository,
    SECURITY_SCAN_REPOSITORY_TOKEN,
} from '../infrastructure/security-scan.repository';
import {
    IIssuesService,
    ISSUES_SERVICE_TOKEN,
} from '@libs/issues/domain/contracts/issues.service.contract';
import {
    EXPORT_MAX_ISSUES,
    ExportScanIssuesUseCase,
} from './export-scan-issues.use-case';
import type { SecurityScanBudget } from '../domain/security-scan.types';
import {
    ISecurityScanScheduleRepository,
    SECURITY_SCAN_SCHEDULE_REPOSITORY_TOKEN,
} from '../infrastructure/security-scan-schedule.repository';
import { DEEP_SCAN_NOT_ENABLED_MESSAGE, DeepScanGate } from './deep-scan.gate';
import { StartSecurityScanUseCase } from './start-security-scan.use-case';

const logger = createLogger('SecurityScanSchedules');

/** How long one caller holds filing a run's findings. */
const EXPORT_CLAIM_MS = 15 * 60 * 1000;

/** Most scheduled scans one cron run starts; the rest stay due for the next. */
export const MAX_SCHEDULED_STARTS_PER_RUN = 20;

export interface SaveScheduleInput {
    organizationAndTeamData: OrganizationAndTeamData;
    repositoryId: string;
    cadence: ScanCadence;
    budget: SecurityScanBudget;
    mode?: SecurityScanMode;
    modelId?: string;
    /** Where each run's new findings are filed when it ends. */
    exportTo?: ScanExportTarget;
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
        @Inject(SECURITY_SCAN_REPOSITORY_TOKEN)
        private readonly scans: ISecurityScanRepository,
        @Inject(ISSUES_SERVICE_TOKEN)
        private readonly issuesService: IIssuesService,
        private readonly exportScanIssues: ExportScanIssuesUseCase,
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
                exportTo: input.exportTo,
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

    /**
     * Files the new findings of each schedule's last run, once it ended, in
     * the plugin the schedule names: at most EXPORT_MAX_ISSUES per schedule
     * per call, the rest on the next. A run is done exporting when nothing
     * is left, or when an attempt filed nothing (said on the schedule).
     * Returns how many findings were filed.
     */
    async exportFinished(): Promise<number> {
        let filed = 0;
        for (const schedule of await this.schedules.findExporting(50)) {
            const target = schedule.exportTo;
            if (!target || !schedule.lastScanId) continue;
            const scan = await this.scans.findById(schedule.lastScanId);
            if (
                !scan ||
                scan.exportedAt ||
                ![
                    SecurityScanStatus.COMPLETED,
                    SecurityScanStatus.STOPPED_BY_BUDGET,
                ].includes(scan.status)
            ) {
                continue;
            }
            // One caller files a run's findings: another cron run, or
            // another API instance, finds it claimed and moves on.
            if (
                !(await this.scans.claimExport(
                    scan.uuid,
                    new Date(Date.now() + EXPORT_CLAIM_MS),
                ))
            ) {
                continue;
            }
            const done = async (lastError?: string) => {
                await this.scans.update(scan.uuid, {
                    exportedAt: new Date().toISOString(),
                });
                if (lastError) {
                    await this.schedules
                        .recordRun(schedule.uuid, {
                            lastRunAt: schedule.lastRunAt ?? scan.createdAt,
                            lastError,
                        })
                        .catch(() => undefined);
                }
            };
            try {
                const issues = await this.issuesService.findScanIssuesToExport({
                    organizationId: schedule.organizationId,
                    repositoryId: scan.repository.id,
                    since: scan.startedAt ?? scan.createdAt,
                    until: scan.finishedAt ?? new Date().toISOString(),
                    severities: severitiesFrom(target.minSeverity),
                    integrationId: target.integrationId,
                    limit: EXPORT_MAX_ISSUES,
                });
                if (!issues.length) {
                    await done();
                    continue;
                }
                const results = await this.exportScanIssues.execute({
                    organizationAndTeamData: {
                        organizationId: schedule.organizationId,
                        teamId: schedule.teamId,
                    },
                    issueIds: issues.map((i) => i.uuid),
                    integrationId: target.integrationId,
                    destinationNote: target.destinationNote,
                    readableRepositoryIds: null,
                    requestedBy: 'schedule',
                });
                const created = results.filter(
                    (r) => r.status === 'created',
                ).length;
                filed += created;
                if (!created) {
                    await done(
                        results.find((r) => r.error)?.error ??
                            'The findings could not be filed in the plugin.',
                    );
                } else if (issues.length < EXPORT_MAX_ISSUES) {
                    await done();
                }
            } catch (error) {
                await done(
                    error instanceof HttpException
                        ? error.message
                        : 'The findings could not be filed in the plugin.',
                );
                logger.warn({
                    message: 'Scheduled deep scan export failed',
                    context: SecurityScanSchedulesUseCase.name,
                    error,
                    metadata: {
                        organizationId: schedule.organizationId,
                        scheduleId: schedule.uuid,
                        scanId: scan.uuid,
                    },
                });
            }
        }
        return filed;
    }
}
