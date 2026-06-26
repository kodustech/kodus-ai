import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { SendRepoReportUseCase } from '@libs/cockpit/application/use-cases/send-repo-report.use-case';
import { environment } from '@libs/ee/configs/environment';
import type { IOrganizationService } from '@libs/organization/domain/organization/contracts/organization.service.contract';
import { ORGANIZATION_SERVICE_TOKEN } from '@libs/organization/domain/organization/contracts/organization.service.contract';

import { precedingWindowUtc } from './report-windows';

/** Window length (days) for the repo digest — a fortnightly cadence. */
const WINDOW_DAYS = 15;

/**
 * Per-repo digest for repo admins — sent twice a month (1st & 16th),
 * covering the preceding ~15 days.
 *
 * Schedule: `0 9 1,16 * *` (09:00 UTC) by default. Override via
 * `API_CRON_REPO_REPORT`; set to a never-firing expression to disable.
 *
 * Scope: cloud-only, consistent with the other cockpit notifications.
 */
@Injectable()
export class RepoReportCron {
    private readonly logger = new Logger(RepoReportCron.name);
    private running = false;

    constructor(
        private readonly useCase: SendRepoReportUseCase,
        @Inject(ORGANIZATION_SERVICE_TOKEN)
        private readonly organizationService: IOrganizationService,
    ) {}

    @Cron(process.env.API_CRON_REPO_REPORT || '0 9 1,16 * *', {
        name: 'repo-report',
        timeZone: 'UTC',
    })
    async handle(): Promise<void> {
        if (!environment.API_CLOUD_MODE) {
            return;
        }
        if (this.running) {
            this.logger.warn(
                'skipping repo report — previous run still in flight',
            );
            return;
        }

        this.running = true;
        const start = Date.now();
        const { startDate, endDate } = precedingWindowUtc(WINDOW_DAYS);

        try {
            const orgs = await this.organizationService.find({ status: true });
            if (!orgs || orgs.length === 0) {
                this.logger.log('repo report: no active orgs to notify');
                return;
            }

            this.logger.log(
                `repo report: dispatching for ${orgs.length} orgs, window=${startDate}..${endDate}`,
            );

            let totalSent = 0;
            let totalFailed = 0;
            let skipped = 0;

            for (const org of orgs) {
                try {
                    const result = await this.useCase.execute({
                        organizationId: org.uuid,
                        startDate,
                        endDate,
                    });
                    if (result.skipped) {
                        skipped += 1;
                    } else {
                        totalSent += result.sent;
                        totalFailed += result.failed;
                    }
                } catch (err) {
                    totalFailed += 1;
                    this.logger.error(
                        `repo report failed for org ${org.uuid}: ${
                            err instanceof Error ? err.message : String(err)
                        }`,
                        err instanceof Error ? err.stack : undefined,
                    );
                }
            }

            this.logger.log(
                `repo report done in ${Date.now() - start}ms — orgs=${orgs.length}, sent=${totalSent}, failed=${totalFailed}, skipped=${skipped}`,
            );
        } catch (err) {
            this.logger.error(
                `repo report top-level failure: ${
                    err instanceof Error ? err.message : String(err)
                }`,
                err instanceof Error ? err.stack : undefined,
            );
        } finally {
            this.running = false;
        }
    }
}
