import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { SendOrgReportUseCase } from '@libs/cockpit/application/use-cases/send-org-report.use-case';
import { environment } from '@libs/ee/configs/environment';
import type { IOrganizationService } from '@libs/organization/domain/organization/contracts/organization.service.contract';
import { ORGANIZATION_SERVICE_TOKEN } from '@libs/organization/domain/organization/contracts/organization.service.contract';

import { previousCalendarMonthUtc } from './report-windows';

/**
 * Org-level executive report — sent to owners on the 1st of each month for
 * the previous calendar month.
 *
 * Schedule: `0 9 1 * *` (09:00 UTC, 1st of month) by default. Override via
 * `API_CRON_ORG_REPORT`; set to a never-firing expression to disable.
 *
 * Scope: cloud-only, consistent with the other cockpit notifications.
 */
@Injectable()
export class OrgReportCron {
    private readonly logger = new Logger(OrgReportCron.name);
    private running = false;

    constructor(
        private readonly useCase: SendOrgReportUseCase,
        @Inject(ORGANIZATION_SERVICE_TOKEN)
        private readonly organizationService: IOrganizationService,
    ) {}

    @Cron(process.env.API_CRON_ORG_REPORT || '0 9 1 * *', {
        name: 'org-report',
        timeZone: 'UTC',
    })
    async handle(): Promise<void> {
        if (!environment.API_CLOUD_MODE) {
            return;
        }
        if (this.running) {
            this.logger.warn('skipping org report — previous run still in flight');
            return;
        }

        this.running = true;
        const start = Date.now();
        const { startDate, endDate } = previousCalendarMonthUtc();

        try {
            const orgs = await this.organizationService.find({ status: true });
            if (!orgs || orgs.length === 0) {
                this.logger.log('org report: no active orgs to notify');
                return;
            }

            this.logger.log(
                `org report: dispatching for ${orgs.length} orgs, window=${startDate}..${endDate}`,
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
                        `org report failed for org ${org.uuid}: ${
                            err instanceof Error ? err.message : String(err)
                        }`,
                        err instanceof Error ? err.stack : undefined,
                    );
                }
            }

            this.logger.log(
                `org report done in ${Date.now() - start}ms — orgs=${orgs.length}, sent=${totalSent}, failed=${totalFailed}, skipped=${skipped}`,
            );
        } catch (err) {
            this.logger.error(
                `org report top-level failure: ${
                    err instanceof Error ? err.message : String(err)
                }`,
                err instanceof Error ? err.stack : undefined,
            );
        } finally {
            this.running = false;
        }
    }
}
