import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { Inject } from '@nestjs/common';

import { SendWeeklyRecapUseCase } from '@libs/cockpit/application/use-cases/send-weekly-recap.use-case';
import { environment } from '@libs/ee/configs/environment';
import { ORGANIZATION_SERVICE_TOKEN } from '@libs/organization/domain/organization/contracts/organization.service.contract';
import type { IOrganizationService } from '@libs/organization/domain/organization/contracts/organization.service.contract';

/**
 * Weekly recap email — replaces the legacy n8n flow that called Customer.io.
 *
 * Schedule: Friday 09:00 UTC by default. Override via `API_CRON_WEEKLY_RECAP`
 * (standard cron expression) — set to a never-firing expression to disable.
 *
 * Window: previous Monday → previous Sunday (last full ISO week). Friday
 * publishing of "last week's recap" gives complete data and avoids the
 * partial-week ambiguity of "this week so far".
 *
 * Scope: cloud-only. Self-hosted has only one organization in the warehouse,
 * so the ranking section would always render `#1 of 1` — the use-case
 * already suppresses that, but skipping the email entirely on self-hosted
 * is cleaner.
 */
@Injectable()
export class WeeklyRecapCron {
    private readonly logger = new Logger(WeeklyRecapCron.name);
    private running = false;

    constructor(
        private readonly useCase: SendWeeklyRecapUseCase,
        @Inject(ORGANIZATION_SERVICE_TOKEN)
        private readonly organizationService: IOrganizationService,
    ) {}

    @Cron(process.env.API_CRON_WEEKLY_RECAP || '0 9 * * 5', {
        name: 'weekly-recap',
        timeZone: 'UTC',
    })
    async handle(): Promise<void> {
        if (!environment.API_CLOUD_MODE) {
            // Self-hosted: warehouse has a single org, so ranking is moot
            // and the email loses its weekly-network framing. Skip.
            return;
        }
        if (this.running) {
            this.logger.warn('skipping weekly recap — previous run still in flight');
            return;
        }

        this.running = true;
        const start = Date.now();
        const { startDate, endDate } = previousIsoWeekUtc();

        try {
            const orgs = await this.organizationService.find({ status: true });
            if (!orgs || orgs.length === 0) {
                this.logger.log('weekly recap: no active orgs to notify');
                return;
            }

            this.logger.log(
                `weekly recap: dispatching for ${orgs.length} orgs, window=${startDate}..${endDate}`,
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
                        `weekly recap failed for org ${org.uuid}: ${
                            err instanceof Error ? err.message : String(err)
                        }`,
                        err instanceof Error ? err.stack : undefined,
                    );
                }
            }

            this.logger.log(
                `weekly recap done in ${Date.now() - start}ms — orgs=${orgs.length}, sent=${totalSent}, failed=${totalFailed}, skipped=${skipped}`,
            );
        } catch (err) {
            this.logger.error(
                `weekly recap top-level failure: ${
                    err instanceof Error ? err.message : String(err)
                }`,
                err instanceof Error ? err.stack : undefined,
            );
        } finally {
            this.running = false;
        }
    }
}

/**
 * Returns the previous ISO week (Monday → Sunday) in UTC as YYYY-MM-DD strings.
 * On a Friday (the cron's natural fire day) this gives last week's Mon–Sun.
 */
function previousIsoWeekUtc(): { startDate: string; endDate: string } {
    const now = new Date();
    const dow = now.getUTCDay(); // 0 = Sunday
    const daysSinceLastSunday = dow === 0 ? 7 : dow;
    const lastSunday = new Date(now);
    lastSunday.setUTCDate(now.getUTCDate() - daysSinceLastSunday);
    const lastMonday = new Date(lastSunday);
    lastMonday.setUTCDate(lastSunday.getUTCDate() - 6);
    return {
        startDate: lastMonday.toISOString().slice(0, 10),
        endDate: lastSunday.toISOString().slice(0, 10),
    };
}
